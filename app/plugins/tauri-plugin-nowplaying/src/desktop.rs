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
    // Reported only where every followed player signals: on macOS only Spotify
    // does, so the app keeps polling there for the browsers' YouTube tabs.
    EVENTS.store(installed && imp::EVENTS_REPLACE_POLLING, Ordering::Relaxed);
}

/// Read the current track from the OS: Spotify, YouTube (its app, YouTube Music or
/// a browser tab) or other media in a browser, whichever `sources::pick` prefers.
/// `track: None` when nothing is playing, or only a Spotify ad.
pub fn read_now_playing() -> Result<NowPlayingResponse> {
    imp::read()
}

/// Sends a playback command to the player a read reports. See `commands::control`.
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
// macOS: AppleScript against the Spotify app and the browsers' YouTube tabs.
// ---------------------------------------------------------------------------
#[cfg(target_os = "macos")]
mod imp {
    use std::process::Command;
    use std::sync::Mutex;

    use crate::browser::{self, Browser};
    use crate::models::{spotify_track_id, NowPlayingResponse, PlaybackCapabilities, Track};
    use crate::sources::{self, Service};
    use crate::{Error, Result};

    // `events` is filled in at runtime, once `watch` succeeds.
    pub const CAPABILITIES: PlaybackCapabilities =
        PlaybackCapabilities { transport: true, seek: true, volume: true, events: false };
    /// Only Spotify posts change notifications; browsers' tabs have to be polled.
    pub const EVENTS_REPLACE_POLLING: bool = false;

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

    /// What the last read reported, so `control` drives the same player.
    #[derive(Clone)]
    enum Chosen {
        Spotify,
        Tab { browser: Browser, url: String },
    }
    static CHOSEN: Mutex<Option<Chosen>> = Mutex::new(None);

    fn osascript(script: &str, app: &str) -> Result<String> {
        let out = Command::new("/usr/bin/osascript").arg("-e").arg(script).output()?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            // -1743: the user denied Automation access to the app.
            if err.contains("-1743") {
                return Err(Error::Detector(format!(
                    "Automation access to {app} was denied. Allow it in System Settings → Privacy & Security → Automation."
                )));
            }
            return Err(Error::Detector(err.trim().to_string()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// The browsers running now (`ps`, which needs no permission). Only those are
    /// scripted: telling a browser that isn't running would launch it.
    fn running_browsers() -> Vec<Browser> {
        Command::new("/bin/ps")
            .args(["-Ac", "-o", "comm="])
            .output()
            .map(|o| browser::running(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_default()
    }

    fn service(t: &Track) -> Service {
        match t.service.as_deref() {
            Some("spotify") => Service::Spotify,
            Some("youtube-music") => Service::YoutubeMusic,
            _ => Service::Youtube,
        }
    }

    pub fn read() -> Result<NowPlayingResponse> {
        // What each candidate is, its track, and its play state for the ranking.
        let mut found: Vec<(Chosen, Track, Option<bool>)> = Vec::new();
        let mut spotify_err: Option<Error> = None;
        match osascript(SCRIPT, "Spotify") {
            Ok(out) => {
                if let Some(t) = parse(&out) {
                    let playing = Some(t.is_playing);
                    found.push((Chosen::Spotify, t, playing));
                }
            }
            Err(e) => spotify_err = Some(e),
        }
        for b in running_browsers() {
            // A browser that fails (Automation denied) mustn't hide the others.
            let Ok(out) = osascript(&browser::read_script(&b), b.label) else { continue };
            for tab in browser::parse_tabs(&out) {
                if let Some((t, playing)) = browser::tab_track(&b, &tab) {
                    found.push((Chosen::Tab { browser: b, url: tab.url.clone() }, t, playing));
                }
            }
        }
        let pick = sources::pick(&found, |(_, t, playing)| (service(t), *playing));
        let mut chosen = CHOSEN.lock().unwrap_or_else(|e| e.into_inner());
        match pick {
            Some(i) => {
                let (what, track, _) = found.swap_remove(i);
                *chosen = Some(what);
                Ok(NowPlayingResponse { track: Some(track) })
            }
            None => {
                *chosen = None;
                // Spotify's error (e.g. Automation denied) only matters when nothing else plays.
                match spotify_err {
                    Some(e) => Err(e),
                    None => Ok(NowPlayingResponse { track: None }),
                }
            }
        }
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
        let chosen = CHOSEN.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(Chosen::Tab { browser: b, url }) = chosen {
            let js = browser::control_js(action, value).ok_or_else(|| super::unsupported(action))?;
            return match osascript(&browser::control_script(&b, &url, &js), b.label) {
                Ok(out) if out.trim() == "gone" => {
                    Err(Error::Detector(format!("The YouTube tab was closed in {}", b.label)))
                }
                Ok(_) => Ok(()),
                Err(Error::Detector(msg)) => {
                    Err(Error::Detector(browser::javascript_off_hint(&b, &msg).unwrap_or(msg)))
                }
                Err(e) => Err(e),
            };
        }
        let stmt = control_statement(action, value).ok_or_else(|| super::unsupported(action))?;
        // Same guard as reads: never launch Spotify just to control it.
        osascript(
            &format!("if application \"Spotify\" is running then\n  tell application \"Spotify\" to {stmt}\nend if"),
            "Spotify",
        )?;
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
            service: Some("spotify".into()),
        })
    }
}

// ---------------------------------------------------------------------------
// Windows: Global System Media Transport Controls. Spotify, the browsers
// (YouTube in a tab, or YouTube installed as an app) and YouTube Music apps.
// ---------------------------------------------------------------------------
#[cfg(target_os = "windows")]
mod imp {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };

    use crate::models::{NowPlayingResponse, PlaybackCapabilities, Track};
    use crate::sources::{self, Service, Source};
    use crate::{Error, Result};

    // SMTC has no volume control; that belongs to the system mixer.
    pub const CAPABILITIES: PlaybackCapabilities =
        PlaybackCapabilities { transport: true, seek: true, volume: false, events: false };
    /// SMTC change events aren't wired up (see `start_events`), so nothing replaces polling.
    pub const EVENTS_REPLACE_POLLING: bool = false;

    /// Windows FILETIME epoch (1601-01-01) to Unix epoch, in 100 ns ticks.
    const EPOCH_DIFF_100NS: i64 = 116_444_736_000_000_000;

    fn werr(e: windows::core::Error) -> Error {
        Error::Detector(format!("SMTC: {e}"))
    }

    fn now_unix_ms() -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
    }

    /// The followed sessions, the one Windows considers current first (it wins ties).
    fn sessions(mgr: &Manager) -> Result<Vec<(Session, Source)>> {
        let current = mgr.GetCurrentSession().ok().and_then(|s| s.SourceAppUserModelId().ok()).map(|id| id.to_string());
        let list = mgr.GetSessions().map_err(werr)?;
        let mut out = Vec::new();
        for i in 0..list.Size().map_err(werr)? {
            let s = list.GetAt(i).map_err(werr)?;
            let id = s.SourceAppUserModelId().map_err(werr)?.to_string();
            let Some(source) = sources::windows_source(&id) else { continue };
            if current.as_deref() == Some(id.as_str()) {
                out.insert(0, (s, source));
            } else {
                out.push((s, source));
            }
        }
        Ok(out)
    }

    fn is_playing(s: &Session) -> bool {
        s.GetPlaybackInfo().and_then(|p| p.PlaybackStatus()).map(|st| st == Status::Playing).unwrap_or(false)
    }

    /// The session's track, or None when it has nothing to show (a Spotify ad).
    fn track(session: &Session, source: Source) -> Result<Option<Track>> {
        let props = session.TryGetMediaPropertiesAsync().map_err(werr)?.get().map_err(werr)?;
        let title = props.Title().map_err(werr)?.to_string();
        let artist = props.Artist().map_err(werr)?.to_string();
        // Spotify reports ads with an empty artist (and a title like "Advertisement").
        if title.is_empty() || (source.service == Service::Spotify && artist.is_empty()) {
            return Ok(None);
        }
        let album = props.AlbumTitle().map(|s| s.to_string()).ok().filter(|s| !s.is_empty());
        let is_playing = is_playing(session);

        // Timeline values are in 100 ns units. Players only refresh Position on
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
                // A session without a timeline (some sites) reports 0 for both.
                ((end > 0).then_some(end as u64), (end > 0 && pos >= 0).then_some(pos as u64))
            }
            Err(_) => (None, None),
        };

