//! Songsterr catalogue search, run natively: the webview can't call songsterr.com
//! itself (no CORS headers). Songsterr has no official API; this uses the public
//! search endpoint their site calls, and only returns links. Tab content stays on
//! Songsterr (their terms don't allow copying it), so the app opens it there.

use serde::Serialize;

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

/// Stable link: Songsterr redirects it to the song's canonical page.
pub fn song_url(_song_id: u64) -> String {
    todo!()
}

/// The query to send: trimmed and capped in length. None when there is nothing to search.
pub fn clean_query(_query: &str) -> Option<String> {
    todo!()
}

/// Songsterr's JSON answer as results: junk entries dropped, instruments listed once.
pub fn parse_results(_body: &str) -> Result<Vec<SongsterrResult>, String> {
    todo!()
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
}
