import { describe, expect, it } from "vitest";
import {
  defaultScaleFor,
  keyName,
  neckNotes,
  positions,
  positionTab,
  relativeKey,
  scaleNotes,
  SCALES,
  STANDARD_TUNING,
  usesFlats,
} from "../src/scales";

const A = 9;
const names = (root: number, id: string, flats = false) => scaleNotes(root, id, flats).map((n) => n.name);
/** "string:fret" of a position's notes, lowest string first. */
const frets = (root: number, id: string, n: number) =>
  positions(STANDARD_TUNING, root, id)
    .find((p) => p.number === n)!
    .notes.map((x) => `${x.string + 1}:${x.fret}`);

describe("SCALES", () => {
  it("has every requested scale", () => {
    const ids = SCALES.map((s) => s.id);
    for (const id of [
      "major", "minor-pentatonic", "major-pentatonic", "aeolian", "blues", "mixolydian", "dorian", "melodic-minor",
      "harmonic-minor", "phrygian", "locrian", "lydian", "diminished-wh", "diminished-hw", "chromatic", "whole-tone",
    ])
      expect(ids).toContain(id);
  });

  it("defines each scale as ascending intervals within an octave, one degree name each", () => {
    for (const s of SCALES) {
      expect(s.intervals[0], s.id).toBe(0);
      expect(s.degrees.length, s.id).toBe(s.intervals.length);
      for (let i = 1; i < s.intervals.length; i++) expect(s.intervals[i], s.id).toBeGreaterThan(s.intervals[i - 1]);
      expect(s.intervals.at(-1)!, s.id).toBeLessThan(12);
    }
  });

  it("spells scales from their intervals", () => {
    expect(names(0, "major")).toEqual(["C", "D", "E", "F", "G", "A", "B"]);
    expect(names(A, "minor-pentatonic")).toEqual(["A", "C", "D", "E", "G"]);
    expect(names(A, "blues")).toEqual(["A", "C", "D", "Eb", "E", "G"]);
    expect(names(2, "dorian")).toEqual(["D", "E", "F", "G", "A", "B", "C"]);
    expect(names(A, "harmonic-minor")).toEqual(["A", "B", "C", "D", "E", "F", "G#"]);
    expect(names(0, "whole-tone")).toEqual(["C", "D", "E", "F#", "G#", "Bb"]);
    expect(names(0, "diminished-wh")).toHaveLength(8);
    expect(names(0, "chromatic")).toHaveLength(12);
  });
});

describe("keys", () => {
  it("spells flat keys with flats", () => {
    expect(usesFlats({ tonic: 5, mode: "major" })).toBe(true); // F
    expect(usesFlats({ tonic: 2, mode: "minor" })).toBe(true); // D minor = F major
    expect(usesFlats({ tonic: 4, mode: "minor" })).toBe(false); // E minor = G major
    expect(keyName({ tonic: 10, mode: "major" })).toBe("Bb major");
    expect(keyName({ tonic: 6, mode: "minor" })).toBe("F# minor");
  });

  it("finds the relative key both ways", () => {
    expect(relativeKey({ tonic: A, mode: "minor" })).toEqual({ tonic: 0, mode: "major" });
    expect(relativeKey({ tonic: 0, mode: "major" })).toEqual({ tonic: A, mode: "minor" });
  });

  it("starts each key on its pentatonic", () => {
    expect(defaultScaleFor({ tonic: 0, mode: "major" })).toBe("major-pentatonic");
    expect(defaultScaleFor({ tonic: A, mode: "minor" })).toBe("minor-pentatonic");
  });
});

describe("neckNotes", () => {
  it("marks every scale note on every string", () => {
    const notes = neckNotes(STANDARD_TUNING, A, "minor-pentatonic", 12);
    const lowE = notes.filter((n) => n.string === 5).map((n) => n.fret);
    expect(lowE).toEqual([0, 3, 5, 8, 10, 12]);
  });
});

describe("positions", () => {
  it("gives the five A minor pentatonic boxes, the first on the root", () => {
    const pos = positions(STANDARD_TUNING, A, "minor-pentatonic");
    expect(pos).toHaveLength(5);
    expect(frets(A, "minor-pentatonic", 1)).toEqual(["6:5", "6:8", "5:5", "5:7", "4:5", "4:7", "3:5", "3:7", "2:5", "2:8", "1:5", "1:8"]);
    expect(frets(A, "minor-pentatonic", 2)).toEqual(["6:8", "6:10", "5:7", "5:10", "4:7", "4:10", "3:7", "3:9", "2:8", "2:10", "1:8", "1:10"]);
    expect(pos.map((p) => p.minFret)).toEqual([5, 7, 9, 0, 2]);
  });

  it("adds the blue note to the pentatonic box", () => {
    expect(frets(A, "blues", 1)).toEqual(["6:5", "6:8", "5:5", "5:6", "5:7", "4:5", "4:7", "3:5", "3:7", "3:8", "2:5", "2:8", "1:5", "1:8"]);
  });

  it("plays seven-note scales three notes per string", () => {
    const pos = positions(STANDARD_TUNING, 7, "major"); // G major
    expect(pos).toHaveLength(7);
    expect(frets(7, "major", 1)).toEqual(["6:3", "6:5", "6:7", "5:3", "5:5", "5:7", "4:4", "4:5", "4:7", "3:4", "3:5", "3:7", "2:5", "2:7", "2:8", "1:5", "1:7", "1:8"]);
    for (const p of pos) expect(p.notes).toHaveLength(18);
  });

  it("never puts a note below the nut", () => {
    for (const s of SCALES)
      for (let root = 0; root < 12; root++)
        for (const p of positions(STANDARD_TUNING, root, s.id)) expect(p.minFret, `${s.id} ${root}`).toBeGreaterThanOrEqual(0);
  });

  it("works in other tunings and on basses", () => {
    const bass = [43, 38, 33, 28];
    const pos = positions(bass, A, "minor-pentatonic");
    expect(pos[0].notes.map((n) => n.fret)).toEqual([5, 8, 5, 7, 5, 7, 5, 7]);
  });
});

describe("positionTab", () => {
  it("writes the position up and back down as ASCII tab", () => {
    const pos = positions(STANDARD_TUNING, A, "minor-pentatonic")[0];
    const tab = positionTab(STANDARD_TUNING, pos.notes).split("\n");
    expect(tab).toHaveLength(6);
    expect(tab[0].startsWith("e|-")).toBe(true);
    expect(tab[5].startsWith("E|-5-8-")).toBe(true);
    // 12 notes up, 11 back down: every line spans the same columns.
    expect(new Set(tab.map((l) => l.length)).size).toBe(1);
    expect(tab[0]).toContain("-5-8-5-");
  });
});
