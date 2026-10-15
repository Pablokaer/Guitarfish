const COMMANDS: &[&str] = &["get_now_playing", "check_permission", "request_permission", "control", "get_capabilities"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
