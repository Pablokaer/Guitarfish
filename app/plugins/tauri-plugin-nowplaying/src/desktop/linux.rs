//! Linux (and the BSDs): MPRIS over the D-Bus session bus. Every player registers
//! `org.mpris.MediaPlayer2.<name>`: Spotify's desktop client `spotify`, browsers
//! (YouTube in a tab) `chromium.instance…`, `firefox.instance…` and so on.
//! `crate::sources` says which ones count and which one wins; the D-Bus values
//! are converted to plain types here and `crate::mpris` does the (tested) mapping.

use std::collections::HashMap;
use std::sync::Mutex;

use zbus::blocking::fdo::DBusProxy;
use zbus::blocking::{proxy, Connection, MessageIterator, Proxy};
use zbus::names::BusName;
use zbus::proxy::CacheProperties;
use zbus::zvariant::{ObjectPath, OwnedValue, Value};
use zbus::MatchRule;

use crate::models::{NowPlayingResponse, PlaybackCapabilities, Track};
use crate::mpris::{self, MetaValue, Metadata, MprisCall, PlayerState};
use crate::sources::{self, Service, Source};
use crate::{Error, Result};

pub const CAPABILITIES: PlaybackCapabilities =
    PlaybackCapabilities { transport: true, seek: true, volume: true, events: false };
/// Every MPRIS player signals its changes, so the app may poll less often.
pub const EVENTS_REPLACE_POLLING: bool = true;

const OBJECT_PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";

fn derr(e: impl std::fmt::Display) -> Error {
    Error::Detector(format!("MPRIS: {e}"))
}

/// The session bus connection, opened on first use and then shared (opening
/// one per read would redo the D-Bus handshake every second).
fn connection() -> Result<Connection> {
    static CONN: Mutex<Option<Connection>> = Mutex::new(None);
    let mut conn = CONN.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(c) = conn.as_ref() {
        return Ok(c.clone());
    }
    let c = Connection::session().map_err(derr)?;
    *conn = Some(c.clone());
    Ok(c)
}

/// The followed players on the bus (see `sources::mpris_source`), with their bus names.
fn players(conn: &Connection) -> Result<Vec<(String, Source)>> {
    let names = DBusProxy::new(conn).map_err(derr)?.list_names().map_err(derr)?;
    Ok(names.into_iter().filter_map(|n| sources::mpris_source(n.as_str()).map(|s| (n.to_string(), s))).collect())
}

/// A player's proxy. No property cache: each read wants fresh values, and a
/// cache would add a signal subscription for every short-lived proxy.
fn player(conn: &Connection, bus_name: &str) -> Result<Proxy<'static>> {
    proxy::Builder::new(conn)
        .destination(bus_name.to_owned())
        .map_err(derr)?
        .path(OBJECT_PATH)
        .map_err(derr)?
        .interface(PLAYER_IFACE)
        .map_err(derr)?
        .cache_properties(CacheProperties::No)
        .build()
        .map_err(derr)
}

fn meta_value(v: &Value<'_>) -> Option<MetaValue> {
    Some(match v {
        Value::Str(s) => MetaValue::Str(s.to_string()),
        Value::ObjectPath(p) => MetaValue::Str(p.to_string()),
        Value::I64(n) => MetaValue::Int(*n),
        Value::U64(n) => MetaValue::Int(i64::try_from(*n).ok()?),
        Value::I32(n) => MetaValue::Int(i64::from(*n)),
        Value::U32(n) => MetaValue::Int(i64::from(*n)),
        Value::F64(f) => MetaValue::Float(*f),
        Value::Array(a) => MetaValue::StrList(
            a.iter()
                .filter_map(|item| match item {
                    Value::Str(s) => Some(s.to_string()),
                    _ => None,
                })
                .collect(),
        ),
        // Metadata values arrive as variants.
        Value::Value(inner) => return meta_value(inner),
        _ => return None,
    })
}

fn read_metadata(p: &Proxy<'_>) -> Result<Metadata> {
    let raw: HashMap<String, OwnedValue> = p.get_property("Metadata").map_err(derr)?;
    Ok(raw.iter().filter_map(|(k, v)| Some((k.clone(), meta_value(v)?))).collect())
}

