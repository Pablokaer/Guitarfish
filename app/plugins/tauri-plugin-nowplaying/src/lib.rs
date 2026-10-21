//! Now-playing detector: Spotify, YouTube and YouTube Music, in their apps or in a
//! browser. When several play, `sources::pick` chooses: a playing one first, and
//! among equals YouTube.
//!
//! * macOS   – AppleScript: the Spotify app, and the YouTube tabs of the running
//!   browsers (`browser.rs`), whose pages report position and state when the
//!   browser allows JavaScript from Apple Events.
//! * Windows – Global System Media Transport Controls (SMTC), the API behind the
//!   media overlay: Spotify, the browsers and the YouTube (Music) apps.
//! * Linux   – MPRIS over the D-Bus session bus: Spotify, the browsers and the
//!   YouTube Music desktop app.
//! * Android – `MediaSessionManager` through a `NotificationListenerService`
//!   (Kotlin, see `android/`): Spotify, YouTube, YouTube Music and the browsers.
//!   The user grants notification access once.
//!
//! All platforms expose the same command: `plugin:nowplaying|get_now_playing`.
//! `control` drives the reported player (play/pause, skip, seek, volume) where the
//! OS allows it; `get_capabilities` tells the UI which of those controls to show.
//!
//! Where the OS announces changes (macOS: Spotify's distributed notification;
//! Linux: MPRIS `PropertiesChanged`), the plugin also emits [`CHANGED_EVENT`] to
//! the app, with no payload; the UI should then call `get_now_playing` right away.
//! `get_capabilities` reports `events: true` only where every followed player
//! signals (Linux), so the app may poll less often there.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

mod commands;
mod error;
pub mod models;
// Which players count and which one wins: used by the desktop detectors (the
// Kotlin plugin mirrors it), tested on every OS.
#[cfg(any(test, desktop))]
mod sources;
// YouTube tabs in macOS browsers (AppleScript): used on macOS, tested on every OS.
#[cfg(any(test, target_os = "macos"))]
mod browser;
// Pure MPRIS mapping: used by the Linux detector, tested on every OS.
#[cfg(any(
    test,
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
mod mpris;

#[cfg(desktop)]
pub mod desktop;
#[cfg(mobile)]
mod mobile;

pub use error::{Error, Result};

/// App-wide event emitted when the player's track or state changes.
pub const CHANGED_EVENT: &str = "nowplaying://changed";

#[cfg(mobile)]
pub use mobile::NowPlaying;

/// Access the mobile plugin handle from any `Manager`.
#[cfg(mobile)]
pub trait NowPlayingExt<R: Runtime> {
    fn now_playing(&self) -> &NowPlaying<R>;
}

#[cfg(mobile)]
impl<R: Runtime, T: tauri::Manager<R>> NowPlayingExt<R> for T {
    fn now_playing(&self) -> &NowPlaying<R> {
        self.state::<NowPlaying<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("nowplaying")
        .invoke_handler(tauri::generate_handler![
            commands::get_now_playing,
            commands::check_permission,
            commands::request_permission,
            commands::control,
            commands::get_capabilities
        ])
        .setup(|_app, _api| {
            #[cfg(desktop)]
            desktop::start_events(_app);
            #[cfg(mobile)]
            {
                use tauri::Manager;
                let np = mobile::init(_app, _api)?;
                _app.manage(np);
            }
            Ok(())
        })
        .build()
}