        Ok(Some(Track {
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
            player: source.player("Windows"),
            service: Some(source.service.as_str().into()),
        }))
    }

    /// The session to report and its track: the preferred one (`sources::pick`),
    /// or, when it has nothing to show, the next one.
    fn current(mgr: &Manager) -> Result<Option<(Session, Track)>> {
        let mut all = sessions(mgr)?;
        while let Some(i) = sources::pick(&all, |(s, src)| (src.service, Some(is_playing(s)))) {
            let (session, source) = all.swap_remove(i);
            if let Some(t) = track(&session, source)? {
                return Ok(Some((session, t)));
            }
        }
        Ok(None)
    }

    pub fn read() -> Result<NowPlayingResponse> {
        let mgr = Manager::RequestAsync().map_err(werr)?.get().map_err(werr)?;
        Ok(NowPlayingResponse { track: current(&mgr)?.map(|(_, t)| t) })
    }

    pub fn control(action: &str, value: Option<f64>) -> Result<()> {
        let mgr = Manager::RequestAsync().map_err(werr)?.get().map_err(werr)?;
        let Some((session, _)) = current(&mgr)? else {
            return Err(Error::Detector("Nothing is playing".into()));
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

    /// Prints the SMTC sessions this machine has now and what Guitarfish makes of
    /// them: `cargo test -- --ignored live_sessions --nocapture` while YouTube plays.
    #[test]
    #[ignore = "reads this machine's media sessions"]
    fn live_sessions() {
        let mgr = Manager::RequestAsync().unwrap().get().unwrap();
        let list = mgr.GetSessions().unwrap();
        for i in 0..list.Size().unwrap() {
            let s = list.GetAt(i).unwrap();
            let id = s.SourceAppUserModelId().unwrap().to_string();
            println!("{id:?} -> {:?}, playing {}", sources::windows_source(&id), is_playing(&s));
        }
        println!("reported: {:?}", read().unwrap().track);
    }
}

// ---------------------------------------------------------------------------
// Linux and the BSDs: MPRIS over the D-Bus session bus (desktop/linux.rs).
// Tauri's desktop targets are macOS, Windows and these, so this is the rest.
// ---------------------------------------------------------------------------
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod linux;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use linux as imp;

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
        assert_eq!(t.service.as_deref(), Some("spotify"));
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
