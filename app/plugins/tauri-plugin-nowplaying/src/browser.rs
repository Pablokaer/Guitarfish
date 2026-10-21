//! YouTube in a browser on macOS, which has no public API for other apps' media
//! sessions: AppleScript lists each running browser's YouTube tabs and, where the
//! browser allows JavaScript from Apple Events, asks the page for its media session
//! and the video's position. This module builds the scripts and reads their output;
//! it calls nothing, so its tests run on every OS (`desktop.rs` runs the scripts).

use serde::Deserialize;

use crate::models::Track;
use crate::sources::{is_video_url, service_from_url, Source};

/// How a browser is scripted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// Chrome and its relatives: `execute <tab> javascript`, `title of <tab>`.
    Chromium,
    /// Safari: `do JavaScript … in <tab>`, `name of <tab>`.
    Safari,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Browser {
    /// The process name `ps -c` shows while it runs.
    pub process: &'static str,
    /// The application name AppleScript addresses.
    pub app: &'static str,
    /// The short name in labels.
    pub label: &'static str,
    pub dialect: Dialect,
}

/// The browsers that can be asked for their tabs. Firefox has no AppleScript
/// support for tabs, so it isn't one.
pub const BROWSERS: &[Browser] = &[
    Browser { process: "Google Chrome", app: "Google Chrome", label: "Chrome", dialect: Dialect::Chromium },
    Browser { process: "Safari", app: "Safari", label: "Safari", dialect: Dialect::Safari },
    Browser { process: "Microsoft Edge", app: "Microsoft Edge", label: "Edge", dialect: Dialect::Chromium },
    Browser { process: "Brave Browser", app: "Brave Browser", label: "Brave", dialect: Dialect::Chromium },
    Browser { process: "Arc", app: "Arc", label: "Arc", dialect: Dialect::Chromium },
    Browser { process: "Vivaldi", app: "Vivaldi", label: "Vivaldi", dialect: Dialect::Chromium },
    Browser { process: "Chromium", app: "Chromium", label: "Chromium", dialect: Dialect::Chromium },
];

/// The browsers in `ps -Ac -o comm=` output (one process name per line). Only
/// running browsers are scripted: telling one that isn't running would launch it.
pub fn running(ps_output: &str) -> Vec<Browser> {
    let names: Vec<&str> = ps_output.lines().map(str::trim).collect();
    BROWSERS.iter().copied().filter(|b| names.contains(&b.process)).collect()
}

/// Asked of each YouTube tab: its media session and the video's state, as JSON.
/// Single quotes only, so it can sit in an AppleScript string as it is.
const PAGE_JS: &str = "(function(){var v=document.querySelector('video');var m=navigator.mediaSession&&navigator.mediaSession.metadata;var art=m&&m.artwork&&m.artwork.length?m.artwork[m.artwork.length-1].src:null;return JSON.stringify({title:m?m.title:null,artist:m?m.artist:null,album:m?m.album:null,artwork:art,position:v?v.currentTime:null,duration:v?v.duration:null,paused:v?v.paused:null,ad:!!document.querySelector('.ad-showing')});})()";

const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';

/// An AppleScript string literal of `s`.
pub fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The AppleScript condition "the tab's URL `u` is on YouTube".
const IS_YOUTUBE: &str = "u is not missing value and (u contains \"youtube.com/\" or u contains \"youtu.be/\")";

fn tab_terms(d: Dialect) -> (&'static str, String) {
    let js = applescript_string(PAGE_JS);
    match d {
        Dialect::Chromium => ("title", format!("execute t javascript {js}")),
        Dialect::Safari => ("name", format!("do JavaScript {js} in t")),
    }
}

/// Lists the browser's YouTube tabs, one record each: URL, tab title, and the page's
/// JSON (empty when JavaScript from Apple Events is off).
pub fn read_script(b: &Browser) -> String {
    let (title, exec) = tab_terms(b.dialect);
    format!(
        r#"set sep to character id 31
set rs to character id 30
set out to ""
tell application {app}
  repeat with w in windows
    repeat with t in tabs of w
      set u to URL of t
      if {IS_YOUTUBE} then
        set info to ""
        try
          set info to ({exec})
          if info is missing value then set info to ""
        end try
        set out to out & u & sep & ({title} of t) & sep & info & rs
      end if
    end repeat
  end repeat
end tell
return out"#,
        app = applescript_string(b.app),
    )
}

