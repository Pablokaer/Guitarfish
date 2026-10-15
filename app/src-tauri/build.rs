fn main() {
    // Declaring the app's own commands makes them need a permission, like plugin
    // commands: only the windows whose capabilities grant `allow-songsterr-search`
    // (the main window, see capabilities/default.json) can call it, never the
    // Songsterr pages in child webviews.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["songsterr_search"])),
    )
    .expect("failed to run tauri-build");
}
