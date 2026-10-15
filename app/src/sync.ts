import { clearCachedLookup, type TabApi, trackKey } from "./api";
import type { PickStore } from "./library";
import { isConfidentMatch, songsterrQuery, songsterrSearchPage } from "./match";
import type { Settings } from "./settings";
import type { SearchPhase } from "./status";
import type { PlaybackCapabilities, Song, SongsterrResult, Track } from "./types";

export const POLL_MS = 1000;
/**
 * Poll interval when the detector also emits `nowplaying://changed`: changes arrive
 * at once, and the position is extrapolated locally between reads (livePosition).
 */
export const EVENT_POLL_MS = 5000;
export const RETRY_MS = 5000;

/** How often to poll, given the detector's capabilities (unknown: plain polling). */
export function pollIntervalFor(caps: Pick<PlaybackCapabilities, "events"> | null): number {
  return caps?.events === true ? EVENT_POLL_MS : POLL_MS;
}

/** What the sync loop asks of the UI. main.ts implements it with the DOM. */
export interface SyncUi {
  /** Every detector reading (null: nothing playing), before a track change is handled. */
  nowPlaying(track: Track | null): void;
  /** A new track: drop what was shown for the previous one (local tab, highlight). */
  trackChanged(track: Track): void;
  /** The phase changed or a poll finished: refresh the status indicators. */
  status(): void;
  /** Follow Spotify: show this Songsterr page for the playing track (an "auto" open). */
  openSongsterr(r: SongsterrResult): void;
  /** The tab server could not be reached (true), or answered again (false). */
  serverUnreachable(down: boolean): void;
  /** Local catalogue match; `how` is e.g. "exact" or "fuzzy 87%". */
  localMatch(song: Song, how: string): Promise<void> | void;
  /** Not in the local catalogue: offer `candidates`. */
  localMiss(track: Track, candidates: Song[]): void;
  renderStage(): void;
  /** A Songsterr result arrived but was not opened (Follow Spotify off). */
  renderAll(): void;
}

export interface SyncDeps {
  detector: { read(): Promise<Track | null> };
  api: Pick<TabApi, "lookup" | "songsterrSearch">;
  picks: Pick<PickStore, "get" | "set">;
  /** Read on every use, so toggles apply immediately. */
  settings: Pick<Settings, "followSpotify" | "autoSearch">;
  ui: SyncUi;
  /** Clock for position extrapolation. Default: performance.now. */
  now?: () => number;
  /** Drops the device's cached lookup for a track. Default: clearCachedLookup. */
  forgetLookup?: (t: Track) => void;
}

/**
 * Follows the detector and finds the tab for each new track: Songsterr (via the
 * Guitarfish server) and the local catalogue, in parallel. Results that arrive after
 * the track changed are discarded (`seq`).
 */
export class SyncController {
  private _current: Track | null = null; // last detector reading
  private readAt = 0; // when `_current` was read, for smooth progress
  private currentKey: string | null = null; // identity of the track we looked up
  private seq = 0; // discards stale lookups when tracks change quickly
  private _phase: SearchPhase = "idle";
  private _results: SongsterrResult[] = []; // Songsterr search results for the current track
  private _best: SongsterrResult | null = null; // what Guitarfish would show for the current track
  private polling = false;
  private repoll = false; // wake() arrived during a poll: read again after it
  private interval: number | null = null; // poll interval, once started
  private timer: ReturnType<typeof setInterval> | null = null;
  private now: () => number;
  private forgetLookup: (t: Track) => void;

  constructor(private deps: SyncDeps) {
    this.now = deps.now ?? (() => performance.now());
    this.forgetLookup = deps.forgetLookup ?? clearCachedLookup;
  }

  get current(): Track | null {
    return this._current;
  }

  get phase(): SearchPhase {
    return this._phase;
  }

  /** The Songsterr page for the current track: a pick, a match, or the search page. */
  get best(): SongsterrResult | null {
    return this._best;
  }

  get results(): readonly SongsterrResult[] {
    return this._results;
  }

  /** Song position now, advanced locally since the last reading while playing. */
  livePosition(): number | null {
    const c = this._current;
    if (!c || c.positionMs == null) return null;
    const extra = c.isPlaying ? this.now() - this.readAt : 0;
    const pos = c.positionMs + extra;
    return c.durationMs ? Math.min(pos, c.durationMs) : pos;
  }

  /** Optimistic update after a player command, before the next poll confirms it. */
  patchCurrent(patch: Partial<Track>): void {
    if (!this._current) return;
    this._current = { ...this._current, ...patch };
    this.readAt = this.now();
  }

  /** Polls now, then every `intervalMs` (see pollIntervalFor). */
  async start(intervalMs = POLL_MS): Promise<void> {
    await this.poll();
    this.setPollInterval(intervalMs);
  }