/// Runs `js` in the browser's tab showing `url`.
pub fn control_script(b: &Browser, url: &str, js: &str) -> String {
    let exec = match b.dialect {
        Dialect::Chromium => format!("execute t javascript {}", applescript_string(js)),
        Dialect::Safari => format!("do JavaScript {} in t", applescript_string(js)),
    };
    format!(
        r#"tell application {app}
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t is {url} then
        {exec}
        return "ok"
      end if
    end repeat
  end repeat
end tell
return "gone""#,
        app = applescript_string(b.app),
        url = applescript_string(url),
    )
}

/// The JavaScript for a `control` action on a YouTube page. YouTube has a next
/// button but no previous one: there "previous" restarts the video.
pub fn control_js(action: &str, value: Option<f64>) -> Option<String> {
    let video = "var v=document.querySelector('video');if(!v)return;";
    let body = match action {
        "playpause" => format!("{video}if(v.paused){{v.play();}}else{{v.pause();}}"),
        "seek" => format!("{video}v.currentTime={:.3};", value?.max(0.0) / 1000.0),
        "volume" => format!("{video}v.volume={:.2};", value?.clamp(0.0, 100.0) / 100.0),
        "next" => "var b=document.querySelector('.ytp-next-button, ytmusic-player-bar .next-button');if(b)b.click();".into(),
        "previous" => format!("var b=document.querySelector('ytmusic-player-bar .previous-button');if(b){{b.click();return;}}{video}v.currentTime=0;"),
        _ => return None,
    };
    Some(format!("(function(){{{body}}})()"))
}

/// What the page reported (PAGE_JS).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct PageInfo {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub artwork: Option<String>,
    /// Seconds.
    pub position: Option<f64>,
    /// Seconds; NaN while the video loads, which JSON sends as null.
    pub duration: Option<f64>,
    pub paused: Option<bool>,
    #[serde(default)]
    pub ad: bool,
}

/// A YouTube tab of a browser.
#[derive(Debug, Clone, PartialEq)]
pub struct Tab {
    pub url: String,
    pub title: String,
    /// None when the browser didn't run the page script (JavaScript from Apple Events is off).
    pub page: Option<PageInfo>,
}

/// The tabs in a read_script's output.
pub fn parse_tabs(stdout: &str) -> Vec<Tab> {
    stdout
        .trim_end_matches(['\n', '\r'])
        .split(RECORD)
        .filter_map(|rec| {
            let mut f = rec.splitn(3, FIELD);
            let url = f.next()?.trim().to_string();
            let title = f.next()?.to_string();
            let info = f.next().unwrap_or("").trim();
            if url.is_empty() {
                return None;
            }
            let page = (!info.is_empty()).then(|| serde_json::from_str::<PageInfo>(info).ok()).flatten();
            Some(Tab { url, title, page })
        })
        .collect()
}

/// A tab title without YouTube's decorations: the unread count ("(3) ") and the
/// " - YouTube" / " - YouTube Music" suffix.
pub fn clean_tab_title(title: &str) -> String {
    let mut t = title.trim();
    if let Some(rest) = t.strip_prefix('(') {
        if let Some((count, after)) = rest.split_once(") ") {
            if !count.is_empty() && count.chars().all(|c| c.is_ascii_digit() || c == '+') {
                t = after;
            }
        }
    }
    for suffix in [" - YouTube Music", " - YouTube"] {
        if let Some(s) = t.strip_suffix(suffix) {
            t = s;
            break;
        }
    }
    t.trim().to_string()
}

fn non_empty(s: &Option<String>) -> Option<String> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// The tab as a track, and whether it plays (None: the page couldn't be asked).
/// Tabs that don't show a video yield nothing.
pub fn tab_track(b: &Browser, tab: &Tab) -> Option<(Track, Option<bool>)> {
    let service = service_from_url(&tab.url)?;
    let page = tab.page.as_ref();
    // Without the page's answer only a video page tells what is on.
    if page.is_none() && !is_video_url(&tab.url) {
        return None;
    }
    let title = page.and_then(|p| non_empty(&p.title)).unwrap_or_else(|| clean_tab_title(&tab.title));
    if title.is_empty() || (page.is_some_and(|p| p.paused.is_none()) && !is_video_url(&tab.url)) {
        return None;
    }
    let playing = page.and_then(|p| p.paused).map(|paused| !paused);
    let ms = |s: Option<f64>| s.filter(|v| v.is_finite() && *v >= 0.0).map(|v| (v * 1000.0).round() as u64);
    // During an ad the video element plays the ad: its times aren't the song's.
    let ad = page.is_some_and(|p| p.ad);
    let duration_ms = if ad { None } else { page.and_then(|p| ms(p.duration)).filter(|&d| d > 0) };
    let position_ms =
        if ad { None } else { page.and_then(|p| ms(p.position)).map(|p| duration_ms.map_or(p, |d| p.min(d))) };
    let source = Source::new(service, b.label);
    Some((
        Track {
            title,
            artist: page.and_then(|p| non_empty(&p.artist)).unwrap_or_default(),
            album: page.and_then(|p| non_empty(&p.album)),
            duration_ms,
            position_ms,
            // Unknown counts as playing: a YouTube tab is open, nothing says it is paused.
            is_playing: playing.unwrap_or(true),
            spotify_id: None,
            volume: None,
            artwork_url: page.and_then(|p| non_empty(&p.artwork)).filter(|u| u.starts_with("https://")),
            source: "os".into(),
            player: source.player("macOS"),
            service: Some(service.as_str().into()),
        },
        playing,
    ))
}

