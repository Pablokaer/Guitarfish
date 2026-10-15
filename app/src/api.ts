import type { LookupResponse, Song, SongsterrResult, TabInfo, Track } from "./types";

const LOOKUP_CACHE_PREFIX = "tabsync.lookup.";
const LOOKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Client for the Guitarfish server ("our system"), with a small local cache. */
export class TabApi {
  private tabContent = new Map<number, { format: TabInfo["format"]; data: ArrayBuffer }>();

  constructor(private baseUrl: string) {}

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/+$/, "");
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, init);
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
    return res.json() as Promise<T>;
  }

  health(): Promise<{ ok: boolean }> {
    return this.json("/health");
  }

  /** Look up tabs for a track. Confident matches are cached on the device. */
  async lookup(t: Track): Promise<LookupResponse> {
    const key = trackKey(t);
    const cached = readCache(key);
    if (cached) return { match: cached, confidence: 1, method: "external-id", candidates: [cached] };

    const q = new URLSearchParams({ title: t.title, artist: t.artist });
    if (t.durationMs) q.set("durationMs", String(t.durationMs));
    if (t.spotifyId) q.set("spotifyId", t.spotifyId);
    const r = await this.json<LookupResponse>(`/v1/tabs/lookup?${q}`);
    if (r.match) writeCache(key, r.match);
    return r;
  }

  search(text: string): Promise<{ results: Song[] }> {
    return this.json(`/v1/songs?${new URLSearchParams({ q: text })}`);
  }

  async songsterrSearch(text: string): Promise<SongsterrResult[]> {
    return (await this.json<{ results: SongsterrResult[] }>(`/v1/songsterr/search?${new URLSearchParams({ q: text })}`))
      .results;
  }

  /** User picked a song for this track: remember it locally and on the server. */
  async confirm(t: Track, song: Song): Promise<void> {
    writeCache(trackKey(t), song);
    if (t.spotifyId) {
      await this.json(`/v1/songs/${song.id}/external-ids`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "spotify", externalId: t.spotifyId }),
      });
    }
  }

  async tab(tab: TabInfo): Promise<{ format: TabInfo["format"]; data: ArrayBuffer }> {
    const hit = this.tabContent.get(tab.id);
    if (hit) return hit;
    const res = await fetch(`${this.baseUrl}/v1/tabs/${tab.id}/content`);
    if (!res.ok) throw new Error(`tab ${tab.id} → ${res.status}`);
    const format = (res.headers.get("X-Tab-Format") as TabInfo["format"]) ?? tab.format;
    const value = { format, data: await res.arrayBuffer() };
    this.tabContent.set(tab.id, value);
    return value;
  }
}

/** Stable identity of a track: the Spotify ID when known, else artist + title. */
export function trackKey(t: Pick<Track, "title" | "artist" | "spotifyId">): string {
  if (t.spotifyId) return `sp:${t.spotifyId}`;
  return `at:${t.artist.toLowerCase().trim()}|${t.title.toLowerCase().trim()}`;
}

function readCache(key: string): Song | null {
  try {
    const raw = localStorage.getItem(LOOKUP_CACHE_PREFIX + key);
    if (!raw) return null;
    const { at, song } = JSON.parse(raw) as { at: number; song: Song };
    return Date.now() - at < LOOKUP_TTL_MS ? song : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, song: Song): void {
  try {
    localStorage.setItem(LOOKUP_CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), song }));
  } catch {
    /* ignore */
  }
}

export function clearCachedLookup(t: Track): void {
  try {
    localStorage.removeItem(LOOKUP_CACHE_PREFIX + trackKey(t));
  } catch {
    /* ignore */
  }
}
