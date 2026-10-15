//! Desktop detectors. Each call does a fresh, synchronous read; the caller runs it
//! on a blocking thread. Where the OS announces changes, [`start_events`] turns
//! them into `nowplaying://changed` events.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Runtime};

use crate::models::{NowPlayingResponse, PlaybackCapabilities};
use crate::Result;

/// Set once the change observer is installed; reported as `events`.
static EVENTS: AtomicBool = AtomicBool::new(false);

/// Starts emitting [`crate::CHANGED_EVENT`] (no payload) whenever the player
/// reports a change. Called once from the plugin's setup.
pub(crate) fn start_events<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let emit = move || {
        let _ = app.emit(crate::CHANGED_EVENT, ());
    };
    #[cfg(not(target_os = "windows"))]
    let installed = imp::watch(emit);
    // SMTC has change events too, but they aren't wired up yet.
    #[cfg(target_os = "windows")]
    let installed = {
        drop(emit);
        false
    };
    EVENTS.store(installed, Ordering::Relaxed);
}

/// Read the current track from the OS. `track: None` when nothing is playing,
/// Spotify is closed, or an ad is playing.
pub fn read_now_playing() -> Result<NowPlayingResponse> {
    imp::read()
}

/// Sends a playback command to Spotify. See `commands::control` for the actions.
pub fn control(action: &str, value: Option<f64>) -> Result<()> {
    imp::control(action, value)
}

pub fn capabilities() -> PlaybackCapabilities {
    PlaybackCapabilities { events: EVENTS.load(Ordering::Relaxed), ..imp::CAPABILITIES }
}

fn unsupported(action: &str) -> crate::Error {
    crate::Error::Detector(format!("playback action \"{action}\" is not supported on this platform"))
}

// ---------------------------------------------------------------------------
// macOS: AppleScript against the Spotify app.
// ---------------------------------------------------------------------------
#[cfg(target_os = "macos")]
mod imp {
    use std::process::Command;

    use crate::models::{spotify_track_id, NowPlayingResponse, PlaybackCapabilities, Track};
    use crate::{Error, Result};

    // `events` is filled in at runtime, once `watch` succeeds.
    pub const CAPABILITIES: PlaybackCapabilities =
        PlaybackCapabilities { transport: true, seek: true, volume: true, events: false };

    /// Calls `on_change` on the main thread each time Spotify posts the
    /// `com.spotify.client.PlaybackStateChanged` distributed notification
    /// (track change, play, pause, seek). No AppleScript runs for this, so it
    /// never triggers the Automation prompt.
    pub fn watch(on_change: impl Fn() + Send + 'static) -> bool {
        use std::ptr::NonNull;

        use block2::RcBlock;
        use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSOperationQueue, NSString};

        let name = NSString::from_str("com.spotify.client.PlaybackStateChanged");
        let block = RcBlock::new(move |_: NonNull<NSNotification>| on_change());
        let center = NSDistributedNotificationCenter::defaultCenter();
        // SAFETY: the name is a valid NSString, `object: None` accepts any sender,
        // and the block only calls `on_change`, which is 'static and needs nothing
        // from the notification.
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(&name),
                None,
                Some(&NSOperationQueue::mainQueue()),
                &block,
            )
        };
        // The observer is meant to live as long as the app, so its token is never
        // released (removing it would need the token).
        std::mem::forget(observer);
        true
    }

    // `application "Spotify" is running` is checked first so polling never
    // launches Spotify. Fields are separated by the ASCII unit separator (31),
    // which cannot appear in titles. Position is converted to integer ms inside
    // AppleScript so the decimal separator of the user's locale does not matter.
    // Artwork is read inside `try`: older Spotify builds lack `artwork url`.
    const SCRIPT: &str = r#"
if application "Spotify" is running then
  tell application "Spotify"
    if player state is stopped then return ""
    set t to current track
    set sep to character id 31
    set pos to ((player position) * 1000) as integer
    set art to ""
    try
      set art to artwork url of t
    end try
    return (name of t) & sep & (artist of t) & sep & (album of t) & sep & ((duration of t) as text) & sep & (pos as text) & sep & ((player state) as text) & sep & (id of t) & sep & ((sound volume) as text) & sep & art
  end tell
