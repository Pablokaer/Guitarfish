//! Which players the detectors follow, and which one wins when several play.
//! Pure logic (no OS calls), so it is tested on every OS: the detectors in
//! `desktop.rs`, `desktop/linux.rs` and the Kotlin plugin (which mirrors it) only
//! read the OS and ask this module which session to report.

/// The service behind a media session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Service {
    /// A YouTube video: the YouTube app, or a youtube.com tab.
    Youtube,
    /// YouTube Music: its app, its desktop app or music.youtube.com.
    YoutubeMusic,
    /// A browser playing media whose site the OS doesn't tell (Windows, Linux):
    /// in practice mostly YouTube, so its titles are read the YouTube way.
    Browser,
    Spotify,
}

impl Service {
    /// The `service` field of a [`crate::models::Track`] (and of `Track` in the UI).
    pub fn as_str(self) -> &'static str {
        match self {
            Service::Youtube => "youtube",
            Service::YoutubeMusic => "youtube-music",
            Service::Browser => "browser",
            Service::Spotify => "spotify",
        }
    }

    /// Ties between sessions in the same play state go to YouTube first.
    fn rank(self) -> u8 {
        match self {
            Service::Youtube | Service::YoutubeMusic => 3,
            Service::Browser => 2,
            Service::Spotify => 1,
        }
    }
}

/// A session the OS reports: its service and app name, e.g. (Browser, "Chrome").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Source {
    pub service: Service,
    pub app: &'static str,
}

impl Source {
    pub const fn new(service: Service, app: &'static str) -> Self {
        Source { service, app }
    }

    /// The `player` label shown in the app, e.g. "YouTube (Chrome, macOS)".
    pub fn player(self, os: &str) -> String {
        match self.service {
            Service::Youtube if self.app == "YouTube" => format!("YouTube ({os})"),
            Service::Youtube => format!("YouTube ({}, {os})", self.app),
            Service::YoutubeMusic if self.app == "YouTube Music" => format!("YouTube Music ({os})"),
            Service::YoutubeMusic => format!("YouTube Music ({}, {os})", self.app),
            Service::Browser | Service::Spotify => format!("{} ({os})", self.app),
        }
    }

    /// The same app, with the service a URL reveals (a browser tab on YouTube).
    #[cfg_attr(
        not(any(
            test,
            target_os = "linux",
            target_os = "dragonfly",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "openbsd"
        )),
        allow(dead_code)
    )]
    pub fn with_url(self, url: Option<&str>) -> Self {
        match url.and_then(service_from_url) {
            Some(service) => Source { service, ..self },
            None => self,
        }
    }
}

/// YouTube or YouTube Music, when `url` is one of their pages.
#[cfg_attr(
    not(any(
        test,
        target_os = "macos",
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    )),
    allow(dead_code)
)]
pub fn service_from_url(url: &str) -> Option<Service> {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let host = rest.split(['/', '?', '#']).next().unwrap_or("").to_ascii_lowercase();
    let host = host.rsplit_once('@').map_or(host.as_str(), |(_, h)| h).split(':').next().unwrap_or("");
    match host {
        "music.youtube.com" => Some(Service::YoutubeMusic),
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "youtu.be" => Some(Service::Youtube),
        _ => None,
    }
}

/// A YouTube page that plays one video (not the home page, a channel or search).
#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
pub fn is_video_url(url: &str) -> bool {
    service_from_url(url).is_some()
        && (url.contains("/watch?") || url.contains("/shorts/") || url.contains("/live/") || url.contains("youtu.be/"))
}

// Chrome installs YouTube and YouTube Music as apps with these extension ids (Windows).
const YOUTUBE_PWA: &str = "agimnkijcaahngcdmfeangaknmldooml";
const YOUTUBE_MUSIC_PWA: &str = "cinhimbnkkaeohfgghhklpknlkffjgod";

/// Windows: the SMTC session's `SourceAppUserModelId`. None for players Guitarfish ignores.
#[cfg_attr(not(any(test, windows)), allow(dead_code))]
pub fn windows_source(app_id: &str) -> Option<Source> {
    let id = app_id.to_ascii_lowercase();
    let browser = |app| Some(Source::new(Service::Browser, app));
    if id.contains(YOUTUBE_MUSIC_PWA) || id.contains("youtube-music") || id.contains("youtubemusic") {
        return Some(Source::new(Service::YoutubeMusic, "YouTube Music"));
    }
    if id.contains(YOUTUBE_PWA) {
        return Some(Source::new(Service::Youtube, "YouTube"));
    }
    if id.contains("spotify") {
        // "Spotify.exe" (installer) or "SpotifyAB.SpotifyMusic_…!Spotify" (Store).
        return Some(Source::new(Service::Spotify, "Spotify"));
    }
    if id.contains("msedge") {
        browser("Edge")
    } else if id.contains("brave") {
        browser("Brave")
    } else if id.contains("vivaldi") {
        browser("Vivaldi")
    } else if id.contains("opera") {
        browser("Opera")
    } else if id.contains("thebrowsercompany.arc") {
        browser("Arc")
    } else if id.contains("firefox") || id.contains("308046b0af4a39cb") {
        // Firefox registers under a hash of its install path, this one for the default.
        browser("Firefox")
    } else if id.contains("chrome") || id.contains("chromium") {
        browser("Chrome")
    } else {
        None
    }
}