fn read_state(p: &Proxy<'_>) -> Result<PlayerState> {
    Ok(PlayerState {
        metadata: read_metadata(p)?,
        status: p.get_property("PlaybackStatus").map_err(derr)?,
        // Optional: some players (and Spotify builds) don't implement them.
        position_us: p.get_property("Position").ok(),
        volume: p.get_property("Volume").ok(),
    })
}

/// The player to report, its proxy and its track: see `sources::pick`. A player
/// that fails to answer is skipped, the others still count.
fn current(conn: &Connection) -> Result<Option<(Proxy<'static>, Track)>> {
    let mut found: Vec<(Proxy<'static>, Track)> = Vec::new();
    for (name, source) in players(conn)? {
        let Ok(p) = player(conn, &name) else { continue };
        let Ok(state) = read_state(&p) else { continue };
        if let Some(track) = mpris::track_from_state(&state, source) {
            found.push((p, track));
        }
    }
    let service = |t: &Track| match t.service.as_deref() {
        Some("youtube") => Service::Youtube,
        Some("youtube-music") => Service::YoutubeMusic,
        Some("spotify") => Service::Spotify,
        _ => Service::Browser,
    };
    Ok(sources::pick(&found, |(_, t)| (service(t), Some(t.is_playing))).map(|i| found.swap_remove(i)))
}

pub fn read() -> Result<NowPlayingResponse> {
    let conn = connection()?;
    Ok(NowPlayingResponse { track: current(&conn)?.map(|(_, t)| t) })
}

pub fn control(action: &str, value: Option<f64>) -> Result<()> {
    let conn = connection()?;
    let Some((p, _)) = current(&conn)? else {
        return Err(Error::Detector("Nothing is playing".into()));
    };
    // Seeking needs the current track ID (and, for a relative seek, the position).
    let (track_id, position_us) = if action == "seek" {
        let meta = read_metadata(&p)?;
        let id = match meta.get("mpris:trackid") {
            Some(MetaValue::Str(id)) => Some(id.clone()),
            _ => None,
        };
        (id, p.get_property::<i64>("Position").ok())
    } else {
        (None, None)
    };
    let call = mpris::control_call(action, value, track_id.as_deref(), position_us)
        .ok_or_else(|| super::unsupported(action))?;
    match call {
        MprisCall::PlayPause => p.call_method("PlayPause", &()).map(drop),
        MprisCall::Next => p.call_method("Next", &()).map(drop),
        MprisCall::Previous => p.call_method("Previous", &()).map(drop),
        MprisCall::SetPosition { track_id, position_us } => {
            let path = ObjectPath::try_from(track_id.as_str()).map_err(derr)?;
            p.call_method("SetPosition", &(path, position_us)).map(drop)
        }
        MprisCall::Seek { offset_us } => p.call_method("Seek", &(offset_us,)).map(drop),
        MprisCall::SetVolume(v) => return p.set_property("Volume", v).map_err(derr),
    }
    .map_err(derr)
}

/// Calls `on_change` whenever a followed player's properties change (track,
/// play state, position jumps). Returns false when the session bus or the
/// signal subscription is unavailable.
pub fn watch(on_change: impl Fn() + Send + 'static) -> bool {
    let Ok(conn) = connection() else { return false };
    let rule = MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface("org.freedesktop.DBus.Properties")
        .and_then(|b| b.member("PropertiesChanged"))
        .and_then(|b| b.path(OBJECT_PATH))
        .and_then(|b| b.arg(0, PLAYER_IFACE))
        .map(|b| b.build());
    let Ok(rule) = rule else { return false };
    let Ok(messages) = MessageIterator::for_match_rule(rule, &conn, Some(64)) else { return false };
    let Ok(dbus) = DBusProxy::new(&conn) else { return false };
    std::thread::Builder::new()
        .name("nowplaying-mpris".into())
        .spawn(move || {
            for msg in messages.flatten() {
                // Every MPRIS player uses the same path; only the followed ones count.
                // Signals come from unique names (":1.42"), so find whose they are.
                let header = msg.header();
                let Some(sender) = header.sender() else { continue };
                let followed = dbus.list_names().map(|names| {
                    names.iter().any(|n| {
                        sources::mpris_source(n.as_str()).is_some()
                            && BusName::try_from(n.as_str())
                                .ok()
                                .and_then(|b| dbus.get_name_owner(b).ok())
                                .is_some_and(|owner| owner.as_str() == sender.as_str())
                    })
                });
                if followed.unwrap_or(false) {
                    on_change();
                }
            }
        })
        .is_ok()
}
