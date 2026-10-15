/**
 * Practice tools for local tabs: transpose, speed, tuning read-out, and which
 * cursor drives the view. Pure logic; the viewer and main.ts apply it.
 */

export const TRANSPOSE_MIN = -12;
export const TRANSPOSE_MAX = 12;
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 2;
export const SPEED_PRESETS: readonly number[] = [0.5, 0.75, 1, 1.25];

/** Per-tab practice settings. */
export interface Practice {
  /** Semitones, -12…+12. */
  transpose: number;
  /** Playback speed factor, 0.25…2. */
  speed: number;
}

export const DEFAULT_PRACTICE: Readonly<Practice> = Object.freeze({ transpose: 0, speed: 1 });

const toNumber = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN);

/** Whole semitones in -12…+12; 0 for anything that isn't a finite number. */
export function clampTranspose(v: unknown): number {
  const n = toNumber(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(TRANSPOSE_MAX, Math.max(TRANSPOSE_MIN, Math.round(n)));
}

/** Speed in 5% steps within 25%–200%; 100% for anything that isn't a positive number. */
export function clampSpeed(v: unknown): number {
  const n = toNumber(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(n * 20) / 20));
}

// ---- Tuning ---------------------------------------------------------------------

const SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

export function noteName(midi: number, flats = false): string {
  return (flats ? FLATS : SHARPS)[((midi % 12) + 12) % 12];
}

interface KnownTuning {
  name: string;
  /** MIDI pitches, lowest string first. */
  pitches: number[];
  flats?: boolean;
}

const KNOWN_TUNINGS: readonly KnownTuning[] = [
  // 6-string guitar
  { name: "Standard", pitches: [40, 45, 50, 55, 59, 64] },
  { name: "Drop D", pitches: [38, 45, 50, 55, 59, 64] },
  { name: "Half step down", pitches: [39, 44, 49, 54, 58, 63], flats: true },
  { name: "Whole step down", pitches: [38, 43, 48, 53, 57, 62] },
  { name: "Drop C#", pitches: [37, 44, 49, 54, 58, 63] },
  { name: "Drop C", pitches: [36, 43, 48, 53, 57, 62] },
  { name: "Drop B", pitches: [35, 42, 47, 52, 56, 61] },
  { name: "Open G", pitches: [38, 43, 50, 55, 59, 62] },
  { name: "Open D", pitches: [38, 45, 50, 54, 57, 62] },
  { name: "Open E", pitches: [40, 47, 52, 56, 59, 64] },
  { name: "DADGAD", pitches: [38, 45, 50, 55, 57, 62] },
  // 7-string guitar
  { name: "Standard", pitches: [35, 40, 45, 50, 55, 59, 64] },
  { name: "Drop A", pitches: [33, 40, 45, 50, 55, 59, 64] },
  // 4- and 5-string bass
  { name: "Standard", pitches: [28, 33, 38, 43] },
  { name: "Drop D", pitches: [26, 33, 38, 43] },
  { name: "Half step down", pitches: [27, 32, 37, 42], flats: true },
  { name: "Standard", pitches: [23, 28, 33, 38, 43] },
];

export interface TuningInfo {
  /** Open-string notes, lowest string first, e.g. "E A D G B E". */
  notes: string;
  /** Known tuning name ("Standard", "Drop D", …) or null. */
  name: string | null;
  capo: number;
}

/** Names a tuning given as alphaTab does: MIDI pitches, string 1 (highest) first. */
export function describeTuning(pitches: readonly number[], capo = 0): TuningInfo {
  const low = [...pitches].reverse();
  const known = KNOWN_TUNINGS.find((t) => t.pitches.length === low.length && t.pitches.every((p, i) => p === low[i]));
  return {
    notes: low.map((p) => noteName(p, known?.flats)).join(" "),
    name: known?.name ?? null,
    capo: Number.isFinite(capo) && capo > 0 ? Math.round(capo) : 0,
  };
}

// ---- Cursor ---------------------------------------------------------------------

export type PlayerState = "stopped" | "playing" | "paused";

/** What moves the bar cursor: the built-in player while it plays, otherwise Spotify (if following). */
export function cursorSource(s: { player: PlayerState; spotifyPlaying: boolean; follow: boolean }): "player" | "spotify" | "none" {
  if (s.player === "playing") return "player";
  return s.follow && s.spotifyPlaying ? "spotify" : "none";
}

// ---- Persistence ----------------------------------------------------------------

/** Validates stored practice settings: `{ [tabId]: Practice }`, values clamped. */
export function parsePractice(raw: unknown): Record<string, Practice> {
  const out: Record<string, Practice> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(id) || !v || typeof v !== "object") continue;
    const p = v as Partial<Record<keyof Practice, unknown>>;
    out[id] = { transpose: clampTranspose(p.transpose ?? 0), speed: clampSpeed(p.speed ?? 1) };
  }
  return out;
}

/** Transpose and speed per local tab (by tab id), kept in localStorage. */
export class PracticeStore {
  private items: Record<string, Practice>;

  constructor(
    private key = "tabsync.practice",
    private storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  ) {
    try {
      this.items = parsePractice(JSON.parse(this.storage.getItem(this.key) ?? "{}"));
    } catch {
      this.items = {};
    }
  }

  get(tabId: number): Practice {
    return { ...(this.items[tabId] ?? DEFAULT_PRACTICE) };
  }

  /** Updates a tab's settings (clamped) and returns them. A tab back at the defaults is forgotten. */
  set(tabId: number, patch: Partial<Practice>): Practice {
    const merged = { ...this.get(tabId), ...patch };
    const next: Practice = { transpose: clampTranspose(merged.transpose), speed: clampSpeed(merged.speed) };
    if (next.transpose === DEFAULT_PRACTICE.transpose && next.speed === DEFAULT_PRACTICE.speed) delete this.items[tabId];
    else this.items[tabId] = next;
    try {
      this.storage.setItem(this.key, JSON.stringify(this.items));
    } catch {
      /* storage unavailable: kept for this session only */
    }
    return { ...next };
  }
}
