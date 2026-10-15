//! Songsterr catalogue search, run natively: the webview can't call songsterr.com
//! itself (no CORS headers). Songsterr has no official API; this uses the public
//! search endpoint their site calls, and only returns links. Tab content stays on
//! Songsterr (their terms don't allow copying it), so the app opens it there.

use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use std::time::Duration;

const SEARCH_URL: &str = "https://www.songsterr.com/api/songs";
const TIMEOUT: Duration = Duration::from_secs(5);
/// Results asked of Songsterr per search.
const RESULTS: &str = "5";
/// Longer queries are cut to this many characters.
const MAX_QUERY_CHARS: usize = 200;

/// A song in Songsterr's catalogue: only a link, the tab itself stays on Songsterr.
/// Same shape as `SongsterrResult` in the UI (`app/src/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongsterrResult {
    pub song_id: u64,
    pub title: String,
    pub artist: String,
    pub instruments: Vec<String>,
    pub url: String,
}

/// One entry of Songsterr's answer, as far as Guitarfish uses it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSong {
    song_id: u64,
    title: String,
    artist: String,
    #[serde(default)]
    is_junk: Option<bool>,
    #[serde(default)]
    tracks: Vec<RawTrack>,
}

#[derive(Deserialize)]
struct RawTrack {
    #[serde(default)]
    instrument: Option<String>,
}

/// Stable link: Songsterr redirects it to the song's canonical page.
pub fn song_url(song_id: u64) -> String {
    format!("https://www.songsterr.com/a/wa/song?id={song_id}")
}

/// The query to send: trimmed and capped in length. None when there is nothing to search.
pub fn clean_query(query: &str) -> Option<String> {
    let q = query.trim();
    (!q.is_empty()).then(|| q.chars().take(MAX_QUERY_CHARS).collect())
}

/// Songsterr's JSON answer as results: junk entries dropped, instruments listed once.
pub fn parse_results(body: &str) -> Result<Vec<SongsterrResult>, String> {
    let items: Vec<serde_json::Value> =
        serde_json::from_str(body).map_err(|e| format!("unexpected answer from Songsterr: {e}"))?;
    Ok(items
        .into_iter()
        // An entry whose shape Songsterr changed is skipped; the others still count.
        .filter_map(|v| serde_json::from_value::<RawSong>(v).ok())
        .filter(|s| s.is_junk != Some(true))
        .map(|s| {
            let mut instruments: Vec<String> = Vec::new();
            for name in s.tracks.into_iter().filter_map(|t| t.instrument) {
                if !instruments.contains(&name) {
                    instruments.push(name);
                }
            }
            SongsterrResult {
                url: song_url(s.song_id),
                song_id: s.song_id,
                title: s.title,
                artist: s.artist,
                instruments,
            }
        })
        .collect())
}

/// One HTTP client for the app's lifetime (connection reuse, one TLS setup).
static AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .https_only(true)
        .user_agent(concat!("Guitarfish/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
});

/// Blocking request to Songsterr's search: the body of a successful answer.
fn fetch(query: &str) -> Result<String, String> {
    AGENT
        .get(SEARCH_URL)
        .query_pairs([("pattern", query), ("size", RESULTS)])
        .call()
        .and_then(|mut res| res.body_mut().read_to_string())
        .map_err(|e| format!("Songsterr search failed: {e}"))
}

