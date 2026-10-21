//! MPRIS (Linux) logic that doesn't touch D-Bus: a player's `Metadata` map to a
//! [`Track`], and a control action to the MPRIS call that performs it. It has no
//! D-Bus types, so its tests run on every OS; `desktop/linux.rs` converts the
//! D-Bus values into [`MetaValue`]s and sends the calls.

use std::collections::HashMap;

use crate::models::{spotify_track_id, Track};
use crate::sources::{Service, Source};

/// The MPRIS metadata value types Spotify uses, without the D-Bus wrapper.
#[derive(Debug, Clone, PartialEq)]
pub enum MetaValue {
    /// Strings and object paths (`mpris:trackid` is an object path in newer Spotify builds).
    Str(String),
    /// String arrays, e.g. `xesam:artist`.
    StrList(Vec<String>),
    /// Any integer, e.g. `mpris:length` (µs; Spotify sends it unsigned, the spec says signed).
    Int(i64),
    Float(f64),
}

/// The `Metadata` property of `org.mpris.MediaPlayer2.Player`.
pub type Metadata = HashMap<String, MetaValue>;

/// The player properties a read needs.
#[derive(Debug, Clone, Default)]
pub struct PlayerState {
    pub metadata: Metadata,
    /// `PlaybackStatus`: "Playing", "Paused" or "Stopped".
    pub status: String,
    /// `Position`, in µs.
    pub position_us: Option<i64>,
    /// `Volume`, 0.0–1.0.
    pub volume: Option<f64>,
}

/// One MPRIS call on `org.mpris.MediaPlayer2.Player`.
#[derive(Debug, Clone, PartialEq)]
pub enum MprisCall {
    PlayPause,
    Next,
    Previous,
    /// `SetPosition(o TrackId, x Position)`; the position is absolute, in µs.
    SetPosition {
        track_id: String,
        position_us: i64,
    },
    /// `Seek(x Offset)`, relative, in µs.
    Seek {
        offset_us: i64,
    },
    /// Set the `Volume` property (0.0–1.0).
    SetVolume(f64),
}

/// The bare Spotify track ID from an MPRIS `mpris:trackid`. Spotify used
/// `spotify:track:<id>` (a string) and now uses `/com/spotify/track/<id>`
/// (an object path). None for ads, episodes and anything else.
pub fn spotify_id_from_trackid(trackid: &str) -> Option<String> {
    trackid
        .strip_prefix("/com/spotify/track/")
        .filter(|id| !id.is_empty() && !id.contains('/'))
        .map(str::to_string)
        .or_else(|| spotify_track_id(trackid))
}

fn is_ad(trackid: &str) -> bool {
    trackid.starts_with("spotify:ad:") || trackid.starts_with("/com/spotify/ad/")
}

fn str_of<'a>(meta: &'a Metadata, key: &str) -> Option<&'a str> {
    match meta.get(key)? {
        MetaValue::Str(s) => Some(s),
        _ => None,
    }
}

fn int_of(meta: &Metadata, key: &str) -> Option<i64> {
    match meta.get(key)? {
        MetaValue::Int(n) => Some(*n),
        _ => None,
    }
}

/// Maps a player's MPRIS state to a [`Track`]. None when stopped, during Spotify
/// ads, or when there is no title. A browser's `xesam:url` (when it sends one)
/// tells a YouTube tab from other media.
pub fn track_from_state(state: &PlayerState, source: Source) -> Option<Track> {
    let meta = &state.metadata;
    if state.status == "Stopped" {
        return None;
    }
    let source = source.with_url(str_of(meta, "xesam:url"));
    let spotify = source.service == Service::Spotify;
    let trackid = str_of(meta, "mpris:trackid").unwrap_or("");
    if spotify && is_ad(trackid) {
        return None;
    }
    let title = str_of(meta, "xesam:title").filter(|t| !t.is_empty())?;
    let artist = match meta.get("xesam:artist") {
        Some(MetaValue::StrList(list)) => {
            list.iter().map(|a| a.trim()).filter(|a| !a.is_empty()).collect::<Vec<_>>().join(", ")
        }
        Some(MetaValue::Str(a)) => a.trim().to_string(),
        _ => String::new(),
    };
    let duration_ms = int_of(meta, "mpris:length").filter(|&us| us > 0).map(|us| us as u64 / 1000);
    let position_ms = state.position_us.map(|us| {
        let ms = us.max(0) as u64 / 1000;
        duration_ms.map_or(ms, |d| ms.min(d))
    });
    let artwork_url = str_of(meta, "mpris:artUrl")
        .map(|u| u.replacen("https://open.spotify.com/image/", "https://i.scdn.co/image/", 1))
        .filter(|u| u.starts_with("https://") || u.starts_with("http://"));

    Some(Track {
        title: title.to_string(),
        artist,
        album: str_of(meta, "xesam:album").filter(|a| !a.is_empty()).map(str::to_string),
        duration_ms,
        position_ms,
        is_playing: state.status == "Playing",
        spotify_id: if spotify { spotify_id_from_trackid(trackid) } else { None },
        volume: state.volume.map(|v| (v * 100.0).round().clamp(0.0, 100.0) as u8),
        artwork_url,
        source: "os".into(),
        player: source.player("Linux"),
        service: Some(source.service.as_str().into()),
    })
}