/// Linux: an MPRIS bus name (`org.mpris.MediaPlayer2.<player>[.instance…]`).
#[cfg_attr(
    not(any(
        test,
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    )),
    allow(dead_code)
)]
pub fn mpris_source(bus_name: &str) -> Option<Source> {
    let player = bus_name.strip_prefix("org.mpris.MediaPlayer2.")?.to_ascii_lowercase();
    let first = player.split('.').next().unwrap_or("");
    let browser = |app| Some(Source::new(Service::Browser, app));
    match first {
        "spotify" => Some(Source::new(Service::Spotify, "Spotify")),
        "youtubemusic" | "youtube-music" => Some(Source::new(Service::YoutubeMusic, "YouTube Music")),
        "chromium" => browser("Chromium"),
        "chrome" | "google-chrome" => browser("Chrome"),
        "brave" => browser("Brave"),
        "vivaldi" => browser("Vivaldi"),
        "opera" => browser("Opera"),
        "edge" | "msedge" | "microsoft-edge" => browser("Edge"),
        "firefox" => browser("Firefox"),
        // KDE's browser integration republishes the tab's player, with its URL.
        "plasma-browser-integration" => browser("Browser"),
        _ => None,
    }
}

/// How sure a read is that the session is playing.
fn play_rank(playing: Option<bool>) -> u8 {
    match playing {
        Some(true) => 2,
        // A browser tab whose page can't be asked (macOS without JavaScript access).
        None => 1,
        Some(false) => 0,
    }
}

