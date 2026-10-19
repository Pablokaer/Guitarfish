import { describe, expect, it } from "vitest";
import { detectKey } from "../src/key";
import { alternativesOf, KeyStore, parseKeys } from "../src/solos";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
  };
}

describe("parseKeys", () => {
  it("keeps only valid keys looked up, heard or picked", () => {
    expect(
      parseKeys({
        a: { tonic: 9, mode: "minor", source: "mic" },
        b: { tonic: 0, mode: "major", source: "manual" },
        c: { tonic: 12, mode: "major", source: "manual" },
        d: { tonic: 2, mode: "dorian", source: "manual" },
        e: { tonic: 2, mode: "major", source: "tab" },
        f: null,
        g: { tonic: 6, mode: "minor", source: "online", tempo: 87.4 },
        h: { tonic: 6, mode: "minor", source: "online", tempo: -3 },
      }),
    ).toEqual({
      a: { tonic: 9, mode: "minor", source: "mic" },
      b: { tonic: 0, mode: "major", source: "manual" },
      g: { tonic: 6, mode: "minor", source: "online", tempo: 87.4 },
      h: { tonic: 6, mode: "minor", source: "online" },
    });
    expect(parseKeys([1, 2])).toEqual({});
    expect(parseKeys("x")).toEqual({});
  });
});

describe("KeyStore", () => {
  it("remembers a song's key across instances and forgets it on request", () => {
    const storage = memoryStorage();
    new KeyStore("k", storage).set("song", { tonic: 4, mode: "minor", source: "manual" });
    const again = new KeyStore("k", storage);
    expect(again.get("song")).toEqual({ tonic: 4, mode: "minor", source: "manual" });
    again.forget("song");
    expect(new KeyStore("k", storage).get("song")).toBeNull();
  });

  it("survives corrupt storage", () => {
    expect(new KeyStore("k", memoryStorage({ k: "{nope" })).get("x")).toBeNull();
  });
});

describe("alternativesOf", () => {
  it("offers the next three keys", () => {
    const r = detectKey([5, 0, 2, 0, 4, 2, 0, 4, 0, 2, 0, 1])!;
    const alt = alternativesOf(r);
    expect(alt).toHaveLength(3);
    expect(alt).not.toContainEqual(r.key);
  });
});
