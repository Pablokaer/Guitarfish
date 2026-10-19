//! Looks up the key of a recording, for the Solos view. ReccoBeats serves the audio
//! features Spotify computed for each track (key, mode, tempo), by Spotify track id
//! or by ISRC. When the player gives no Spotify id (Windows), the ISRC comes from a
//! Deezer search on title and artist. Neither service needs an API key; both are
//! called natively because Deezer sends no CORS headers. Only the song's title,
//! artist and id leave the device.

use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use std::time::Duration;

const DEEZER_SEARCH: &str = "https://api.deezer.com/search";
const FEATURES_URL: &str = "https://api.reccobeats.com/v1/audio-features";
const TIMEOUT: Duration = Duration::from_secs(6);
/// Deezer results looked at, and recordings sent to ReccoBeats at most.
const SEARCH_RESULTS: &str = "15";
const MAX_IDS: usize = 5;
/// Versions that are another recording: skipped unless the playing title says so too.
const OTHER_VERSIONS: &[&str] =
    &["live", "remix", "acoustic", "instrumental", "karaoke", "cover", "demo", "edit", "version", "mix"];

/// The key of a recording. Same shape as `SongKeyAnswer` in the UI (`app/src/songkey.ts`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongKey {
    /// Pitch class of the tonic, 0 = C … 11 = B.
    pub tonic: u8,
    /// "major" or "minor".
    pub mode: &'static str,
    /// Beats per minute, when known.
    pub tempo: Option<f64>,
    /// How the recording was found: "spotify-id" or "isrc".
    pub via: &'static str,
}

