import * as alphaTab from "@coderline/alphatab";
import { pc, type Key } from "./scales";

/**
 * Key detection (Krumhansl–Schmuckler): how much of each pitch class a song uses
 * (a chroma vector) is correlated with the 24 major and minor key profiles; the
 * best fit is the key. The chroma comes from a local tab's notes or from the
 * microphone (see listen.ts).
 */

/** Krumhansl–Kessler probe-tone ratings, tonic first. */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export type Chroma = number[];

export interface KeyGuess extends Key {
  /** Correlation with the key's profile, -1…1. */
  score: number;
}

export interface KeyResult {
  key: Key;
  /** 0…1: how clearly the best key beats the runner-up (other than its relative key). */
  confidence: number;
  /** All 24 keys, best first. */
  ranking: KeyGuess[];
}

function correlation(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** The best-fitting key of a chroma vector; null when it holds no notes. */
export function detectKey(chroma: readonly number[]): KeyResult | null {
  if (chroma.length !== 12 || !chroma.some((v) => v > 0)) return null;
  const ranking: KeyGuess[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    // The profile rotated so its tonic sits on `tonic`.
    const rotate = (p: number[]) => chroma.map((_, i) => p[pc(i - tonic)]);
    ranking.push({ tonic, mode: "major", score: correlation(chroma, rotate(MAJOR_PROFILE)) });
    ranking.push({ tonic, mode: "minor", score: correlation(chroma, rotate(MINOR_PROFILE)) });
  }
  ranking.sort((a, b) => b.score - a.score);
  const best = ranking[0];
  // A relative key shares every note, so it is a near tie by nature; measure the gap
  // to the best key that actually sounds different.
  const relative = best.mode === "major" ? { tonic: pc(best.tonic + 9), mode: "minor" } : { tonic: pc(best.tonic + 3), mode: "major" };
  const rival = ranking.find((g, i) => i > 0 && !(g.tonic === relative.tonic && g.mode === relative.mode)) ?? ranking[1];
  // A good fit (high correlation) that clearly beats the rival (a gap of 0.25 or more).
  const confidence = Math.max(0, Math.min(1, best.score * Math.min(1, (best.score - rival.score) / 0.25)));
  return { key: { tonic: best.tonic, mode: best.mode }, confidence, ranking };
}

/**
 * Chroma of a loaded score: every pitched note weighted by its duration. Drum
 * tracks, dead notes and tied continuations are left out; `transpose` adds the
 * semitones the practice transpose plays the tab at.
 */
export function scoreChroma(score: alphaTab.model.Score, transpose = 0): Chroma {
  const chroma = new Array<number>(12).fill(0);
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      if (staff.isPercussion) continue;
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            const weight = beat.playbackDuration || 1;
            for (const note of beat.notes) {
              if (note.isDead || note.isTieDestination) continue;
              chroma[pc(note.realValue + transpose)] += weight;
            }
          }
        }
      }
    }
  }
  return chroma;
}

/** The key a score's own key signature states, if it has one (C major is also "none"). */
export function signatureKey(score: alphaTab.model.Score): Key | null {
  const mb = score.masterBars[0];
  if (!mb || mb.keySignature === 0) return null;
  // Key signature: sharps (>0) or flats (<0); each sharp is a fifth up from C.
  const major = pc(mb.keySignature * 7);
  return mb.keySignatureType === alphaTab.model.KeySignatureType.Minor ? { tonic: pc(major + 9), mode: "minor" } : { tonic: major, mode: "major" };
}

// ---- Audio --------------------------------------------------------------------

/** Frequency range analysed: low E of a guitar (~82 Hz, with headroom) to ~2 kHz. */
const MIN_HZ = 60;
const MAX_HZ = 2100;

/**
 * Chroma of one spectrum frame (AnalyserNode.getFloatFrequencyData: dB per bin).
 * Each bin adds its amplitude to the pitch class it is closest to; bins far from any
 * semitone, and those quieter than 1/20 of the loudest bin, are ignored.
 */
export function spectrumChroma(db: ArrayLike<number>, sampleRate: number): Chroma {
  const chroma = new Array<number>(12).fill(0);
  const binHz = sampleRate / 2 / db.length;
  const from = Math.max(1, Math.floor(MIN_HZ / binHz));
  const to = Math.min(db.length - 1, Math.ceil(MAX_HZ / binHz));
  let peak = 0;
  for (let i = from; i <= to; i++) peak = Math.max(peak, db[i]);
  if (!Number.isFinite(peak)) return chroma;
  const floor = peak - 26; // 1/20 of the peak amplitude
  for (let i = from; i <= to; i++) {
    if (!(db[i] > floor)) continue;
    const midi = 69 + 12 * Math.log2((i * binHz) / 440);
    const near = Math.round(midi);
    if (Math.abs(midi - near) > 0.3) continue;
    chroma[pc(near)] += 10 ** (db[i] / 20);
  }
  return chroma;
}

/** Adds `frame` to `total` normalised, so loud passages don't outweigh quiet ones. */
export function accumulate(total: Chroma, frame: readonly number[]): boolean {
  const sum = frame.reduce((s, v) => s + v, 0);
  if (!(sum > 0)) return false;
  for (let i = 0; i < 12; i++) total[i] += frame[i] / sum;
  return true;
}
