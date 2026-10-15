/** Per-device settings, kept in the webview's localStorage. */
export interface Settings {
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

export function defaultSettings(): Settings {
  return {
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
  // Only known settings: older versions also saved serverUrl, spotifyFallback and librarySync.
  const s = Object.fromEntries(
    Object.entries(defaults).map(([k, v]) => [k, k in stored ? stored[k as keyof Settings] : v]),
  ) as unknown as Settings;
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

/**
 * Removes what older versions stored for the Guitarfish server: cached lookups
 * (`tabsync.lookup.*`) and the library sync queue (`tabsync.library.*`).
 */
export function dropLegacyStorage(storage: Pick<Storage, "length" | "key" | "removeItem"> = localStorage): void {
  try {
    const legacy: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith("tabsync.lookup.") || k?.startsWith("tabsync.library.")) legacy.push(k);
    }
    for (const k of legacy) storage.removeItem(k);
  } catch {
    /* storage unavailable: nothing to clean */
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings last for this session only */
  }
}