/// Lower case letters and digits only, words separated by one space.
pub fn normalize(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn has_word(haystack: &str, word: &str) -> bool {
    haystack.split(' ').any(|w| w == word)
}

#[derive(Deserialize)]
struct DeezerAnswer {
    #[serde(default)]
    data: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct DeezerTrack {
    #[serde(default)]
    title: String,
    #[serde(default)]
    title_short: String,
    #[serde(default)]
    isrc: Option<String>,
    artist: DeezerArtist,
}

#[derive(Deserialize)]
struct DeezerArtist {
    name: String,
}

/// ISRCs of the Deezer results that are this song by this artist, best first: the
/// title must match (ignoring brackets and punctuation), the artist must match, and
/// live, remix, acoustic… versions are skipped unless the title asks for one.
pub fn deezer_isrcs(body: &str, title: &str, artist: &str) -> Result<Vec<String>, String> {
    let answer: DeezerAnswer = serde_json::from_str(body).map_err(|e| format!("unexpected answer from Deezer: {e}"))?;
    let want_title = normalize(title);
    let want_artist = normalize(artist);
    if want_title.is_empty() || want_artist.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for v in answer.data {
        let Ok(t) = serde_json::from_value::<DeezerTrack>(v) else { continue };
        let Some(isrc) = t.isrc.filter(|i| !i.trim().is_empty()) else { continue };
        let short = normalize(if t.title_short.is_empty() { &t.title } else { &t.title_short });
        let full = normalize(&t.title);
        let by = normalize(&t.artist.name);
        let title_ok = short == want_title || full == want_title;
        let artist_ok = by == want_artist || by.contains(&want_artist) || want_artist.contains(&by);
        let other_version = OTHER_VERSIONS.iter().any(|w| has_word(&full, w) && !has_word(&want_title, w));
        if title_ok && artist_ok && !other_version && !out.contains(&isrc) {
            out.push(isrc);
        }
        if out.len() == MAX_IDS {
            break;
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
struct FeaturesAnswer {
    #[serde(default)]
    content: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct Features {
    #[serde(default)]
    href: Option<String>,
    #[serde(default)]
    isrc: Option<String>,
    key: i32,
    mode: i32,
    #[serde(default)]
    tempo: Option<f64>,
}

/// The key of the first of `ids` (Spotify ids or ISRCs, best first) that ReccoBeats
/// knows. A key of -1 (Spotify couldn't tell) counts as unknown.
pub fn pick_key(body: &str, ids: &[String], via: &'static str) -> Result<Option<SongKey>, String> {
    let answer: FeaturesAnswer =
        serde_json::from_str(body).map_err(|e| format!("unexpected answer from ReccoBeats: {e}"))?;
    let features: Vec<Features> = answer.content.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect();
    for id in ids {
        let hit = features.iter().find(|f| {
            f.isrc.as_deref().is_some_and(|i| i.eq_ignore_ascii_case(id))
                || f.href.as_deref().is_some_and(|h| h.rsplit('/').next() == Some(id.as_str()))
        });
        if let Some(f) = hit {
            if (0..12).contains(&f.key) {
                return Ok(Some(SongKey {
                    tonic: f.key as u8,
                    mode: if f.mode == 1 { "major" } else { "minor" },
                    tempo: f.tempo.filter(|t| *t > 0.0),
                    via,
                }));
            }
        }
    }
    Ok(None)
}

/// A Spotify track id is 22 base-62 characters; anything else is not sent.
pub fn valid_spotify_id(id: &str) -> bool {
    id.len() == 22 && id.chars().all(|c| c.is_ascii_alphanumeric())
}

static AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .https_only(true)
        .user_agent(concat!("Guitarfish/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
});

fn get(url: &str, query: &[(&str, &str)]) -> Result<String, String> {
    AGENT
        .get(url)
        .query_pairs(query.iter().copied())
        .call()
        .and_then(|mut res| res.body_mut().read_to_string())
        .map_err(|e| format!("key lookup failed: {e}"))
}

fn features(ids: &[String], via: &'static str) -> Result<Option<SongKey>, String> {
    if ids.is_empty() {
        return Ok(None);
    }
    pick_key(&get(FEATURES_URL, &[("ids", &ids.join(","))])?, ids, via)
}

fn lookup(title: &str, artist: &str, spotify_id: Option<&str>) -> Result<Option<SongKey>, String> {
    if let Some(id) = spotify_id.filter(|id| valid_spotify_id(id)) {
        if let Some(k) = features(&[id.to_string()], "spotify-id")? {
            return Ok(Some(k));
        }
    }
    let query = format!("{artist} {title}");
    let isrcs = deezer_isrcs(&get(DEEZER_SEARCH, &[("q", query.trim()), ("limit", SEARCH_RESULTS)])?, title, artist)?;
    features(&isrcs, "isrc")
}

/// The key of a song: by its Spotify id when given, otherwise (or when that's not
/// known) by title and artist. `Ok(None)` when no matching recording has a key;
/// network and service failures come back as a message.
#[tauri::command]
pub async fn song_key(title: String, artist: String, spotify_id: Option<String>) -> Result<Option<SongKey>, String> {
    let (title, artist) = (title.trim().to_string(), artist.trim().to_string());
    if title.is_empty() || artist.is_empty() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || lookup(&title, &artist, spotify_id.as_deref()))
        .await
        .map_err(|e| format!("key lookup failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEEZER: &str = r#"{"data":[
      {"title":"Mr. Brightside (Live From The Royal Albert Hall / 2009)","title_short":"Mr. Brightside","isrc":"LIVE1","artist":{"name":"The Killers"}},
      {"title":"Mr. Brightside","title_short":"Mr. Brightside","isrc":"USIR20400274","artist":{"name":"The Killers"}},
      {"title":"Mr. Brightside","title_short":"Mr. Brightside","isrc":"COVER1","artist":{"name":"Some Cover Band"}},
      {"title":"Mr. Brightside (Jacques Lu Cont's Thin White Duke Remix)","title_short":"Mr. Brightside","isrc":"REMIX1","artist":{"name":"The Killers"}},
      {"title":"Mr. Brightside","title_short":"Mr. Brightside","isrc":"USIR20400274","artist":{"name":"The Killers"}},
      {"title":"Somebody Told Me","title_short":"Somebody Told Me","isrc":"OTHER","artist":{"name":"The Killers"}},
      {"title":"Mr. Brightside","title_short":"Mr. Brightside","artist":{"name":"The Killers"}},
      {"title":"no artist"}
    ]}"#;

    #[test]
    fn normalizes_titles() {
        assert_eq!(normalize("  Mr. Brightside!! "), "mr brightside");
        assert_eq!(normalize("Ação & Reação"), "ação reação");
    }

    #[test]
    fn keeps_only_the_song_by_the_artist_once() {
        assert_eq!(deezer_isrcs(DEEZER, "Mr. Brightside", "The Killers").unwrap(), vec!["USIR20400274".to_string()]);
    }

    #[test]
    fn keeps_a_live_version_when_asked_for() {
        let body = r#"{"data":[{"title":"Song (Live)","title_short":"Song","isrc":"L","artist":{"name":"A"}},
                               {"title":"Song (Live)","title_short":"Song (Live)","isrc":"L2","artist":{"name":"A"}}]}"#;
        assert_eq!(deezer_isrcs(body, "Song (Live)", "A").unwrap(), vec!["L".to_string(), "L2".to_string()]);
        assert!(deezer_isrcs(body, "Song", "A").unwrap().is_empty());
    }

    #[test]
    fn accepts_an_artist_listed_with_others() {
        let body = r#"{"data":[{"title":"Under Pressure","isrc":"Q","artist":{"name":"Queen & David Bowie"}}]}"#;
        assert_eq!(deezer_isrcs(body, "Under Pressure", "Queen").unwrap(), vec!["Q".to_string()]);
    }

    #[test]
    fn rejects_a_deezer_answer_that_is_not_json() {
        assert!(deezer_isrcs("<html>", "a", "b").is_err());
        assert!(deezer_isrcs(r#"{"error":{"code":4}}"#, "a", "b").unwrap().is_empty());
    }

    const FEATURES: &str = r#"{"content":[
      {"href":"https://open.spotify.com/track/0wCFkNN8T01YFMwQ5h6Uj1","isrc":"USIR20400274","key":1,"mode":1,"tempo":148.104},
      {"href":"https://open.spotify.com/track/xxxxxxxxxxxxxxxxxxxxxx","isrc":"UNKNOWNKEY","key":-1,"mode":0,"tempo":90.0},
      {"href":"https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp","isrc":"GBFFP0300052","key":9,"mode":0,"tempo":0}
    ]}"#;

    #[test]
    fn picks_the_first_known_id_in_order() {
        let ids = vec!["UNKNOWNKEY".to_string(), "missing".to_string(), "usir20400274".to_string()];
        assert_eq!(
            pick_key(FEATURES, &ids, "isrc").unwrap(),
            Some(SongKey { tonic: 1, mode: "major", tempo: Some(148.104), via: "isrc" })
        );
    }

    #[test]
    fn matches_a_spotify_id_from_the_link() {
        let k = pick_key(FEATURES, &["3n3Ppam7vgaVa1iaRUc9Lp".to_string()], "spotify-id").unwrap().unwrap();
        assert_eq!((k.tonic, k.mode, k.tempo), (9, "minor", None));
    }

    #[test]
    fn nothing_known_is_none() {
        assert_eq!(pick_key(r#"{"content":[]}"#, &["x".to_string()], "isrc").unwrap(), None);
        assert!(pick_key("nope", &[], "isrc").is_err());
    }

    #[test]
    fn checks_spotify_ids() {
        assert!(valid_spotify_id("3n3Ppam7vgaVa1iaRUc9Lp"));
        assert!(!valid_spotify_id("3n3Ppam7vgaVa1iaRUc9L"));
        assert!(!valid_spotify_id("3n3Ppam7vgaVa1iaRUc9L,"));
    }

    #[test]
    fn serializes_like_the_ui_type() {
        let k = SongKey { tonic: 4, mode: "minor", tempo: Some(120.0), via: "isrc" };
        assert_eq!(
            serde_json::to_value(k).unwrap(),
            serde_json::json!({"tonic": 4, "mode": "minor", "tempo": 120.0, "via": "isrc"})
        );
    }

    /// Calls Deezer and ReccoBeats: `cargo test -- --ignored live_key` (needs the network).
    #[test]
    #[ignore]
    fn live_key_of_mr_brightside() {
        let k = tauri::async_runtime::block_on(song_key("Mr. Brightside".into(), "The Killers".into(), None)).unwrap();
        assert_eq!(k.map(|k| (k.tonic, k.mode)), Some((1, "major")));
    }
}
