import * as alphaTab from "@coderline/alphatab";
import { describe, expect, it } from "vitest";
import { accumulate, detectKey, scoreChroma, signatureKey, spectrumChroma } from "../src/key";

const load = (tex: string) => alphaTab.importer.ScoreLoader.loadAlphaTex(tex, new alphaTab.Settings());
/** A chroma with `weights` on the pitch classes given. */
const chroma = (weights: Record<number, number>) => Array.from({ length: 12 }, (_, i) => weights[i] ?? 0);

describe("detectKey", () => {
  it("finds C major from its scale with the tonic triad stressed", () => {
    const r = detectKey(chroma({ 0: 5, 2: 2, 4: 4, 5: 2, 7: 4, 9: 2, 11: 1 }))!;
    expect(r.key).toEqual({ tonic: 0, mode: "major" });
    expect(r.ranking).toHaveLength(24);
  });

  it("finds A minor from the same notes with A minor's triad stressed", () => {
    const r = detectKey(chroma({ 9: 5, 0: 4, 4: 4, 2: 2, 5: 1, 7: 2, 11: 2 }))!;
    expect(r.key).toEqual({ tonic: 9, mode: "minor" });
  });

  it("finds E minor pentatonic riffs in E minor", () => {
    expect(detectKey(chroma({ 4: 6, 7: 4, 9: 3, 11: 4, 2: 3 }))!.key).toEqual({ tonic: 4, mode: "minor" });
  });

  it("is sure of a clear key and unsure of a chromatic blur", () => {
    const clear = detectKey(chroma({ 0: 5, 2: 2, 4: 4, 5: 2, 7: 4, 9: 2, 11: 1 }))!;
    const blur = detectKey(chroma({ 0: 1, 1: 1, 2: 1, 3: 1.1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1 }))!;
    expect(clear.confidence).toBeGreaterThan(0.5);
    expect(blur.confidence).toBeLessThan(clear.confidence);
  });

  it("returns null for silence", () => {
    expect(detectKey(new Array(12).fill(0))).toBeNull();
  });
});

describe("scoreChroma", () => {
  it("counts each note's pitch class weighted by its duration", () => {
    // Low E string: open (E), 3rd fret (G); a half note weighs twice a quarter.
    const c = scoreChroma(load(`. 0.6.2 3.6.4 3.6.4`));
    expect(c[4]).toBe(c[7]); // one half note of E = two quarter notes of G
    expect(c[4]).toBeGreaterThan(0);
    expect(c.filter((v) => v > 0)).toHaveLength(2);
  });

  it("adds the practice transpose", () => {
    const c = scoreChroma(load(`. 0.6.4`), 2);
    expect(c[6]).toBeGreaterThan(0); // E + 2 = F#
    expect(c[4]).toBe(0);
  });

  it("detects the key of a tab", () => {
    // A minor pentatonic box, A on the low E string's 5th fret, ending on A.
    const tex = `. 5.6.8 8.6.8 5.5.8 7.5.8 5.4.8 7.4.8 5.3.8 7.3.8 | 5.2.8 8.2.8 5.1.8 8.1.8 5.1.2 | 7.4.2 5.6.2`;
    expect(detectKey(scoreChroma(load(tex)))!.key).toEqual({ tonic: 9, mode: "minor" });
  });
});

describe("signatureKey", () => {
  it("reads the key signature", () => {
    expect(signatureKey(load(`\\ks G . 0.6.4`))).toEqual({ tonic: 7, mode: "major" });
    expect(signatureKey(load(`\\ks Bb . 0.6.4`))).toEqual({ tonic: 10, mode: "major" });
    expect(signatureKey(load(`. 0.6.4`))).toBeNull();
  });
});

describe("spectrumChroma", () => {
  /** A dB spectrum of `bins` bins with peaks (Hz → dB) over a -100 dB floor. */
  function spectrum(peaks: Record<number, number>, sampleRate = 44_100, bins = 8192): Float32Array {
    const db = new Float32Array(bins).fill(-100);
    const binHz = sampleRate / 2 / bins;
    for (const [hz, level] of Object.entries(peaks)) db[Math.round(Number(hz) / binHz)] = level;
    return db;
  }

  it("folds a 440 Hz tone into A", () => {
    const c = spectrumChroma(spectrum({ 440: -20 }), 44_100);
    expect(c.indexOf(Math.max(...c))).toBe(9);
  });

  it("folds octaves together and ignores what's far quieter", () => {
    const c = spectrumChroma(spectrum({ 110: -20, 220: -24, 329.63: -22, 261.63: -70 }), 44_100);
    expect(c[9]).toBeGreaterThan(c[4]);
    expect(c[4]).toBeGreaterThan(0);
    expect(c[0]).toBe(0);
  });

  it("returns nothing for silence", () => {
    expect(spectrumChroma(new Float32Array(8192).fill(-Infinity), 44_100)).toEqual(new Array(12).fill(0));
  });
});

describe("accumulate", () => {
  it("adds normalised frames and skips empty ones", () => {
    const total = new Array(12).fill(0);
    expect(accumulate(total, chroma({ 0: 10, 7: 10 }))).toBe(true);
    expect(accumulate(total, chroma({ 0: 1 }))).toBe(true);
    expect(accumulate(total, new Array(12).fill(0))).toBe(false);
    expect(total[0]).toBeCloseTo(1.5);
    expect(total[7]).toBeCloseTo(0.5);
  });
});