/// Searches Songsterr for `query` (e.g. "Muse Uprising"); an empty query finds nothing.
/// Failures (offline, no answer within 5 s, an HTTP error status, an unexpected
/// answer) come back as a message. The UI then shows Songsterr as unreachable and retries.
#[tauri::command]
pub async fn songsterr_search(query: String) -> Result<Vec<SongsterrResult>, String> {
    let Some(query) = clean_query(&query) else { return Ok(Vec::new()) };
    // ureq is blocking: keep it off the async runtime's worker threads.
    tauri::async_runtime::spawn_blocking(move || parse_results(&fetch(&query)?))
        .await
        .map_err(|e| format!("Songsterr search failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANSWER: &str = r#"[
      {"songId":29482,"artistId":184,"artist":"Muse","title":"Uprising","hasChords":true,
       "tracks":[{"instrumentId":30,"instrument":"Distortion Guitar","views":89342},
                 {"instrumentId":30,"instrument":"Distortion Guitar","views":12},
                 {"instrumentId":38,"instrument":"Synth Bass 1"}]},
      {"songId":1,"title":"Uprising (junk)","artist":"x","isJunk":true,"tracks":[]},
      {"songId":7,"title":"Plug In Baby","artist":"Muse"}
    ]"#;

    #[test]
    fn builds_stable_song_links() {
        assert_eq!(song_url(29482), "https://www.songsterr.com/a/wa/song?id=29482");
    }

    #[test]
    fn parses_links_drops_junk_and_dedupes_instruments() {
        let results = parse_results(ANSWER).unwrap();
        assert_eq!(
            results,
            vec![
                SongsterrResult {
                    song_id: 29482,
                    title: "Uprising".into(),
                    artist: "Muse".into(),
                    instruments: vec!["Distortion Guitar".into(), "Synth Bass 1".into()],
                    url: "https://www.songsterr.com/a/wa/song?id=29482".into(),
                },
                SongsterrResult {
                    song_id: 7,
                    title: "Plug In Baby".into(),
                    artist: "Muse".into(),
                    instruments: vec![],
                    url: "https://www.songsterr.com/a/wa/song?id=7".into(),
                },
            ]
        );
    }

    #[test]
    fn skips_malformed_entries_and_keeps_the_rest() {
        let body = r#"[{"title":"no id","artist":"x"},
                       {"songId":"12","title":"string id","artist":"x"},
                       {"songId":3,"title":"Hysteria","artist":"Muse","isJunk":null,
                        "tracks":[{"instrumentId":1},{"instrument":"Bass"}]}]"#;
        let results = parse_results(body).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].song_id, 3);
        assert_eq!(results[0].instruments, vec!["Bass".to_string()]);
    }

    #[test]
    fn an_empty_list_is_no_results() {
        assert_eq!(parse_results("[]").unwrap(), vec![]);
    }

    #[test]
    fn rejects_an_answer_that_is_not_a_list() {
        assert!(parse_results(r#"{"error":"rate limited"}"#).is_err());
        assert!(parse_results("<html>").is_err());
        assert!(parse_results("").is_err());
    }

    #[test]
    fn serializes_like_the_ui_type() {
        let r = &parse_results(ANSWER).unwrap()[0];
        let json = serde_json::to_value(r).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "songId": 29482,
                "title": "Uprising",
                "artist": "Muse",
                "instruments": ["Distortion Guitar", "Synth Bass 1"],
                "url": "https://www.songsterr.com/a/wa/song?id=29482"
            })
        );
    }

    #[test]
    fn cleans_the_query() {
        assert_eq!(clean_query("  Muse Uprising \n").as_deref(), Some("Muse Uprising"));
        assert_eq!(clean_query("   "), None);
        assert_eq!(clean_query(""), None);
    }

    #[test]
    fn caps_long_queries_on_a_character_boundary() {
        let long = "é".repeat(500);
        let q = clean_query(&long).unwrap();
        assert_eq!(q.chars().count(), 200);
        assert!(q.chars().all(|c| c == 'é'));
    }

    #[test]
    fn an_empty_query_finds_nothing_without_a_request() {
        let r = tauri::async_runtime::block_on(songsterr_search("  ".into()));
        assert_eq!(r, Ok(vec![]));
    }

    /// Calls the real Songsterr: `cargo test -- --ignored live_search` (needs the network).
    #[test]
    #[ignore]
    fn live_search_answers_in_the_expected_shape() {
        let results = tauri::async_runtime::block_on(songsterr_search("Muse Uprising".into())).unwrap();
        let hit = results.iter().find(|r| r.title == "Uprising" && r.artist == "Muse").expect("Uprising by Muse");
        assert_eq!(hit.url, song_url(hit.song_id));
        assert!(!hit.instruments.is_empty());
    }
}
