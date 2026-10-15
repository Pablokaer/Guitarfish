import { describe, expect, it } from "vitest";
import { AUTO_ACCEPT, lookup, MIN_CANDIDATE, scoreSong, search, type MatchSong } from "../src/matching";

// Ported from the server's lookup and search tests (server/test/api.test.ts).
const song = (id: number, title: string, artist: string, durationMs: number | null = null): MatchSong => ({ id, title, artist, durationMs });
const WONDERWALL = song(1, "Wonderwall", "Oasis", 258_000);
const SEVEN = song(2, "Seven Nation Army", "The White Stripes");
const TEMPO = song(3, "Tempo Perdido", "Legião Urbana");
const SONGS = [WONDERWALL, SEVEN, TEMPO];

describe("lookup", () => {
  it("matches exactly despite Spotify title noise", () => {
    const r = lookup(SONGS, { title: "Wonderwall - Remastered", artist: "Oasis" });
    expect(r).toEqual({ match: WONDERWALL, confidence: 0.97, method: "exact", candidates: [{ song: WONDERWALL, score: 0.97 }] });
  });

  it("matches with accents, 'The' and combined artists", () => {
    expect(lookup(SONGS, { title: "Tempo Perdido", artist: "Legiao Urbana" }).match).toBe(TEMPO);
    expect(lookup(SONGS, { title: "Seven Nation Army", artist: "White Stripes" }).match).toBe(SEVEN);
    expect(lookup(SONGS, { title: "Wonderwall", artist: "Oasis, Someone Else" }).method).toBe("exact");
  });

  it("fuzzy matches small differences", () => {
    const r = lookup(SONGS, { title: "Wonderwal", artist: "Oasis" });
    expect(r.method).toBe("fuzzy");
    expect(r.match).toBe(WONDERWALL);
    expect(r.confidence).toBeGreaterThanOrEqual(AUTO_ACCEPT);
    expect(r.candidates[0]).toEqual({ song: WONDERWALL, score: r.confidence });
  });

  it("returns candidates but no match when unsure", () => {
    const r = lookup(SONGS, { title: "Wonder", artist: "Unknown Band" });
    expect(r.match).toBeNull();
    expect(r.method).toBe("none");
    for (const c of r.candidates) expect(c.score).toBeGreaterThanOrEqual(MIN_CANDIDATE);
    expect(r.confidence).toBe(r.candidates[0]?.score ?? 0);
  });

  it("finds nothing in an empty catalogue", () => {
    expect(lookup([], { title: "Wonderwall", artist: "Oasis" })).toEqual({ match: null, confidence: 0, method: "none", candidates: [] });
  });

  it("uses a confirmed link first, whatever the title", () => {
    const r = lookup(SONGS, { title: "Totally different title", artist: "x" }, SEVEN);
    expect(r).toEqual({ match: SEVEN, confidence: 1, method: "external-id", candidates: [{ song: SEVEN, score: 1 }] });
  });

  it("ranks candidates best first and keeps at most `limit`", () => {
    const many = Array.from({ length: 8 }, (_, i) => song(10 + i, `Wonderwall ${"x".repeat(i)}`, "Oasis"));
    const r = lookup(many, { title: "Wonderwall Demo", artist: "Oasis" }, null, 3);
    expect(r.candidates).toHaveLength(3);
    const scores = r.candidates.map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});

describe("scoreSong", () => {
  const stored = { titleNorm: "wonderwall", artistNorm: "oasis", durationMs: 258_000 };
  const q = { titleNorm: "wonderwall", artists: ["oasis"] };

  it("uses duration as a tie-breaker: bonus within 3 s, penalty beyond 30 s", () => {
    const partial = { ...q, titleNorm: "wonderwal" };
    const base = scoreSong(stored, partial);
    expect(scoreSong(stored, { ...partial, durationMs: 260_000 })).toBeCloseTo(base + 0.05);
    expect(scoreSong(stored, { ...partial, durationMs: 300_000 })).toBeCloseTo(base - 0.1);
    expect(scoreSong(stored, { ...partial, durationMs: 270_000 })).toBe(base);
  });

  it("stays within [0, 1]", () => {
    expect(scoreSong(stored, { ...q, durationMs: 258_000 })).toBe(1);
    expect(scoreSong({ ...stored, titleNorm: "zzz", artistNorm: "qqq" }, { ...q, durationMs: 1 })).toBe(0);
  });
});

describe("search", () => {
  it("finds songs by part of the title or the artist", () => {
    expect(search(SONGS, "nation")[0].song).toBe(SEVEN);
    expect(search(SONGS, "oasis")[0].song).toBe(WONDERWALL);
    expect(search(SONGS, "white stripes seven nation")[0].song).toBe(SEVEN);
  });

  it("finds nothing for an empty or unrelated query", () => {
    expect(search(SONGS, "  ")).toEqual([]);
    expect(search(SONGS, "qqqq")).toEqual([]);
  });
});
