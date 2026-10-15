//! Linux (and the BSDs): MPRIS over the D-Bus session bus. Spotify's desktop
//! client registers `org.mpris.MediaPlayer2.spotify`. The D-Bus values are
//! converted to plain types here; `crate::mpris` does the (tested) mapping.

use std::collections::HashMap;
use std::sync::Mutex;

use zbus::blocking::fdo::DBusProxy;
use zbus::blocking::{proxy, Connection, MessageIterator, Proxy};
use zbus::names::BusName;
use zbus::proxy::CacheProperties;
use zbus::zvariant::{ObjectPath, OwnedValue, Value};
use zbus::MatchRule;

use crate::models::{NowPlayingResponse, PlaybackCapabilities};
use crate::mpris::{self, MetaValue, Metadata, MprisCall, PlayerState};
use crate::{Error, Result};

pub const CAPABILITIES: PlaybackCapabilities =
    PlaybackCapabilities { transport: true, seek: true, volume: true, events: false };

const BUS_NAME: &str = "org.mpris.MediaPlayer2.spotify";
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

fn bus_name() -> BusName<'static> {
    BusName::try_from(BUS_NAME).expect("valid bus name")
}

/// Spotify's player proxy, or None when Spotify isn't running.
fn player(conn: &Connection) -> Result<Option<Proxy<'static>>> {
    if !DBusProxy::new(conn).map_err(derr)?.name_has_owner(bus_name()).map_err(derr)? {
        return Ok(None);
    }
    // No property cache: each read wants fresh values, and a cache would add a
    // signal subscription for every short-lived proxy.
    let p = proxy::Builder::new(conn)
        .destination(BUS_NAME)
        .map_err(derr)?
        .path(OBJECT_PATH)
        .map_err(derr)?
        .interface(PLAYER_IFACE)
        .map_err(derr)?
        .cache_properties(CacheProperties::No)
        .build()
        .map_err(derr)?;
    Ok(Some(p))
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
        // Optional: some Spotify builds don't implement them.
        position_us: p.get_property("Position").ok(),
        volume: p.get_property("Volume").ok(),
    })
}

pub fn read() -> Result<NowPlayingResponse> {
    let conn = connection()?;
    let Some(p) = player(&conn)? else {
        return Ok(NowPlayingResponse { track: None });
    };
    Ok(NowPlayingResponse { track: mpris::track_from_state(&read_state(&p)?) })
}

pub fn control(action: &str, value: Option<f64>) -> Result<()> {
    let conn = connection()?;
    let Some(p) = player(&conn)? else {
        return Err(Error::Detector("Spotify is not running".into()));
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

/// Calls `on_change` whenever Spotify's player properties change (track,
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
                // Every MPRIS player uses the same path; only Spotify's signals count.
                // Its unique name changes when it restarts, so look it up each time.
                let header = msg.header();
                let Some(sender) = header.sender() else { continue };
                let is_spotify =
                    dbus.get_name_owner(bus_name()).map(|owner| owner.as_str() == sender.as_str()).unwrap_or(false);
                if is_spotify {
                    on_change();
                }
            }
        })
        .is_ok()
}
