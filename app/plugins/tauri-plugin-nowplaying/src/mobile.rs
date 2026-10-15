use serde::{de::DeserializeOwned, Serialize};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::{NowPlayingResponse, PermissionResponse, PlaybackCapabilities};

#[cfg(target_os = "ios")]
compile_error!("tauri-plugin-nowplaying: iOS is not supported (iOS does not expose other apps' now-playing info).");

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.tabsync.nowplaying";

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<NowPlaying<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "NowPlayingPlugin")?;
    Ok(NowPlaying(handle))
}

/// Handle to the Kotlin `NowPlayingPlugin`.
pub struct NowPlaying<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> NowPlaying<R> {
    pub fn get_now_playing(&self) -> crate::Result<NowPlayingResponse> {
        self.0.run_mobile_plugin("getNowPlaying", ()).map_err(Into::into)
    }

    pub fn check_permission(&self) -> crate::Result<PermissionResponse> {
        self.0.run_mobile_plugin("checkPermission", ()).map_err(Into::into)
    }

    pub fn request_permission(&self) -> crate::Result<PermissionResponse> {
        self.0.run_mobile_plugin("requestPermission", ()).map_err(Into::into)
    }

    /// See `commands::control`. Android supports transport and seek.
    pub fn control(&self, action: String, value: Option<f64>) -> crate::Result<()> {
        self.0.run_mobile_plugin("control", ControlArgs { action, value }).map_err(Into::into)
    }

    pub fn get_capabilities(&self) -> crate::Result<PlaybackCapabilities> {
        self.0.run_mobile_plugin("getCapabilities", ()).map_err(Into::into)
    }
}

/// `{ action, value }`, the same payload the desktop `control` command takes.
#[derive(Serialize)]
struct ControlArgs {
    action: String,
    value: Option<f64>,
}