/// The MPRIS call for a `control` action (see `commands::control`). `track_id`
/// and `position_us` are the current `mpris:trackid` and `Position`: seeking
/// uses `SetPosition` when the track ID is an object path, otherwise a relative
/// `Seek` from the current position. None for unknown actions or missing values.
pub fn control_call(
    action: &str,
    value: Option<f64>,
    track_id: Option<&str>,
    position_us: Option<i64>,
) -> Option<MprisCall> {
    Some(match action {
        "playpause" => MprisCall::PlayPause,
        "next" => MprisCall::Next,
        "previous" => MprisCall::Previous,
        "seek" => {
            let target_us = (value?.max(0.0) * 1000.0).round() as i64;
            match track_id? {
                id if id.starts_with('/') => {
                    MprisCall::SetPosition { track_id: id.to_string(), position_us: target_us }
                }
                _ => MprisCall::Seek { offset_us: target_us - position_us? },
            }
        }
        "volume" => MprisCall::SetVolume(value?.clamp(0.0, 100.0) / 100.0),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPOTIFY: Source = Source::new(Service::Spotify, "Spotify");
    const CHROMIUM: Source = Source::new(Service::Browser, "Chromium");

    fn s(v: &str) -> MetaValue {
        MetaValue::Str(v.into())
    }

    fn spotify_state() -> PlayerState {
        let metadata: Metadata = [
            ("mpris:trackid", s("/com/spotify/track/4uLU6hMCjMI75M1A2tKUQC")),
            ("xesam:title", s("Never Gonna Give You Up")),
            ("xesam:artist", MetaValue::StrList(vec!["Rick Astley".into()])),
            ("xesam:album", s("Whenever You Need Somebody")),
            ("mpris:length", MetaValue::Int(213_573_000)),
            ("mpris:artUrl", s("https://i.scdn.co/image/ab67616d0000b273")),
            ("xesam:trackNumber", MetaValue::Int(1)),
            ("xesam:autoRating", MetaValue::Float(0.8)),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        PlayerState { metadata, status: "Playing".into(), position_us: Some(61_500_000), volume: Some(0.64) }
    }

    #[test]
    fn trackid_object_path() {
        assert_eq!(
            spotify_id_from_trackid("/com/spotify/track/4uLU6hMCjMI75M1A2tKUQC").as_deref(),
            Some("4uLU6hMCjMI75M1A2tKUQC")
        );
    }

    #[test]
    fn trackid_uri() {
        assert_eq!(spotify_id_from_trackid("spotify:track:abc").as_deref(), Some("abc"));
    }

    #[test]
    fn trackid_rejects_other_kinds() {
        for id in [
            "/com/spotify/ad/123",
            "spotify:ad:123",
            "/com/spotify/episode/xyz",
            "spotify:episode:xyz",
            "/com/spotify/track/",
            "spotify:track:",
            "/org/mpris/MediaPlayer2/TrackList/NoTrack",
            "",
        ] {
            assert_eq!(spotify_id_from_trackid(id), None, "{id}");
        }
    }

    #[test]
    fn maps_spotify_metadata() {
        let t = track_from_state(&spotify_state(), SPOTIFY).unwrap();
        assert_eq!(t.title, "Never Gonna Give You Up");
        assert_eq!(t.artist, "Rick Astley");
        assert_eq!(t.album.as_deref(), Some("Whenever You Need Somebody"));
        assert_eq!(t.duration_ms, Some(213_573));
        assert_eq!(t.position_ms, Some(61_500));
        assert!(t.is_playing);
        assert_eq!(t.spotify_id.as_deref(), Some("4uLU6hMCjMI75M1A2tKUQC"));
        assert_eq!(t.volume, Some(64));
        assert_eq!(t.artwork_url.as_deref(), Some("https://i.scdn.co/image/ab67616d0000b273"));
        assert_eq!(t.source, "os");
        assert_eq!(t.player, "Spotify (Linux)");
        assert_eq!(t.service.as_deref(), Some("spotify"));
    }

    fn browser_state(url: Option<&str>) -> PlayerState {
        let mut metadata: Metadata = [
            ("mpris:trackid", s("/org/chromium/MediaPlayer2/TrackList/Track1")),
            ("xesam:title", s("Oasis - Wonderwall (Official Video)")),
            ("xesam:artist", MetaValue::StrList(vec!["OasisVEVO".into()])),
            ("mpris:length", MetaValue::Int(258_000_000)),
            ("mpris:artUrl", s("file:///tmp/.org.chromium.Chromium.abc")),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        if let Some(u) = url {
            metadata.insert("xesam:url".into(), s(u));
        }
        PlayerState { metadata, status: "Playing".into(), position_us: Some(1_000_000), volume: Some(1.0) }
    }

    #[test]
    fn maps_a_browser_tab() {
        let t = track_from_state(&browser_state(None), CHROMIUM).unwrap();
        assert_eq!(t.title, "Oasis - Wonderwall (Official Video)");
        assert_eq!(t.artist, "OasisVEVO");
        assert_eq!(t.player, "Chromium (Linux)");
        assert_eq!(t.service.as_deref(), Some("browser"));
        assert_eq!(t.spotify_id, None);
        // Chromium's artwork is a local file, which the webview can't show.
        assert_eq!(t.artwork_url, None);
    }

    #[test]
    fn a_youtube_url_marks_the_tab_as_youtube() {
        let t = track_from_state(&browser_state(Some("https://www.youtube.com/watch?v=abc")), CHROMIUM).unwrap();
        assert_eq!(t.service.as_deref(), Some("youtube"));
        assert_eq!(t.player, "YouTube (Chromium, Linux)");
    }

    #[test]
    fn only_spotify_has_ads_and_spotify_ids() {
        let mut st = browser_state(None);
        st.metadata.insert("mpris:trackid".into(), s("spotify:ad:1"));
        assert!(track_from_state(&st, CHROMIUM).is_some());
        st.metadata.insert("mpris:trackid".into(), s("/com/spotify/track/abc"));
        assert_eq!(track_from_state(&st, CHROMIUM).unwrap().spotify_id, None);
    }

    #[test]
    fn joins_several_artists() {
        let mut st = spotify_state();
        st.metadata
            .insert("xesam:artist".into(), MetaValue::StrList(vec!["Daft Punk".into(), "Pharrell Williams".into()]));
        assert_eq!(track_from_state(&st, SPOTIFY).unwrap().artist, "Daft Punk, Pharrell Williams");
    }

    #[test]
    fn accepts_a_plain_string_artist() {
        let mut st = spotify_state();
        st.metadata.insert("xesam:artist".into(), s("Rick Astley"));
        assert_eq!(track_from_state(&st, SPOTIFY).unwrap().artist, "Rick Astley");
    }

    #[test]
    fn paused_is_not_playing() {
        let mut st = spotify_state();
        st.status = "Paused".into();
        assert!(!track_from_state(&st, SPOTIFY).unwrap().is_playing);
    }

    #[test]
    fn stopped_reports_nothing() {
        let mut st = spotify_state();
        st.status = "Stopped".into();
        assert!(track_from_state(&st, SPOTIFY).is_none());
    }

    #[test]
    fn ads_report_nothing() {
        let mut st = spotify_state();
        st.metadata.insert("mpris:trackid".into(), s("/com/spotify/ad/123"));
        assert!(track_from_state(&st, SPOTIFY).is_none());
        st.metadata.insert("mpris:trackid".into(), s("spotify:ad:123"));
        assert!(track_from_state(&st, SPOTIFY).is_none());
    }

    #[test]
    fn missing_title_reports_nothing() {
        let mut st = spotify_state();
        st.metadata.insert("xesam:title".into(), s(""));
        assert!(track_from_state(&st, SPOTIFY).is_none());
        st.metadata.remove("xesam:title");
        assert!(track_from_state(&st, SPOTIFY).is_none());
    }

    #[test]
    fn episodes_have_no_spotify_id() {
        let mut st = spotify_state();
        st.metadata.insert("mpris:trackid".into(), s("/com/spotify/episode/xyz"));
        let t = track_from_state(&st, SPOTIFY).unwrap();
        assert_eq!(t.spotify_id, None);
    }

    #[test]
    fn missing_optional_fields() {
        let mut st = spotify_state();
        for k in ["xesam:album", "mpris:length", "mpris:artUrl", "xesam:artist"] {
            st.metadata.remove(k);
        }
        st.position_us = None;
        st.volume = None;
        let t = track_from_state(&st, SPOTIFY).unwrap();
        assert_eq!(t.artist, "");
        assert_eq!(t.album, None);
        assert_eq!(t.duration_ms, None);
        assert_eq!(t.position_ms, None);
        assert_eq!(t.volume, None);
        assert_eq!(t.artwork_url, None);
    }

    #[test]
    fn clamps_position_and_volume() {
        let mut st = spotify_state();
        st.position_us = Some(999_000_000_000);
        st.volume = Some(1.7);
        let t = track_from_state(&st, SPOTIFY).unwrap();
        assert_eq!(t.position_ms, Some(213_573));
        assert_eq!(t.volume, Some(100));

        st.position_us = Some(-5);
        st.volume = Some(-0.2);
        let t = track_from_state(&st, SPOTIFY).unwrap();
        assert_eq!(t.position_ms, Some(0));
        assert_eq!(t.volume, Some(0));
    }

    #[test]
    fn zero_length_is_unknown() {
        let mut st = spotify_state();
        st.metadata.insert("mpris:length".into(), MetaValue::Int(0));
        assert_eq!(track_from_state(&st, SPOTIFY).unwrap().duration_ms, None);
    }

    #[test]
    fn rewrites_old_spotify_artwork_host() {
        // Older Spotify builds report a host that no longer serves the images.
        let mut st = spotify_state();
        st.metadata.insert("mpris:artUrl".into(), s("https://open.spotify.com/image/ab67616d0000b273"));
        assert_eq!(
            track_from_state(&st, SPOTIFY).unwrap().artwork_url.as_deref(),
            Some("https://i.scdn.co/image/ab67616d0000b273")
        );
    }

    #[test]
    fn ignores_non_http_artwork() {
        let mut st = spotify_state();
        st.metadata.insert("mpris:artUrl".into(), s("file:///tmp/cover.png"));
        assert_eq!(track_from_state(&st, SPOTIFY).unwrap().artwork_url, None);
    }

    #[test]
    fn transport_calls() {
        assert_eq!(control_call("playpause", None, None, None), Some(MprisCall::PlayPause));
        assert_eq!(control_call("next", None, None, None), Some(MprisCall::Next));
        assert_eq!(control_call("previous", None, None, None), Some(MprisCall::Previous));
        assert_eq!(control_call("shuffle", None, None, None), None);
    }

    #[test]
    fn seek_with_an_object_path_uses_set_position() {
        assert_eq!(
            control_call("seek", Some(61_500.0), Some("/com/spotify/track/abc"), Some(0)),
            Some(MprisCall::SetPosition { track_id: "/com/spotify/track/abc".into(), position_us: 61_500_000 })
        );
        assert_eq!(
            control_call("seek", Some(-10.0), Some("/com/spotify/track/abc"), None),
            Some(MprisCall::SetPosition { track_id: "/com/spotify/track/abc".into(), position_us: 0 })
        );
    }

    #[test]
    fn seek_with_a_uri_track_id_is_relative() {
        assert_eq!(
            control_call("seek", Some(61_500.0), Some("spotify:track:abc"), Some(70_000_000)),
            Some(MprisCall::Seek { offset_us: -8_500_000 })
        );
        // Without a position there is nothing to seek from.
        assert_eq!(control_call("seek", Some(61_500.0), Some("spotify:track:abc"), None), None);
        assert_eq!(control_call("seek", Some(61_500.0), None, None), None);
    }

    #[test]
    fn seek_needs_a_value() {
        assert_eq!(control_call("seek", None, Some("/com/spotify/track/abc"), Some(0)), None);
    }

    #[test]
    fn volume_is_scaled_and_clamped() {
        assert_eq!(control_call("volume", Some(64.0), None, None), Some(MprisCall::SetVolume(0.64)));
        assert_eq!(control_call("volume", Some(140.0), None, None), Some(MprisCall::SetVolume(1.0)));
        assert_eq!(control_call("volume", Some(-3.0), None, None), Some(MprisCall::SetVolume(0.0)));
        assert_eq!(control_call("volume", None, None, None), None);
    }
}
