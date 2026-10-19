/**
 * Scale library for the Solos view: every scale as intervals from its root, and the
 * pure functions that lay a scale out on a fretboard (full neck, positions, tab).
 */

export type ScaleGroup = "Major & modes" | "Minor" | "Pentatonic & blues" | "Symmetric";

export interface ScaleDef {
  id: string;
  name: string;
  group: ScaleGroup;
  /** Semitones above the root, ascending, starting at 0. */
  intervals: readonly number[];
  /** Interval names, one per interval ("1", "b3", "#4", …). */
  degrees: readonly string[];
  /** Which key it fits best, so the default scale matches the detected key. */
  mode: "major" | "minor" | "any";
  /**
   * Positions are built from this scale and the extra notes added inside each
   * position (blues = pentatonic box + blue note), the way guitarists learn them.
   */
  parent?: string;
}

const scale = (id: string, name: string, group: ScaleGroup, mode: ScaleDef["mode"], spec: string, parent?: string): ScaleDef => {
  const degrees = spec.split(" ");
  return { id, name, group, mode, degrees, intervals: degrees.map(degreeSemitones), ...(parent ? { parent } : {}) };
};

function degreeSemitones(d: string): number {
  const base = [0, 2, 4, 5, 7, 9, 11][Number(d.replace(/[#b]/g, "")) - 1];
  return base + (d.match(/#/g)?.length ?? 0) - (d.match(/b/g)?.length ?? 0);
}

export const SCALES: readonly ScaleDef[] = [
  scale("major", "Major (Ionian)", "Major & modes", "major", "1 2 3 4 5 6 7"),
  scale("dorian", "Dorian", "Major & modes", "minor", "1 2 b3 4 5 6 b7"),
  scale("phrygian", "Phrygian", "Major & modes", "minor", "1 b2 b3 4 5 b6 b7"),
  scale("lydian", "Lydian", "Major & modes", "major", "1 2 3 #4 5 6 7"),
  scale("mixolydian", "Mixolydian", "Major & modes", "major", "1 2 3 4 5 6 b7"),
  scale("aeolian", "Aeolian (natural minor)", "Major & modes", "minor", "1 2 b3 4 5 b6 b7"),
  scale("locrian", "Locrian", "Major & modes", "minor", "1 b2 b3 4 b5 b6 b7"),
  scale("harmonic-minor", "Harmonic minor", "Minor", "minor", "1 2 b3 4 5 b6 7"),
  scale("melodic-minor", "Melodic minor", "Minor", "minor", "1 2 b3 4 5 6 7"),
  scale("phrygian-dominant", "Phrygian dominant", "Minor", "major", "1 b2 3 4 5 b6 b7"),
  scale("lydian-dominant", "Lydian dominant", "Minor", "major", "1 2 3 #4 5 6 b7"),
  scale("altered", "Altered (super Locrian)", "Minor", "any", "1 b2 b3 b4 b5 b6 b7"),
  scale("minor-pentatonic", "Minor pentatonic", "Pentatonic & blues", "minor", "1 b3 4 5 b7"),
  scale("major-pentatonic", "Major pentatonic", "Pentatonic & blues", "major", "1 2 3 5 6"),
  scale("blues", "Blues (minor)", "Pentatonic & blues", "minor", "1 b3 4 b5 5 b7", "minor-pentatonic"),
  scale("major-blues", "Major blues", "Pentatonic & blues", "major", "1 2 b3 3 5 6", "major-pentatonic"),
  scale("diminished-wh", "Diminished (whole-half)", "Symmetric", "any", "1 2 b3 4 b5 b6 6 7"),
  scale("diminished-hw", "Diminished (half-whole)", "Symmetric", "any", "1 b2 b3 3 #4 5 6 b7"),
  scale("whole-tone", "Whole tone", "Symmetric", "any", "1 2 3 #4 #5 b7"),
  scale("chromatic", "Chromatic", "Symmetric", "any", "1 b2 2 b3 3 4 #4 5 b6 6 b7 7"),
];

export const SCALE_GROUPS: readonly ScaleGroup[] = ["Pentatonic & blues", "Major & modes", "Minor", "Symmetric"];

export function scaleById(id: string): ScaleDef | undefined {
  return SCALES.find((s) => s.id === id);
}

// ---- Keys and note names ----------------------------------------------------------

export type Mode = "major" | "minor";

/** A key: tonic pitch class (0 = C … 11 = B) and mode. */
export interface Key {
  tonic: number;
  mode: Mode;
}

const SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
/** Tonics written with flats: F Bb Eb Ab Db Gb major, and their relative minors. */
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6]);

export const pc = (n: number) => ((Math.round(n) % 12) + 12) % 12;

/** Whether a key is spelled with flats (the major key, or the relative major of a minor one). */
export function usesFlats(key: Key): boolean {
  return FLAT_MAJOR.has(key.mode === "major" ? key.tonic : pc(key.tonic + 3));
}

export function pitchName(p: number, flats = false): string {
  return (flats ? FLATS : SHARPS)[pc(p)];
}

export function keyName(key: Key): string {
  return `${pitchName(key.tonic, usesFlats(key))} ${key.mode}`;
}

/** The relative major of a minor key and vice versa (same notes). */
export function relativeKey(key: Key): Key {
  return key.mode === "major" ? { tonic: pc(key.tonic + 9), mode: "minor" } : { tonic: pc(key.tonic + 3), mode: "major" };
}

/** The scale shown first for a key: its pentatonic, the usual starting point for solos. */
export function defaultScaleFor(key: Key): string {
  return key.mode === "major" ? "major-pentatonic" : "minor-pentatonic";
}

export interface ScaleNote {
  pitch: number;
  name: string;
  degree: string;
}

/**
 * The notes of `scaleId` built on `root`. A flattened or sharpened degree is spelled
 * that way (the blues b5 of E is Bb, not A#); the others follow the key (`flats`).
 */
export function scaleNotes(root: number, scaleId: string, flats: boolean): ScaleNote[] {
  const s = scaleById(scaleId);
  if (!s) return [];
  return s.intervals.map((iv, i) => {
    const degree = s.degrees[i];
    const spelling = degree.includes("b") ? true : degree.includes("#") ? false : flats;
    return { pitch: pc(root + iv), name: pitchName(root + iv, spelling), degree };
  });
}

// ---- Fretboard -------------------------------------------------------------------

/** Standard guitar tuning as alphaTab gives it: MIDI pitches, string 1 (highest) first. */
export const STANDARD_TUNING: readonly number[] = [64, 59, 55, 50, 45, 40];

export interface FretNote {
  /** 0 = highest string, as in alphaTab and on a tab staff. */
  string: number;
  fret: number;
  pitch: number;
}

/** Every scale note on every string from the nut to `frets`. */
export function neckNotes(tuning: readonly number[], root: number, scaleId: string, frets: number): FretNote[] {
  const pcs = new Set(scaleNotes(root, scaleId, false).map((n) => n.pitch));
  const out: FretNote[] = [];
  tuning.forEach((open, string) => {
    for (let fret = 0; fret <= frets; fret++) if (pcs.has(pc(open + fret))) out.push({ string, fret, pitch: open + fret });
  });
  return out;
}

/** Notes per string when building positions: 2 for pentatonics, 3 for 6–8 note scales. */
function notesPerString(size: number): number {
  return size <= 5 ? 2 : size <= 8 ? 3 : 4;
}

export interface Position {
  /** 1-based: position 1 starts on the root, the next ones further up the neck. */
  number: number;
  /** Notes in playing order: lowest string first, ascending. */
  notes: FretNote[];
  minFret: number;
  maxFret: number;
}

/**
 * Playable positions of a scale, one starting on each scale note of the lowest
 * string within the first octave. Built "N notes per string" (pentatonic boxes,
 * three-notes-per-string for the modes), so the B-string shift comes out right in
 * any tuning. A scale with a `parent` takes its parent's positions and adds its
 * own extra notes that fall inside each one (the blues "blue note").
 */
export function positions(tuning: readonly number[], root: number, scaleId: string): Position[] {
  const s = scaleById(scaleId);
  if (!s || tuning.length === 0) return [];
  const base = (s.parent && scaleById(s.parent)) || s;
  const basePcs = new Set(base.intervals.map((iv) => pc(root + iv)));
  const allPcs = new Set(s.intervals.map((iv) => pc(root + iv)));
  const perString = notesPerString(base.intervals.length);
  const low = tuning.length - 1;
  // Position 1 starts on the root, then on up the neck (wrapping below fret 12).
  const rootFret = pc(root - tuning[low]);
  const starts: number[] = [];
  for (let i = 0; i < 12; i++) {
    const fret = (rootFret + i) % 12;
    if (basePcs.has(pc(tuning[low] + fret))) starts.push(fret);
  }

  return starts.map((startFret, i) => {
    const notes: FretNote[] = [];
    let pitch = tuning[low] + startFret;
    let string = low;
    let count = 0;
    for (;;) {
      notes.push({ string, fret: pitch - tuning[string], pitch });
      count++;
      if (string === 0 && count >= perString) break;
      pitch = nextIn(basePcs, pitch);
      // Next string once this one has its share, unless the note lies below its nut.
      if (count >= perString && pitch >= tuning[string - 1]) {
        string--;
        count = 0;
      }
    }
    const extras = base === s ? [] : extraNotes(tuning, notes, allPcs, basePcs);
    const all = [...notes, ...extras].sort((a, b) => b.string - a.string || a.fret - b.fret);
    const frets = all.map((n) => n.fret);
    return { number: i + 1, notes: all, minFret: Math.min(...frets), maxFret: Math.max(...frets) };
  });
}

function nextIn(pcs: Set<number>, pitch: number): number {
  let p = pitch + 1;
  while (!pcs.has(pc(p))) p++;
  return p;
}

/**
 * Notes of the full scale missing from a parent position: on each string, within a
 * fret of that string's notes and inside the position's fret span.
 */
function extraNotes(tuning: readonly number[], notes: FretNote[], all: Set<number>, base: Set<number>): FretNote[] {
  const out: FretNote[] = [];
  const lo = Math.min(...notes.map((n) => n.fret));
  const hi = Math.max(...notes.map((n) => n.fret));
  tuning.forEach((open, string) => {
    const on = notes.filter((n) => n.string === string).map((n) => n.fret);
    if (on.length === 0) return;
    for (let fret = Math.max(lo, Math.min(...on) - 1); fret <= Math.min(hi, Math.max(...on) + 1); fret++) {
      const p = open + fret;
      if (all.has(pc(p)) && !base.has(pc(p))) out.push({ string, fret, pitch: p });
    }
  });
  return out;
}

/** String names for a tab staff, highest first, with the top E in lower case. */
export function stringLabels(tuning: readonly number[], flats = false): string[] {
  const names = tuning.map((p) => pitchName(p, flats));
  if (names.length && names[0] === names[names.length - 1]) names[0] = names[0].toLowerCase();
  return names;
}

/**
 * ASCII tablature of a position played up then back down, e.g.
 * `e|-----------------5-8-|`. One column per note.
 */
export function positionTab(tuning: readonly number[], notes: readonly FretNote[], flats = false, descend = true): string {
  const order = descend ? [...notes, ...[...notes].reverse().slice(1)] : [...notes];
  const labels = stringLabels(tuning, flats);
  const pad = Math.max(...labels.map((l) => l.length));
  const lines = labels.map((l) => `${l.padEnd(pad)}|-`);
  for (const n of order) {
    const cell = String(n.fret);
    lines.forEach((_, s) => (lines[s] += (s === n.string ? cell : "-".repeat(cell.length)) + "-"));
  }
  return lines.map((l) => `${l}|`).join("\n");
}
