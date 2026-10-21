use serde::{Deserialize, Serialize};

/// The currently playing track, as reported by the OS.
/// Field names are camelCase on the wire; the Kotlin side uses the same keys.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    /// Playback position at the moment of the read (already extrapolated).
    #[serde(default)]
    pub position_ms: Option<u64>,
    pub is_playing: bool,
    /// Bare Spotify track ID (no `spotify:track:` prefix) when the OS exposes it.
    #[serde(default)]
    pub spotify_id: Option<String>,
    /// Player volume, 0–100, when the OS exposes it (macOS, Linux).
    #[serde(default)]
    pub volume: Option<u8>,
    /// Album artwork URL, when the OS exposes it (macOS).
    #[serde(default)]
    pub artwork_url: Option<String>,
    /// "os" for device detectors.
    pub source: String,
    /// Which player reported it, e.g. "Spotify (macOS)" or "YouTube (Chrome, macOS)".
    pub player: String,
    /// "spotify" | "youtube" | "youtube-music" | "browser" (media in a browser whose
    /// site the OS doesn't tell): see `sources::Service`.
    #[serde(default)]
    pub service: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingResponse {
    #[serde(default)]
    pub track: Option<Track>,
}

/// Which playback controls this platform can drive.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackCapabilities {
    /// Play/pause, previous, next.
    pub transport: bool,
    pub seek: bool,
    pub volume: bool,
    /// The plugin emits `nowplaying://changed` when the track or play state
    /// changes, so the UI can refresh at once instead of waiting for its next poll.
    #[serde(default)]
    pub events: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponse {
    pub granted: bool,
}

/// `spotify:track:abc` -> `abc`. Returns None for ads/episodes/local files.
pub fn spotify_track_id(uri: &str) -> Option<String> {
    uri.strip_prefix("spotify:track:").filter(|id| !id.is_empty()).map(str::to_string)
}
