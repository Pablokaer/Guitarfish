import { describe, expect, it } from "vitest";
import {
  clampSpeed,
  clampTranspose,
  cursorSource,
  DEFAULT_PRACTICE,
  describeTuning,
  noteName,
  parsePractice,
  PracticeStore,
  SPEED_PRESETS,
} from "../src/practice";

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), dump: () => m };
}

describe("clampTranspose", () => {
  it("keeps whole semitones from -12 to +12", () => {
    expect(clampTranspose(0)).toBe(0);
    expect(clampTranspose(-12)).toBe(-12);
    expect(clampTranspose(12)).toBe(12);
    expect(clampTranspose(13)).toBe(12);
    expect(clampTranspose(-40)).toBe(-12);
    expect(clampTranspose(2.6)).toBe(3);
    expect(clampTranspose("5")).toBe(5);
  });

  it("falls back to 0 for anything that isn't a number", () => {
    expect(clampTranspose(Number.NaN)).toBe(0);
    expect(clampTranspose("x")).toBe(0);
    expect(clampTranspose(undefined)).toBe(0);
    expect(clampTranspose(Infinity)).toBe(0);
  });
});

describe("clampSpeed", () => {
  it("keeps 25%–200% in 5% steps", () => {
    expect(clampSpeed(1)).toBe(1);
    expect(clampSpeed(0.1)).toBe(0.25);
    expect(clampSpeed(3)).toBe(2);
    expect(clampSpeed(0.73)).toBe(0.75);
    expect(clampSpeed("1.5")).toBe(1.5);
  });

  it("falls back to 100% for anything that isn't a positive number", () => {
    expect(clampSpeed(Number.NaN)).toBe(1);
    expect(clampSpeed(null)).toBe(1);
    expect(clampSpeed(0)).toBe(1);
    expect(clampSpeed(-1)).toBe(1);
  });

  it("offers presets inside the range", () => {
    expect(SPEED_PRESETS.length).toBeGreaterThan(0);
    for (const p of SPEED_PRESETS) expect(clampSpeed(p)).toBe(p);
  });
});

describe("noteName", () => {
  it("names MIDI pitches with sharps or flats", () => {
    expect(noteName(40)).toBe("E");
    expect(noteName(60)).toBe("C");
    expect(noteName(61)).toBe("C#");
    expect(noteName(61, true)).toBe("Db");
    expect(noteName(-1)).toBe("B");
  });
});

describe("describeTuning", () => {
  // alphaTab order: string 1 (highest) first.
  const standard = [64, 59, 55, 50, 45, 40];

  it("lists the notes low to high and recognises standard tuning", () => {
    expect(describeTuning(standard)).toEqual({ notes: "E A D G B E", name: "Standard", capo: 0 });
  });

  it("recognises common alternate guitar tunings", () => {
    expect(describeTuning([64, 59, 55, 50, 45, 38]).name).toBe("Drop D");
    expect(describeTuning([62, 57, 53, 48, 43, 38]).name).toBe("Whole step down");
    expect(describeTuning([62, 57, 53, 48, 43, 36]).name).toBe("Drop C");
    expect(describeTuning([62, 59, 55, 50, 43, 38]).name).toBe("Open G");
    expect(describeTuning([62, 57, 54, 50, 45, 38]).name).toBe("Open D");
    expect(describeTuning([62, 57, 55, 50, 45, 38]).name).toBe("DADGAD");
  });

  it("spells half step down with flats", () => {
    expect(describeTuning([63, 58, 54, 49, 44, 39])).toEqual({ notes: "Eb Ab Db Gb Bb Eb", name: "Half step down", capo: 0 });
  });

  it("recognises bass and 7-string standard tunings", () => {
    expect(describeTuning([43, 38, 33, 28])).toEqual({ notes: "E A D G", name: "Standard", capo: 0 });
    expect(describeTuning([43, 38, 33, 28, 23]).name).toBe("Standard");
    expect(describeTuning([64, 59, 55, 50, 45, 40, 35]).name).toBe("Standard");
    expect(describeTuning([43, 38, 33, 26]).name).toBe("Drop D");
  });

  it("leaves unknown tunings unnamed and keeps the capo", () => {
    expect(describeTuning([64, 59, 55, 50, 45, 41], 2)).toEqual({ notes: "F A D G B E", name: null, capo: 2 });
    expect(describeTuning([]).name).toBeNull();
  });

  it("ignores a negative or invalid capo", () => {
    expect(describeTuning(standard, -1).capo).toBe(0);
    expect(describeTuning(standard, Number.NaN).capo).toBe(0);
  });
});