/// The session to report: a playing one before a paused one, then YouTube, then
/// other browser media, then Spotify; among equals, the first (callers put the
/// OS's current session first). `key` gives each candidate's service and play state.
pub fn pick<T>(candidates: &[T], key: impl Fn(&T) -> (Service, Option<bool>)) -> Option<usize> {
    let mut best: Option<(usize, (u8, u8))> = None;
    for (i, c) in candidates.iter().enumerate() {
        let (service, playing) = key(c);
        let score = (play_rank(playing), service.rank());
        if best.is_none_or(|(_, b)| score > b) {
            best = Some((i, score));
        }
    }
    best.map(|(i, _)| i)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_youtube_urls() {
        assert_eq!(service_from_url("https://www.youtube.com/watch?v=abc"), Some(Service::Youtube));
        assert_eq!(service_from_url("https://m.youtube.com/watch?v=abc"), Some(Service::Youtube));
        assert_eq!(service_from_url("https://youtu.be/abc"), Some(Service::Youtube));
        assert_eq!(service_from_url("https://music.youtube.com/watch?v=abc"), Some(Service::YoutubeMusic));
        assert_eq!(service_from_url("https://www.youtube.com.evil.example/watch?v=abc"), None);
        assert_eq!(service_from_url("https://example.com/?u=youtube.com"), None);
        assert_eq!(service_from_url("https://user@www.youtube.com:443/watch?v=x"), Some(Service::Youtube));
        assert_eq!(service_from_url(""), None);
    }

    #[test]
    fn tells_video_pages_from_others() {
        assert!(is_video_url("https://www.youtube.com/watch?v=abc&t=10"));
        assert!(is_video_url("https://www.youtube.com/shorts/abc"));
        assert!(is_video_url("https://www.youtube.com/live/abc"));
        assert!(is_video_url("https://youtu.be/abc"));
        assert!(is_video_url("https://music.youtube.com/watch?v=abc&list=x"));
        assert!(!is_video_url("https://www.youtube.com/"));
        assert!(!is_video_url("https://www.youtube.com/results?search_query=oasis"));
        assert!(!is_video_url("https://music.youtube.com/"));
        assert!(!is_video_url("https://example.com/watch?v=abc"));
    }

    #[test]
    fn windows_apps() {
        assert_eq!(windows_source("Spotify.exe").unwrap().service, Service::Spotify);
        assert_eq!(windows_source("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify").unwrap().service, Service::Spotify);
        assert_eq!(windows_source("Chrome"), Some(Source::new(Service::Browser, "Chrome")));
        assert_eq!(windows_source("MSEdge"), Some(Source::new(Service::Browser, "Edge")));
        assert_eq!(windows_source("308046B0AF4A39CB"), Some(Source::new(Service::Browser, "Firefox")));
        assert_eq!(windows_source("Brave"), Some(Source::new(Service::Browser, "Brave")));
        assert_eq!(
            windows_source("Chrome._crx_cinhimbnkkaeohfgghhklpknlkffjgod").unwrap().service,
            Service::YoutubeMusic
        );
        assert_eq!(windows_source("Chrome._crx_agimnkijcaahngcdmfeangaknmldooml").unwrap().service, Service::Youtube);
        assert_eq!(windows_source("com.github.th-ch.youtube-music").unwrap().service, Service::YoutubeMusic);
        assert_eq!(windows_source("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), None);
        assert_eq!(windows_source("VLC"), None);
    }

    #[test]
    fn mpris_players() {
        assert_eq!(mpris_source("org.mpris.MediaPlayer2.spotify").unwrap().service, Service::Spotify);
        assert_eq!(
            mpris_source("org.mpris.MediaPlayer2.chromium.instance12345"),
            Some(Source::new(Service::Browser, "Chromium"))
        );
        assert_eq!(
            mpris_source("org.mpris.MediaPlayer2.firefox.instance_1_42"),
            Some(Source::new(Service::Browser, "Firefox"))
        );
        assert_eq!(mpris_source("org.mpris.MediaPlayer2.YoutubeMusic").unwrap().service, Service::YoutubeMusic);
        assert_eq!(
            mpris_source("org.mpris.MediaPlayer2.plasma-browser-integration").unwrap().service,
            Service::Browser
        );
        assert_eq!(mpris_source("org.mpris.MediaPlayer2.vlc"), None);
        assert_eq!(mpris_source("org.freedesktop.DBus"), None);
    }

    #[test]
    fn a_url_reveals_youtube_behind_a_browser() {
        let chrome = Source::new(Service::Browser, "Chrome");
        assert_eq!(chrome.with_url(Some("https://www.youtube.com/watch?v=a")).service, Service::Youtube);
        assert_eq!(chrome.with_url(Some("https://music.youtube.com/watch?v=a")).service, Service::YoutubeMusic);
        assert_eq!(chrome.with_url(Some("https://vimeo.com/1")), chrome);
        assert_eq!(chrome.with_url(None), chrome);
    }

    #[test]
    fn player_labels() {
        assert_eq!(Source::new(Service::Youtube, "Chrome").player("macOS"), "YouTube (Chrome, macOS)");
        assert_eq!(Source::new(Service::Youtube, "YouTube").player("Android"), "YouTube (Android)");
        assert_eq!(Source::new(Service::YoutubeMusic, "YouTube Music").player("Windows"), "YouTube Music (Windows)");
        assert_eq!(Source::new(Service::YoutubeMusic, "Safari").player("macOS"), "YouTube Music (Safari, macOS)");
        assert_eq!(Source::new(Service::Browser, "Firefox").player("Linux"), "Firefox (Linux)");
        assert_eq!(Source::new(Service::Spotify, "Spotify").player("Windows"), "Spotify (Windows)");
        assert_eq!(Service::YoutubeMusic.as_str(), "youtube-music");
    }

    #[test]
    fn playing_wins_then_youtube() {
        use Service::*;
        let pick_of = |c: &[(Service, Option<bool>)]| pick(c, |&(s, p)| (s, p));
        // Spotify plays, YouTube is paused: Spotify.
        assert_eq!(pick_of(&[(Youtube, Some(false)), (Spotify, Some(true))]), Some(1));
        // Both play: YouTube.
        assert_eq!(pick_of(&[(Spotify, Some(true)), (Youtube, Some(true))]), Some(1));
        // Both paused: YouTube.
        assert_eq!(pick_of(&[(Spotify, Some(false)), (YoutubeMusic, Some(false))]), Some(1));
        // A tab of unknown state beats a paused player, not a playing one.
        assert_eq!(pick_of(&[(Spotify, Some(false)), (Youtube, None)]), Some(1));
        assert_eq!(pick_of(&[(Spotify, Some(true)), (Youtube, None)]), Some(0));
        // Browser media of an unknown site comes after YouTube, before Spotify.
        assert_eq!(pick_of(&[(Spotify, Some(true)), (Browser, Some(true)), (Youtube, Some(true))]), Some(2));
        assert_eq!(pick_of(&[(Spotify, Some(true)), (Browser, Some(true))]), Some(1));
        // Equals: the first (the OS's current session).
        assert_eq!(pick_of(&[(Youtube, Some(true)), (Youtube, Some(true))]), Some(0));
        assert_eq!(pick_of(&[]), None);
    }
}
