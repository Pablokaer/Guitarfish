/** Per-device settings, kept in the webview's localStorage. */
export interface Settings {
  serverUrl: string;
  followOffsetSec: number;
  /** Local (alphaTab) tab: scroll to and highlight the bar being played. */
  follow: boolean;
  zoom: number;
  /** Show Songsterr in the viewer (desktop). False shows the local catalogue tab. */
  songsterrPanel: boolean;
  /** Open the tab of each new song automatically. Off: search, but leave the page alone. */
  followSpotify: boolean;
  /** Search Songsterr when the song changes. Off: only on request. */
  autoSearch: boolean;
  theme: "graphite" | "midnight";
  /** Bumped when a default changes meaning; see loadSettings. */
  version: number;
}

const KEY = "tabsync.settings";
const VERSION = 2;

function defaultServerUrl(): string {
  // Android emulator reaches the host machine through 10.0.2.2.
  return /android/i.test(navigator.userAgent) ? "http://10.0.2.2:8787" : "http://127.0.0.1:8787";
}

export function defaultSettings(): Settings {
  return {
    serverUrl: defaultServerUrl(),
    followOffsetSec: 0,
    follow: true,
    zoom: 1,
    songsterrPanel: true,
    followSpotify: true,
    autoSearch: true,
    theme: "graphite",
    version: VERSION,
  };
}

export function parseSettings(raw: unknown): Settings {
  const defaults = defaultSettings();
  if (!raw || typeof raw !== "object") return defaults;
  const stored = raw as Partial<Settings>;
  const s: Settings = { ...defaults, ...stored };
  // v1 opened the local tab by default and Songsterr on request. Songsterr is now
  // the main viewer, so start there once; the user can still switch back.
  if (!((stored.version ?? 1) >= 2)) s.songsterrPanel = true;
  if (s.theme !== "graphite" && s.theme !== "midnight") s.theme = defaults.theme;
  s.version = VERSION;
  return s;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return parseSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings last for this session only */
  }
}
