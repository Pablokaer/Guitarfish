fn main() {
    // Declaring the app's own commands makes them need a permission, like plugin
    // commands: only the windows whose capabilities grant `allow-songsterr-search`,
    // `allow-song-key`, `allow-local-audio-open` and `allow-local-audio-read` (the
    // main window, see capabilities/default.json) can call them, never the Songsterr
    // pages in child webviews.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "songsterr_search",
        "song_key",
        "local_audio_open",
        "local_audio_read",
    ])))
    .expect("failed to run tauri-build");
}
