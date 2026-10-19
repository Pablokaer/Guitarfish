import { describe, expect, it } from "vitest";
import { parseSongKey } from "../src/songkey";

describe("parseSongKey", () => {
  it("accepts the command's answer", () => {
    expect(parseSongKey({ tonic: 1, mode: "major", tempo: 148.1, via: "isrc" })).toEqual({ tonic: 1, mode: "major", tempo: 148.1, via: "isrc" });
    expect(parseSongKey({ tonic: 9, mode: "minor", tempo: null, via: "spotify-id" })).toEqual({ tonic: 9, mode: "minor", tempo: null, via: "spotify-id" });
  });

  it("drops a tempo that isn't a positive number", () => {
    expect(parseSongKey({ tonic: 0, mode: "major", tempo: 0, via: "isrc" })?.tempo).toBeNull();
    expect(parseSongKey({ tonic: 0, mode: "major", tempo: "fast", via: "isrc" })?.tempo).toBeNull();
  });

  it("rejects anything else", () => {
    expect(parseSongKey(null)).toBeNull();
    expect(parseSongKey({ tonic: 12, mode: "major", via: "isrc" })).toBeNull();
    expect(parseSongKey({ tonic: 1.5, mode: "major", via: "isrc" })).toBeNull();
    expect(parseSongKey({ tonic: 1, mode: "dorian", via: "isrc" })).toBeNull();
    expect(parseSongKey({ tonic: 1, mode: "major", via: "guess" })).toBeNull();
  });
});