/// The error a browser gives when it doesn't allow JavaScript from Apple Events,
/// rewritten to say where to turn it on.
pub fn javascript_off_hint(b: &Browser, err: &str) -> Option<String> {
    if !err.to_ascii_lowercase().contains("javascript") {
        return None;
    }
    let where_ = match b.dialect {
        Dialect::Safari => "Safari → Settings → Advanced → Show features for web developers, then Develop → Allow JavaScript from Apple Events",
        Dialect::Chromium => "View → Developer → Allow JavaScript from Apple Events",
    };
    Some(format!(
        "{} doesn't let Guitarfish control the video. Turn on {where_} in {}, so Guitarfish can also see where the video is.",
        b.label, b.label
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHROME: Browser = BROWSERS[0];
    const SAFARI: Browser = BROWSERS[1];

    fn tab(url: &str, title: &str, page: Option<&str>) -> String {
        format!("{url}{FIELD}{title}{FIELD}{}{RECORD}", page.unwrap_or(""))
    }

    const PAGE: &str = r#"{"title":"Wonderwall (Official Video)","artist":"OasisVEVO","album":"","artwork":"https://i.ytimg.com/vi/x/hq.jpg","position":61.5,"duration":258.4,"paused":false,"ad":false}"#;

    #[test]
    fn finds_running_browsers() {
        let ps = "launchd\nGoogle Chrome\nGoogle Chrome Helper (Renderer)\nSafari\nFinder\n";
        assert_eq!(running(ps), vec![CHROME, SAFARI]);
        assert_eq!(running("Finder\nArcade\n"), vec![]);
    }

    #[test]
    fn scripts_address_the_right_app_and_terms() {
        let chrome = read_script(&CHROME);
        assert!(chrome.contains("tell application \"Google Chrome\""));
        assert!(chrome.contains("execute t javascript \"(function(){"));
        assert!(chrome.contains("(title of t)"));
        let safari = read_script(&SAFARI);
        assert!(safari.contains("do JavaScript \"(function(){"));
        assert!(safari.contains("(name of t)"));
        // The page script needs no escaping inside the AppleScript string.
        assert!(!PAGE_JS.contains('"') && !PAGE_JS.contains('\\'));
    }

    #[test]
    fn escapes_applescript_strings() {
        assert_eq!(applescript_string(r#"a "b" \c"#), r#""a \"b\" \\c""#);
        let s = control_script(&CHROME, "https://www.youtube.com/watch?v=a\"b", "x()");
        assert!(s.contains(r#"if URL of t is "https://www.youtube.com/watch?v=a\"b" then"#));
        assert!(s.contains("execute t javascript \"x()\""));
        assert!(control_script(&SAFARI, "u", "x()").contains("do JavaScript \"x()\" in t"));
    }

    #[test]
    fn parses_tabs_with_and_without_the_page() {
        let out = tab("https://www.youtube.com/watch?v=1", "Wonderwall - YouTube", Some(PAGE))
            + &tab("https://www.youtube.com/watch?v=2", "(3) Live Forever - YouTube", None)
            + &tab("https://www.youtube.com/watch?v=3", "Broken", Some("{not json"))
            + "\n";
        let tabs = parse_tabs(&out);
        assert_eq!(tabs.len(), 3);
        assert_eq!(tabs[0].page.as_ref().unwrap().position, Some(61.5));
        assert_eq!(tabs[1].page, None);
        assert_eq!(tabs[2].page, None);
        assert!(parse_tabs("").is_empty());
    }

    #[test]
    fn a_tab_with_its_page_is_a_full_track() {
        let t = &parse_tabs(&tab("https://www.youtube.com/watch?v=1", "x", Some(PAGE)))[0];
        let (track, playing) = tab_track(&CHROME, t).unwrap();
        assert_eq!(playing, Some(true));
        assert_eq!(track.title, "Wonderwall (Official Video)");
        assert_eq!(track.artist, "OasisVEVO");
        assert_eq!(track.album, None);
        assert_eq!(track.position_ms, Some(61_500));
        assert_eq!(track.duration_ms, Some(258_400));
        assert_eq!(track.artwork_url.as_deref(), Some("https://i.ytimg.com/vi/x/hq.jpg"));
        assert_eq!(track.player, "YouTube (Chrome, macOS)");
        assert_eq!(track.service.as_deref(), Some("youtube"));
    }

    #[test]
    fn without_the_page_the_tab_title_is_used() {
        let t = &parse_tabs(&tab("https://music.youtube.com/watch?v=1", "(12) Wonderwall - YouTube Music", None))[0];
        let (track, playing) = tab_track(&SAFARI, t).unwrap();
        assert_eq!(playing, None);
        assert!(track.is_playing);
        assert_eq!(track.title, "Wonderwall");
        assert_eq!(track.artist, "");
        assert_eq!(track.position_ms, None);
        assert_eq!(track.player, "YouTube Music (Safari, macOS)");
    }

    #[test]
    fn pages_without_a_video_are_skipped() {
        let home = &parse_tabs(&tab("https://www.youtube.com/", "YouTube", None))[0];
        assert!(tab_track(&CHROME, home).is_none());
        let page = r#"{"title":null,"artist":null,"album":null,"artwork":null,"position":null,"duration":null,"paused":null,"ad":false}"#;
        let search = &parse_tabs(&tab("https://www.youtube.com/results?search_query=x", "x - YouTube", Some(page)))[0];
        assert!(tab_track(&CHROME, search).is_none());
        let other = Tab { url: "https://vimeo.com/1".into(), title: "x".into(), page: None };
        assert!(tab_track(&CHROME, &other).is_none());
    }

    #[test]
    fn ads_hide_the_times_and_paused_is_not_playing() {
        let page = r#"{"title":"Song","artist":"Band","position":5,"duration":15,"paused":true,"ad":true}"#;
        let t = &parse_tabs(&tab("https://www.youtube.com/watch?v=1", "x", Some(page)))[0];
        let (track, playing) = tab_track(&CHROME, t).unwrap();
        assert_eq!(playing, Some(false));
        assert!(!track.is_playing);
        assert_eq!((track.position_ms, track.duration_ms), (None, None));
    }

    #[test]
    fn cleans_tab_titles() {
        assert_eq!(clean_tab_title("(3) Song - YouTube"), "Song");
        assert_eq!(clean_tab_title("(99+) Song - YouTube"), "Song");
        assert_eq!(clean_tab_title("(Live) Song - YouTube"), "(Live) Song");
        assert_eq!(clean_tab_title("Song - YouTube Music"), "Song");
        assert_eq!(clean_tab_title("Artist - Song - YouTube"), "Artist - Song");
    }

    #[test]
    fn control_scripts_for_youtube() {
        assert!(control_js("playpause", None).unwrap().contains("v.play()"));
        assert!(control_js("seek", Some(61_500.0)).unwrap().contains("v.currentTime=61.500"));
        assert!(control_js("volume", Some(140.0)).unwrap().contains("v.volume=1.00"));
        assert!(control_js("next", None).unwrap().contains(".ytp-next-button"));
        assert!(control_js("previous", None).unwrap().contains("v.currentTime=0"));
        assert_eq!(control_js("seek", None), None);
        assert_eq!(control_js("shuffle", None), None);
        for a in ["playpause", "next", "previous"] {
            assert!(!control_js(a, Some(1.0)).unwrap().contains('"'), "{a}");
        }
    }

    #[test]
    fn explains_how_to_allow_javascript() {
        let err = "Executing JavaScript through AppleScript is turned off. (12)";
        assert!(javascript_off_hint(&CHROME, err).unwrap().contains("View → Developer"));
        assert!(javascript_off_hint(&SAFARI, err).unwrap().contains("Develop → Allow JavaScript"));
        assert_eq!(javascript_off_hint(&CHROME, "Can't get window 1"), None);
    }
}