describe("cursorSource", () => {
  it("follows the built-in player while it plays", () => {
    expect(cursorSource({ player: "playing", spotifyPlaying: true, follow: true })).toBe("player");
    expect(cursorSource({ player: "playing", spotifyPlaying: false, follow: false })).toBe("player");
  });

  it("follows Spotify otherwise, when follow mode is on and Spotify plays", () => {
    expect(cursorSource({ player: "stopped", spotifyPlaying: true, follow: true })).toBe("spotify");
    expect(cursorSource({ player: "paused", spotifyPlaying: true, follow: true })).toBe("spotify");
    expect(cursorSource({ player: "stopped", spotifyPlaying: false, follow: true })).toBe("none");
    expect(cursorSource({ player: "stopped", spotifyPlaying: true, follow: false })).toBe("none");
  });
});

describe("parsePractice", () => {
  it("keeps valid entries by tab id and clamps their values", () => {
    expect(parsePractice({ "7": { transpose: 20, speed: 0.5 }, "8": { speed: 0.1 } })).toEqual({
      "7": { transpose: 12, speed: 0.5 },
      "8": { transpose: 0, speed: 0.25 },
    });
  });

  it("drops entries that aren't objects or keys that aren't tab ids", () => {
    expect(parsePractice({ "7": "fast", abc: { speed: 0.5 }, "9": null })).toEqual({});
  });

  it("returns nothing for junk", () => {
    expect(parsePractice(null)).toEqual({});
    expect(parsePractice([1, 2])).toEqual({});
    expect(parsePractice("x")).toEqual({});
  });
});

describe("PracticeStore", () => {
  it("returns the defaults for an unknown tab", () => {
    const store = new PracticeStore("p", memoryStorage());
    expect(store.get(1)).toEqual(DEFAULT_PRACTICE);
    expect(DEFAULT_PRACTICE).toEqual({ transpose: 0, speed: 1 });
  });

  it("stores transpose and speed per tab under tabsync.practice and survives a reload", () => {
    const storage = memoryStorage();
    const a = new PracticeStore(undefined, storage);
    expect(a.set(3, { transpose: -2 })).toEqual({ transpose: -2, speed: 1 });
    a.set(3, { speed: 0.75 });
    a.set(4, { speed: 9 });
    expect([...storage.dump().keys()]).toEqual(["tabsync.practice"]);
    const b = new PracticeStore(undefined, storage);
    expect(b.get(3)).toEqual({ transpose: -2, speed: 0.75 });
    expect(b.get(4)).toEqual({ transpose: 0, speed: 2 });
  });

  it("forgets a tab that is back to the defaults", () => {
    const storage = memoryStorage();
    const store = new PracticeStore("p", storage);
    store.set(3, { transpose: 1 });
    store.set(3, { transpose: 0 });
    expect(JSON.parse(storage.getItem("p")!)).toEqual({});
  });

  it("survives corrupt or unavailable storage", () => {
    const broken = {
      getItem: () => "{not json",
      setItem: () => {
        throw new Error("quota");
      },
    };
    const store = new PracticeStore("p", broken);
    expect(store.get(1)).toEqual(DEFAULT_PRACTICE);
    expect(store.set(1, { speed: 0.5 })).toEqual({ transpose: 0, speed: 0.5 });
    expect(store.get(1)).toEqual({ transpose: 0, speed: 0.5 });
  });
});
