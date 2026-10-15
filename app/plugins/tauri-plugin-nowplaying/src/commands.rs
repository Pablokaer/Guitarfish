use tauri::{command, AppHandle, Runtime};

use crate::models::{NowPlayingResponse, PermissionResponse, PlaybackCapabilities};
use crate::Result;

/// Returns the currently playing track, or `{ track: null }`.
/// The frontend polls this about once per second.
#[command]
pub(crate) async fn get_now_playing<R: Runtime>(app: AppHandle<R>) -> Result<NowPlayingResponse> {
    platform_get(app).await
}

#[command]
pub(crate) async fn check_permission<R: Runtime>(app: AppHandle<R>) -> Result<PermissionResponse> {
    platform_check(app)
}

#[command]
pub(crate) async fn request_permission<R: Runtime>(app: AppHandle<R>) -> Result<PermissionResponse> {
    platform_request(app)
}

/// Drives the player. `action`: "playpause" | "next" | "previous" | "seek"
/// (`value` = position in ms) | "volume" (`value` = 0–100).
#[command]
pub(crate) async fn control<R: Runtime>(app: AppHandle<R>, action: String, value: Option<f64>) -> Result<()> {
    platform_control(app, action, value).await
}

/// Which controls `control` supports on this platform, and whether the plugin
/// emits `nowplaying://changed` (`events`).
#[command]
pub(crate) async fn get_capabilities<R: Runtime>(app: AppHandle<R>) -> Result<PlaybackCapabilities> {
    platform_capabilities(app)
}

// ---- Desktop: reads can block briefly (osascript / WinRT / D-Bus), so run them off the async pool.
#[cfg(desktop)]
async fn platform_get<R: Runtime>(_app: AppHandle<R>) -> Result<NowPlayingResponse> {
    tauri::async_runtime::spawn_blocking(crate::desktop::read_now_playing)
        .await
        .map_err(|e| crate::Error::Detector(e.to_string()))?
}

#[cfg(desktop)]
fn platform_check<R: Runtime>(_app: AppHandle<R>) -> Result<PermissionResponse> {
    // macOS asks for Automation access on the first read; Windows needs nothing.
    Ok(PermissionResponse { granted: true })
}

#[cfg(desktop)]
fn platform_request<R: Runtime>(app: AppHandle<R>) -> Result<PermissionResponse> {
    platform_check(app)
}

#[cfg(desktop)]
async fn platform_control<R: Runtime>(_app: AppHandle<R>, action: String, value: Option<f64>) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || crate::desktop::control(&action, value))
        .await
        .map_err(|e| crate::Error::Detector(e.to_string()))?
}

#[cfg(desktop)]
fn platform_capabilities<R: Runtime>(_app: AppHandle<R>) -> Result<PlaybackCapabilities> {
    Ok(crate::desktop::capabilities())
}

// ---- Mobile: forward to the Kotlin plugin.
#[cfg(mobile)]
async fn platform_get<R: Runtime>(app: AppHandle<R>) -> Result<NowPlayingResponse> {
    use crate::NowPlayingExt;
    app.now_playing().get_now_playing()
}

#[cfg(mobile)]
fn platform_check<R: Runtime>(app: AppHandle<R>) -> Result<PermissionResponse> {
    use crate::NowPlayingExt;
    app.now_playing().check_permission()
}

#[cfg(mobile)]
fn platform_request<R: Runtime>(app: AppHandle<R>) -> Result<PermissionResponse> {
    use crate::NowPlayingExt;
    app.now_playing().request_permission()
}

// Android: Spotify's MediaController.transportControls (transport and seek).
#[cfg(mobile)]
async fn platform_control<R: Runtime>(app: AppHandle<R>, action: String, value: Option<f64>) -> Result<()> {
    use crate::NowPlayingExt;
    app.now_playing().control(action, value)
}

#[cfg(mobile)]
fn platform_capabilities<R: Runtime>(app: AppHandle<R>) -> Result<PlaybackCapabilities> {
    use crate::NowPlayingExt;
    app.now_playing().get_capabilities()
}
