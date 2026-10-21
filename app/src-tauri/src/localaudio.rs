//! Local MP3 files for the music player (desktop). The library keeps each file's
//! path; the webview streams it through the asset protocol, whose scope starts empty
//! and is opened file by file here: `local_audio_open` checks a file and allows it,
//! `local_audio_read` reads part of an allowed file (its tags, at import). Only
//! `.mp3` files are accepted, and nothing is ever written.

use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, Runtime};

/// The most one `local_audio_read` returns: an ID3 tag with large cover art, plus some audio.
pub const MAX_READ: u64 = 32 * 1024 * 1024;
/// Paths per `local_audio_open` call.
pub const MAX_PATHS: usize = 2000;

/// A file the player may open, or why it can't. Same shape as `OpenedFile` in the UI
/// (`app/src/localfiles.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub path: String,
    pub name: String,
    pub size: Option<u64>,
    pub error: Option<String>,
}

pub fn is_mp3(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("mp3"))
}

/// The file's size if `path` is a readable `.mp3` file, else why not.
pub fn check(path: &Path) -> Result<u64, String> {
    if !is_mp3(path) {
        return Err("not an .mp3 file".into());
    }
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() => Ok(m.len()),
        Ok(_) => Err("not a file".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err("the file is no longer there".into()),
        Err(e) => Err(format!("can't read the file: {e}")),
    }
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Up to `len` bytes of `path` from `offset` (capped at MAX_READ; fewer at the end).
pub fn read_range(path: &Path, offset: u64, len: u64) -> Result<Vec<u8>, String> {
    let mut f = File::open(path).map_err(|e| format!("can't open the file: {e}"))?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| format!("can't read the file: {e}"))?;
    let mut buf = Vec::new();
    f.take(len.min(MAX_READ)).read_to_end(&mut buf).map_err(|e| format!("can't read the file: {e}"))?;
    Ok(buf)
}

/// Each path checked (a file past MAX_PATHS is refused, not dropped). `allow` lets
/// the asset protocol serve a file that passed.
pub fn open_files(paths: Vec<String>, allow: impl Fn(&Path) -> Result<(), String>) -> Vec<OpenedFile> {
    paths
        .into_iter()
        .enumerate()
        .map(|(i, p)| {
            let path = Path::new(&p);
            let checked = if i >= MAX_PATHS {
                Err(format!("more than {MAX_PATHS} files at once"))
            } else {
                check(path).and_then(|size| allow(path).map(|()| size))
            };
            OpenedFile { name: file_name(path), size: checked.as_ref().ok().copied(), error: checked.err(), path: p }
        })
        .collect()
}

/// Checks each path and lets the asset protocol serve the files that are fine. The
/// file system is read on a blocking thread, never on the main (window) thread: a
/// slow or sleeping drive must not freeze the window.
#[tauri::command]
pub async fn local_audio_open<R: Runtime>(app: AppHandle<R>, paths: Vec<String>) -> Result<Vec<OpenedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let scope = app.asset_protocol_scope();
        open_files(paths, |path| scope.allow_file(path).map_err(|e| format!("can't open the file: {e}")))
    })
    .await
    .map_err(|e| format!("can't open the files: {e}"))
}

/// Part of a file opened with `local_audio_open`, as raw bytes (read on a blocking thread).
#[tauri::command]
pub async fn local_audio_read<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    offset: u64,
    len: u64,
) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        check(p)?;
        if !app.asset_protocol_scope().is_allowed(p) {
            return Err("the file wasn't opened".into());
        }
        read_range(p, offset, len).map(Response::new)
    })
    .await
    .map_err(|e| format!("can't read the file: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("guitarfish-localaudio-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        File::create(&path).unwrap().write_all(bytes).unwrap();
        path
    }

    #[test]
    fn accepts_only_mp3_names() {
        assert!(is_mp3(Path::new("/m/song.mp3")));
        assert!(is_mp3(Path::new("C:\\Music\\SONG.MP3")));
        assert!(!is_mp3(Path::new("/m/song.mp3.exe")));
        assert!(!is_mp3(Path::new("/etc/passwd")));
        assert!(!is_mp3(Path::new("/m/mp3")));
    }

    #[test]
    fn checks_files() {
        let f = temp_file("check.mp3", &[0xff, 0xfb, 0x90, 0x00]);
        assert_eq!(check(&f), Ok(4));
        assert_eq!(check(&f.with_file_name("missing.mp3")), Err("the file is no longer there".into()));
        let txt = temp_file("notes.txt", b"hello");
        assert_eq!(check(&txt), Err("not an .mp3 file".into()));
        let dir = f.with_file_name("folder.mp3");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(check(&dir), Err("not a file".into()));
    }

    #[test]
    fn reads_ranges() {
        let f = temp_file("range.mp3", &[1, 2, 3, 4, 5, 6]);
        assert_eq!(read_range(&f, 0, 3).unwrap(), vec![1, 2, 3]);
        assert_eq!(read_range(&f, 4, 100).unwrap(), vec![5, 6]);
        assert_eq!(read_range(&f, 10, 4).unwrap(), Vec::<u8>::new());
        assert!(read_range(&f.with_file_name("gone.mp3"), 0, 1).is_err());
    }

    #[test]
    fn serializes_like_the_ui_type() {
        let f = OpenedFile {
            path: "/m/a.mp3".into(),
            name: "a.mp3".into(),
            size: None,
            error: Some("the file is no longer there".into()),
        };
        assert_eq!(
            serde_json::to_value(&f).unwrap(),
            serde_json::json!({ "path": "/m/a.mp3", "name": "a.mp3", "size": null, "error": "the file is no longer there" })
        );
    }

    #[test]
    fn refuses_paths_past_the_limit_instead_of_dropping_them() {
        let f = temp_file("limit.mp3", &[0xff, 0xfb, 0x90, 0x00]);
        let p = f.to_string_lossy().into_owned();
        let out = open_files(vec![p.clone(); MAX_PATHS + 2], |_| Ok(()));
        assert_eq!(out.len(), MAX_PATHS + 2);
        assert_eq!(out[MAX_PATHS - 1].size, Some(4));
        assert_eq!(out[MAX_PATHS].error, Some(format!("more than {MAX_PATHS} files at once")));
        assert_eq!(out[MAX_PATHS + 1].size, None);
    }

    #[test]
    fn reports_files_the_scope_refuses() {
        let f = temp_file("scope.mp3", &[0xff, 0xfb, 0x90, 0x00]);
        let out = open_files(vec![f.to_string_lossy().into_owned(), "/m/notes.txt".into()], |_| Err("denied".into()));
        assert_eq!(out[0].error, Some("denied".into()));
        assert_eq!(out[1].error, Some("not an .mp3 file".into()));
    }

    #[test]
    fn names_files() {
        assert_eq!(file_name(Path::new("/music/a b.mp3")), "a b.mp3");
    }
}
