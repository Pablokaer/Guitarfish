import { describe, expect, it } from "vitest";
import { normalizeArtist, normalizeTitle, similarity, splitArtists } from "../src/normalize";

describe("normalizeTitle", () => {
  it.each([
    ["Wonderwall - Remastered", "wonderwall"],
    ["Hotel California - 2013 Remaster", "hotel california"],
    ["Come As You Are (Remastered 2021)", "come as you are"],
    ["Song Name (feat. Someone Else)", "song name"],
    ["Song Name [Live]", "song name"],
    ["Song Name - Live at Wembley 1986", "song name"],
    ["Knockin' On Heaven's Door", "knockin on heavens door"],
    ["Ação & Reação", "acao and reacao"],
    ["Live Forever", "live forever"], // "live" in the actual title must survive
  ])("%s -> %s", (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });
});

describe("artists", () => {
  it("strips leading 'the'", () => expect(normalizeArtist("The White Stripes")).toBe("white stripes"));
  it("removes accents", () => expect(normalizeArtist("Legião Urbana")).toBe("legiao urbana"));
  it("splits combined artists", () => {
    expect(splitArtists("Artist A, Artist B")).toEqual(["artist a", "artist b", "artist a artist b"]);
    expect(splitArtists("Simon & Garfunkel")).toContain("simon and garfunkel");
  });
});

describe("similarity", () => {
  it("is 1 for identical strings", () => expect(similarity("abc", "abc")).toBe(1));
  it("is high for small typos", () => expect(similarity("sweet child o mine", "sweet child of mine")).toBeGreaterThan(0.6));
  it("is low for unrelated strings", () => expect(similarity("wonderwall", "hotel california")).toBeLessThan(0.15));
});