  /** Changes the interval of the polling loop (and starts it). */
  setPollInterval(ms: number): void {
    this.interval = ms;
    this.restartTimer();
  }

  private restartTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = this.interval === null ? null : setInterval(() => void this.poll(), this.interval);
  }

  /**
   * The player reported a change (`nowplaying://changed`): read now, and count the
   * next regular poll from here. A poll already reading may predate the change, so
   * another read follows it.
   */
  async wake(): Promise<void> {
    this.restartTimer();
    if (this.polling) {
      this.repoll = true;
      return;
    }
    await this.poll();
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.repoll = false;
    try {
      const track = await this.deps.detector.read();
      this._current = track;
      this.readAt = this.now();
      this.deps.ui.nowPlaying(track);
      if (track) {
        const key = trackKey(track);
        if (key !== this.currentKey) {
          this.currentKey = key;
          void this.onTrackChanged(track);
        }
      }
      this.deps.ui.status();
    } finally {
      this.polling = false;
    }
    if (this.repoll) await this.poll();
  }

  /** Look the playing track up again on the next poll (e.g. the server changed). */
  relookup(): void {
    this.currentKey = null;
  }

  /** Search Songsterr for the playing track (automatic search off, or "Find tab"). */
  async searchCurrent(): Promise<void> {
    if (this._current) await this.searchSongsterrFor(this._current, this.seq);
  }

  /** "Search again": forget the pick and cached lookup, then look up both sides. */
  async searchAgain(): Promise<void> {
    const track = this._current;
    if (!track) return;
    this.deps.picks.set(trackKey(track), null);
    this.forgetLookup(track);
    const seq = ++this.seq;
    await Promise.all([this.searchSongsterrFor(track, seq), this.lookupLocal(track, seq)]);
  }

  /**
   * The user chose `r` for `track` ("Wrong tab?"). Remembered only while that track
   * is the one playing; returns whether it was.
   */
  pick(track: Track, r: SongsterrResult): boolean {
    const key = trackKey(track);
    if (this.currentKey !== key) return false;
    this.deps.picks.set(key, r);
    this._best = r;
    this.setPhase("picked");
    return true;
  }

  private setPhase(p: SearchPhase): void {
    this._phase = p;
    this.deps.ui.status();
  }

  private async onTrackChanged(track: Track): Promise<void> {
    const { picks, settings, ui } = this.deps;
    const seq = ++this.seq;
    this._results = [];
    this._best = null;
    ui.trackChanged(track);

    const pick = picks.get(trackKey(track));
    if (pick) {
      this._best = pick;
      this.setPhase("picked");
      if (settings.followSpotify) ui.openSongsterr(pick);
    } else if (settings.autoSearch) {
      void this.searchSongsterrFor(track, seq);
    } else {
      this.setPhase("paused");
    }
    ui.renderStage();
    await this.lookupLocal(track, seq);
  }

  private async searchSongsterrFor(track: Track, seq: number): Promise<void> {
    const { api, settings, ui } = this.deps;
    const query = songsterrQuery(track);
    this.setPhase("searching");
    let rs: SongsterrResult[];
    try {
      rs = await api.songsterrSearch(query);
    } catch (e) {
      if (seq !== this.seq) return;
      console.warn("songsterr search failed", e);
      this.setPhase("server-error");
      ui.serverUnreachable(true);
      // Songsterr's own search page works without our server.
      this._best = songsterrSearchPage(query);
      if (settings.followSpotify) ui.openSongsterr(this._best);
      setTimeout(() => {
        if (seq === this.seq && this._phase === "server-error") void this.searchSongsterrFor(track, seq);
      }, RETRY_MS);
      return;
    }
    if (seq !== this.seq) return;
    ui.serverUnreachable(false);
    this._results = rs;
    const confident = rs.find((r) => isConfidentMatch(track, r)) ?? null;
    this._best = confident ?? rs[0] ?? songsterrSearchPage(query);
    this.setPhase(confident ? "found" : rs.length ? "uncertain" : "none");
    if (settings.followSpotify) ui.openSongsterr(this._best);
    else ui.renderAll();
  }

  private async lookupLocal(track: Track, seq: number): Promise<void> {
    const { api, ui } = this.deps;
    try {
      const r = await api.lookup(track);
      if (seq !== this.seq) return;
      if (r.match) {
        const how = r.method === "fuzzy" ? `fuzzy ${Math.round(r.confidence * 100)}%` : r.method;
        await ui.localMatch(r.match, how);
      } else {
        ui.localMiss(track, r.candidates);
      }
    } catch (e) {
      if (seq !== this.seq) return;
      // Only the local catalogue is retried; the Songsterr side has its own retry.
      console.warn("local lookup failed", e);
      setTimeout(() => {
        if (seq === this.seq) void this.lookupLocal(track, seq);
      }, RETRY_MS);
    }
  }
}
