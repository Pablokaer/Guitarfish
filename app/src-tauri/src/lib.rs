mod localaudio;
mod songkey;
mod songsterr;

/// Layout commands offered in the native menu. Their accelerators also work while
/// the embedded Songsterr page has keyboard focus, which DOM key handlers in the
/// main webview never see. The id after `layout:` is sent to the UI as-is.
#[cfg(target_os = "macos")]
const LAYOUT_ITEMS: &[(&str, &str, &str)] = &[
    ("layout:focus", "Focus Mode", "CmdOrCtrl+Shift+F"),
    ("layout:nav", "Show/Hide Navigation Sidebar", "CmdOrCtrl+1"),
    ("layout:nav-compact", "Compact Navigation Sidebar", "CmdOrCtrl+Shift+1"),
    ("layout:player", "Expand/Collapse Spotify Player", "CmdOrCtrl+2"),
    ("layout:player-hide", "Show/Hide Spotify Player", "CmdOrCtrl+Shift+2"),
    ("layout:tools", "Show/Hide Tools Sidebar", "CmdOrCtrl+3"),
    ("layout:toolbar", "Show/Hide Toolbar", "CmdOrCtrl+4"),
    ("layout:search", "Search Tabs", "CmdOrCtrl+K"),
];

#[cfg(target_os = "macos")]
fn layout_menu<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    let h = app.handle();
    let menu = Menu::default(h)?;
    let layout = Submenu::new(h, "Layout", true)?;
    for (i, (id, label, accel)) in LAYOUT_ITEMS.iter().enumerate() {
        if i == 1 || i == 7 {
            layout.append(&PredefinedMenuItem::separator(h)?)?;
        }
        layout.append(&MenuItem::with_id(h, *id, *label, true, Some(*accel))?)?;
    }
    // Default macOS menu: App, File, Edit, View, Window, Help. Put Layout after View.
    menu.insert(&layout, 4)?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_nowplaying::init())
        .invoke_handler(tauri::generate_handler![
            songsterr::songsterr_search,
            songkey::song_key,
            localaudio::local_audio_open,
            localaudio::local_audio_read
        ])
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            layout_menu(_app)?;
            Ok(())
        });
    // In-app updates and the relaunch after them, and the file picker of the music
    // library, are desktop only (Android picks files with the webview's own input).
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init());
    // Menus exist on desktop only (the Android build has no on_menu_event).
    #[cfg(desktop)]
    let builder = builder.on_menu_event(|app, event| {
        use tauri::Emitter;
        if let Some(cmd) = event.id().0.strip_prefix("layout:") {
            let _ = app.emit_to("main", "layout-command", cmd);
        }
    });
    builder.run(tauri::generate_context!()).expect("error while running Guitarfish");
}