end if
return ""
"#;

    fn osascript(script: &str) -> Result<String> {
        let out = Command::new("/usr/bin/osascript").arg("-e").arg(script).output()?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            // -1743: the user denied Automation access to Spotify.
            if err.contains("-1743") {
                return Err(Error::Detector(
                    "Automation access to Spotify was denied. Allow it in System Settings → Privacy & Security → Automation.".into(),
                ));
            }
            return Err(Error::Detector(err.trim().to_string()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    pub fn read() -> Result<NowPlayingResponse> {
        Ok(NowPlayingResponse { track: parse(&osascript(SCRIPT)?) })
    }

    /// Builds the AppleScript statement for a control action. Numbers are
    /// formatted by Rust, so they always use "." as the decimal separator, which
    /// is what AppleScript source expects.
    pub(super) fn control_statement(action: &str, value: Option<f64>) -> Option<String> {
        Some(match action {
            "playpause" => "playpause".into(),
            "next" => "next track".into(),
            "previous" => "previous track".into(),
            "seek" => format!("set player position to {:.3}", value?.max(0.0) / 1000.0),
            "volume" => format!("set sound volume to {}", value?.clamp(0.0, 100.0).round() as u8),
            _ => return None,
        })
    }

    pub fn control(action: &str, value: Option<f64>) -> Result<()> {
        let stmt = control_statement(action, value).ok_or_else(|| super::unsupported(action))?;
        // Same guard as reads: never launch Spotify just to control it.
        osascript(&format!(
            "if application \"Spotify\" is running then\n  tell application \"Spotify\" to {stmt}\nend if"
        ))?;
        Ok(())
    }

    pub(super) fn parse(stdout: &str) -> Option<Track> {
        let line = stdout.trim_end_matches(['\n', '\r']);
        if line.is_empty() {
            return None;
        }
        let f: Vec<&str> = line.split('\u{1f}').collect();
        if f.len() < 7 {
            return None;
        }
        let uri = f[6];
        // Ads have URIs like spotify:ad:…; podcasts spotify:episode:…
        if uri.starts_with("spotify:ad:") || f[0].is_empty() {
            return None;
        }
        Some(Track {
            title: f[0].to_string(),
            artist: f[1].to_string(),
            album: Some(f[2].to_string()).filter(|s| !s.is_empty()),
            duration_ms: f[3].trim().parse().ok(),
            position_ms: f[4].trim().parse().ok(),
            is_playing: f[5].trim() == "playing",
            spotify_id: spotify_track_id(uri),
            // Added later than the first seven fields; absent in older outputs.
            volume: f.get(7).and_then(|v| v.trim().parse().ok()),
            artwork_url: f.get(8).map(|s| s.trim()).filter(|s| s.starts_with("http")).map(str::to_string),
            source: "os".into(),
            player: "Spotify (macOS)".into(),
        })
    }
}

// ---------------------------------------------------------------------------
// Windows: Global System Media Transport Controls.
// ---------------------------------------------------------------------------
#[cfg(target_os = "windows")]
mod imp {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };

    use crate::models::{NowPlayingResponse, PlaybackCapabilities, Track};
    use crate::{Error, Result};

    // SMTC has no volume control; that belongs to the system mixer.
    pub const CAPABILITIES: PlaybackCapabilities =
        PlaybackCapabilities { transport: true, seek: true, volume: false, events: false };

    /// Windows FILETIME epoch (1601-01-01) to Unix epoch, in 100 ns ticks.
    const EPOCH_DIFF_100NS: i64 = 116_444_736_000_000_000;

    fn werr(e: windows::core::Error) -> Error {
        Error::Detector(format!("SMTC: {e}"))
    }

    fn now_unix_ms() -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
    }

    /// Prefer a Spotify session; fall back to the session Windows considers current
    /// only if it is Spotify too (MVP is Spotify-focused).
    fn find_spotify(mgr: &Manager) -> Result<Option<Session>> {
        let sessions = mgr.GetSessions().map_err(werr)?;
        for i in 0..sessions.Size().map_err(werr)? {
            let s = sessions.GetAt(i).map_err(werr)?;
            let id = s.SourceAppUserModelId().map_err(werr)?.to_string().to_lowercase();
            // "Spotify.exe" (installer) or "SpotifyAB.SpotifyMusic_…!Spotify" (Store).
            if id.contains("spotify") {
                return Ok(Some(s));
            }
        }
        Ok(None)
    }

    pub fn read() -> Result<NowPlayingResponse> {
        let mgr = Manager::RequestAsync().map_err(werr)?.get().map_err(werr)?;
        let Some(session) = find_spotify(&mgr)? else {
            return Ok(NowPlayingResponse { track: None });
        };

        let props = session.TryGetMediaPropertiesAsync().map_err(werr)?.get().map_err(werr)?;
        let title = props.Title().map_err(werr)?.to_string();
        let artist = props.Artist().map_err(werr)?.to_string();
        // Spotify reports ads with an empty artist (and a title like "Advertisement").
        if title.is_empty() || artist.is_empty() {
            return Ok(NowPlayingResponse { track: None });
        }
        let album = props.AlbumTitle().map(|s| s.to_string()).ok().filter(|s| !s.is_empty());

        let is_playing =
            session.GetPlaybackInfo().and_then(|p| p.PlaybackStatus()).map(|s| s == Status::Playing).unwrap_or(false);

        // Timeline values are in 100 ns units. Spotify only refreshes Position on
        // state changes, so extrapolate from LastUpdatedTime while playing.
        let (duration_ms, position_ms) = match session.GetTimelineProperties() {
            Ok(tl) => {
                let end = tl.EndTime().map(|t| t.Duration / 10_000).unwrap_or(0);
                let mut pos = tl.Position().map(|t| t.Duration / 10_000).unwrap_or(0);
                if is_playing {
                    if let Ok(updated) = tl.LastUpdatedTime() {
                        let updated_ms = (updated.UniversalTime - EPOCH_DIFF_100NS) / 10_000;
                        let elapsed = now_unix_ms() - updated_ms;
                        if (0..6 * 60 * 60 * 1000).contains(&elapsed) {
                            pos += elapsed;
                        }
                    }
                }
                if end > 0 {
                    pos = pos.min(end);
                }
                ((end > 0).then_some(end as u64), (pos >= 0).then_some(pos as u64))
            }
            Err(_) => (None, None),
        };

        Ok(NowPlayingResponse {
            track: Some(Track {
                title,
                artist,
                album,
                duration_ms,
                position_ms,
                is_playing,
                // SMTC does not expose the Spotify track ID.
                spotify_id: None,
                volume: None,
                // SMTC exposes a thumbnail stream, not a URL.
                artwork_url: None,
                source: "os".into(),
                player: "Spotify (Windows)".into(),
            }),
        })
    }

    pub fn control(action: &str, value: Option<f64>) -> Result<()> {
        let mgr = Manager::RequestAsync().map_err(werr)?.get().map_err(werr)?;
        let Some(session) = find_spotify(&mgr)? else {
            return Err(Error::Detector("Spotify is not running".into()));
        };
        let op = match action {
            "playpause" => session.TryTogglePlayPauseAsync(),
            "next" => session.TrySkipNextAsync(),
            "previous" => session.TrySkipPreviousAsync(),
            // Position in 100 ns ticks.
            "seek" => match value {
                Some(ms) => session.TryChangePlaybackPositionAsync((ms.max(0.0) * 10_000.0) as i64),
                None => return Err(super::unsupported(action)),
            },
            _ => return Err(super::unsupported(action)),
        }
        .map_err(werr)?;
        op.get().map_err(werr)?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Other desktops (Linux): not implemented in the MVP. The app falls back to the
// Spotify Web API through the server. MPRIS over D-Bus would go here.
// ---------------------------------------------------------------------------
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use crate::models::{NowPlayingResponse, PlaybackCapabilities};
    use crate::Result;

    pub const CAPABILITIES: PlaybackCapabilities =
        PlaybackCapabilities { transport: false, seek: false, volume: false, events: false };

    pub fn read() -> Result<NowPlayingResponse> {
        Ok(NowPlayingResponse { track: None })
    }

    pub fn control(action: &str, _value: Option<f64>) -> Result<()> {
        Err(super::unsupported(action))
    }

    pub fn watch(_on_change: impl Fn() + Send + 'static) -> bool {
        false
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn parses_osascript_output() {
        let line = "Song\u{1f}Artist\u{1f}Album\u{1f}245000\u{1f}12345\u{1f}playing\u{1f}spotify:track:abc\n";
        let t = super::imp::parse(line).unwrap();
        assert_eq!(t.title, "Song");
        assert_eq!(t.duration_ms, Some(245000));
        assert_eq!(t.position_ms, Some(12345));
        assert!(t.is_playing);
        assert_eq!(t.spotify_id.as_deref(), Some("abc"));
        assert_eq!(t.volume, None);
        assert_eq!(t.artwork_url, None);
    }

    #[test]
    fn parses_volume_and_artwork() {
        let line = "Song\u{1f}Artist\u{1f}Album\u{1f}245000\u{1f}0\u{1f}paused\u{1f}spotify:track:abc\u{1f}64\u{1f}https://i.scdn.co/image/x\n";
        let t = super::imp::parse(line).unwrap();
        assert!(!t.is_playing);
        assert_eq!(t.volume, Some(64));
        assert_eq!(t.artwork_url.as_deref(), Some("https://i.scdn.co/image/x"));
    }

    #[test]
    fn control_statements() {
        use super::imp::control_statement as c;
        assert_eq!(c("playpause", None).as_deref(), Some("playpause"));
        assert_eq!(c("seek", Some(61_500.0)).as_deref(), Some("set player position to 61.500"));
        assert_eq!(c("volume", Some(140.0)).as_deref(), Some("set sound volume to 100"));
        assert_eq!(c("seek", None), None);
        assert_eq!(c("shuffle", None), None);
    }

    #[test]
    fn ignores_ads() {
        let line = "Ad\u{1f}\u{1f}\u{1f}30000\u{1f}0\u{1f}playing\u{1f}spotify:ad:xyz";
        assert!(super::imp::parse(line).is_none());
    }
}
