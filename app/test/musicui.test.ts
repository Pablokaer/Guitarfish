import { describe, expect, it } from "vitest";
import { move } from "../src/queue";
import { dropIndex, filterTracks, fold, formatSpeed, formatTime, listSummary, parseSortKey, playerKey, sortTracks } from "../src/musicui";

const t = (id: number, title: string, artist: string, album = "", durationMs: number | null = 1000, addedAt = id) => ({
  id,
  title,
  artist,
  album,
  durationMs,
  addedAt,
  fileName: `${title}.mp3`,
});

const lib = [
  t(1, "Wonderwall", "Oasis", "Morning Glory", 258_000),
  t(2, "Halo", "Beyoncé", "I Am... Sasha Fierce", 261_000),
  t(3, "Track 10", "", "", null),
  t(4, "Track 2", "Oasis", "", 100_000),
];

describe("filterTracks", () => {
  it("matches every word across title, artist and album, ignoring case and accents", () => {
    expect(filterTracks(lib, "beyonce").map((x) => x.id)).toEqual([2]);
    expect(filterTracks(lib, "oasis glory").map((x) => x.id)).toEqual([1]);
    expect(filterTracks(lib, "  ")).toHaveLength(4);
    expect(filterTracks(lib, "nothing here")).toEqual([]);
  });

  it("finds a file by its name", () => {
    expect(filterTracks(lib, "track 10.mp3").map((x) => x.id)).toEqual([3]);
  });

  it("folds accents", () => {
    expect(fold("João É")).toBe("joao e");
  });
});

describe("sortTracks", () => {
  const ids = (key: Parameters<typeof sortTracks>[1]) => sortTracks(lib, key).map((x) => x.id);

  it("sorts newest first by default", () => {
    expect(ids("added")).toEqual([4, 3, 2, 1]);
  });

  it("sorts titles naturally", () => {
    expect(ids("title")).toEqual([2, 4, 3, 1]);
  });

  it("puts missing artists and albums last", () => {
    expect(ids("artist")).toEqual([2, 4, 1, 3]);
    expect(ids("album")).toEqual([2, 1, 4, 3]);
  });

  it("sorts by duration, unknown last", () => {
    expect(ids("duration")).toEqual([4, 1, 2, 3]);
  });

  it("reads a stored sort key", () => {
    expect(parseSortKey("artist")).toBe("artist");
    expect(parseSortKey("bpm")).toBe("added");
    expect(parseSortKey(null)).toBe("added");
  });
});

describe("formatting", () => {
  it("formats times", () => {
    expect(formatTime(65_000)).toBe("1:05");
    expect(formatTime(3_723_000)).toBe("1:02:03");
    expect(formatTime(null)).toBe("–:––");
    expect(formatTime(Number.NaN)).toBe("–:––");
  });

  it("formats speeds", () => {
    expect(formatSpeed(0.75)).toBe("0.75×");
    expect(formatSpeed(1)).toBe("1.00×");
  });

  it("summarises a list", () => {
    expect(listSummary([{ durationMs: 120_000 }, { durationMs: null }])).toBe("2 songs · 2 min");
    expect(listSummary([{ durationMs: 3_900_000 }])).toBe("1 song · 1 h 5 min");
    expect(listSummary([])).toBe("0 songs");
    expect(listSummary([{ durationMs: 14_200 }])).toBe("1 song · 14 s");
  });
});

describe("dropIndex", () => {
  const mids = [10, 30, 50, 70];
  const drop = (from: number, y: number) => move(["a", "b", "c", "d"], from, dropIndex(mids, from, y));

  it("moves a row down past the rows above the pointer", () => {
    expect(drop(0, 40)).toEqual(["b", "a", "c", "d"]);
    expect(drop(0, 99)).toEqual(["b", "c", "d", "a"]);
  });

  it("moves a row up", () => {
    expect(drop(3, 20)).toEqual(["a", "d", "b", "c"]);
    expect(drop(3, 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("leaves it in place when dropped near where it was", () => {
    expect(drop(1, 35)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("playerKey", () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}, tagName = "BODY") =>
    playerKey({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods }, { tagName });

  it("maps the playback keys", () => {
    expect(key(" ")).toBe("toggle");
    expect(key("ArrowLeft")).toBe("back");
    expect(key("ArrowRight")).toBe("forward");
    expect(key("ArrowLeft", { shiftKey: true })).toBe("previous");
    expect(key("ArrowRight", { shiftKey: true })).toBe("next");
    expect(key("[")).toBe("slower");
    expect(key("-")).toBe("slower");
    expect(key("]")).toBe("faster");
    expect(key("+", { shiftKey: true })).toBe("faster");
    expect(key("0")).toBe("normal-speed");
    expect(key("L", { shiftKey: true })).toBe("loop");
    expect(key("m")).toBe("mute");
    expect(key("x")).toBeNull();
  });

  it("stays out of the way of typing, shortcuts and buttons", () => {
    expect(key(" ", {}, "INPUT")).toBeNull();
    expect(key("m", {}, "textarea")).toBeNull();
    expect(key("ArrowLeft", {}, "SELECT")).toBeNull();
    expect(key(" ", {}, "BUTTON")).toBeNull();
    expect(key("ArrowRight", {}, "BUTTON")).toBe("forward");
    expect(key("k", { metaKey: true })).toBeNull();
    expect(key("ArrowLeft", { altKey: true })).toBeNull();
    expect(playerKey({ key: "m", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }, { isContentEditable: true })).toBeNull();
    expect(playerKey({ key: " ", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }, null)).toBe("toggle");
  });
});
