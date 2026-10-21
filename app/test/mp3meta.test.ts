import { describe, expect, it } from "vitest";
import { firstFrame, frameHeader, id3v2Size, looksLikeMp3, parseId3v1, parseMp3, resync } from "../src/mp3meta";
import { FRAME_MS, framesFor, id3v2Tag, JPEG, PNG, silentMp3 } from "./mp3fixture";

const tail = (b: Uint8Array) => b.subarray(b.length - 128);
const meta = (b: Uint8Array) => parseMp3(b, b.length, tail(b));

describe("id3v2Size", () => {
  it("reads the tag size, header included", () => {
    const tag = id3v2Tag({ id3: 3, title: "x" });
    expect(id3v2Size(tag)).toBe(tag.length);
    expect(id3v2Size(silentMp3({ id3: 3, title: "x" }))).toBe(tag.length);
  });

  it("is 0 without a tag or with a broken header", () => {
    expect(id3v2Size(silentMp3())).toBe(0);
    expect(id3v2Size(new Uint8Array([0x49, 0x44, 0x33]))).toBe(0);
    const bad = id3v2Tag({ id3: 3, title: "x" });
    bad[6] = 0x80; // not syncsafe
    expect(id3v2Size(bad)).toBe(0);
  });

  it("counts a v2.4 footer", () => {
    const tag = id3v2Tag({ id3: 4, title: "x" });
    tag[5] = 0x10;
    expect(id3v2Size(tag)).toBe(tag.length + 10);
  });
});

describe("parseMp3: tags", () => {
  it.each([2, 3, 4] as const)("reads title, artist, album and the cover from ID3v2.%i", (id3) => {
    const m = meta(silentMp3({ id3, title: "Wonderwall", artist: "Oasis", album: "(What's the Story)", pictures: [{ type: 3, data: JPEG }] }));
    expect(m).toMatchObject({ title: "Wonderwall", artist: "Oasis", album: "(What's the Story)" });
    expect(m.art?.mime).toBe("image/jpeg");
    expect([...m.art!.data]).toEqual([...JPEG]);
  });

  it("decodes non-Latin text", () => {
    expect(meta(silentMp3({ id3: 4, title: "Garota de Ipanema ♪", artist: "João Gilberto" }))).toMatchObject({ title: "Garota de Ipanema ♪", artist: "João Gilberto" });
    expect(meta(silentMp3({ id3: 3, title: "Ação" })).title).toBe("Ação");
  });

  it("prefers the front cover over other pictures, and skips images it can't show", () => {
    const m = meta(silentMp3({ id3: 3, pictures: [{ type: 0, data: new Uint8Array([1, 2, 3, 4]) }, { type: 4, data: JPEG }, { type: 3, data: PNG, mime: "image/png" }] }));
    expect(m.art?.mime).toBe("image/png");
    expect(meta(silentMp3({ id3: 2, pictures: [{ type: 3, data: PNG, mime: "image/png" }] })).art?.mime).toBe("image/png");
  });

  it("falls back to the album artist, then to ID3v1", () => {
    expect(meta(silentMp3({ id3: 3, title: "T", albumArtist: "Band" })).artist).toBe("Band");
    const v1 = meta(silentMp3({ id3v1: { title: "Old Song", artist: "Old Band", album: "Old Album" } }));
    expect(v1).toMatchObject({ title: "Old Song", artist: "Old Band", album: "Old Album", art: null });
    // ID3v2 wins over ID3v1.
    expect(meta(silentMp3({ id3: 3, title: "New", id3v1: { title: "Old" } })).title).toBe("New");
  });

  it.each([2, 3, 4] as const)("reads past an empty frame (ID3v2.%i)", (id3) => {
    const m = meta(silentMp3({ id3, emptyFrame: true, title: "After", artist: "Empty", pictures: [{ type: 3, data: JPEG }] }));
    expect(m).toMatchObject({ title: "After", artist: "Empty" });
    expect(m.art).not.toBeNull();
  });

  it("undoes tag-level unsynchronisation", () => {
    const m = meta(silentMp3({ id3: 3, unsync: true, title: "Sync", pictures: [{ type: 3, data: JPEG }] }));
    expect(m.title).toBe("Sync");
    expect([...m.art!.data]).toEqual([...JPEG]);
  });

  it("returns nulls for a file without tags", () => {
    expect(meta(silentMp3())).toMatchObject({ title: null, artist: null, album: null, art: null });
  });

  it("ignores blank tags", () => {
    expect(parseId3v1(silentMp3({ id3v1: {} }).subarray(-128))).toEqual({ title: null, artist: null, album: null });
    expect(meta(silentMp3({ id3: 3, title: "  " })).title).toBeNull();
  });
});

describe("parseMp3: duration", () => {
  it("estimates a constant-bitrate file from its size", () => {
    const m = meta(silentMp3({ seconds: 10 }));
    expect(m.durationMs).toBeGreaterThan(9900);
    expect(m.durationMs).toBeLessThan(10100);
  });

  it("uses the Xing frame count when there is one", () => {
    const m = meta(silentMp3({ seconds: 5, xing: true, id3: 3, title: "VBR" }));
    expect(m.durationMs).toBe(Math.round(framesFor(5) * FRAME_MS));
  });

  it("doesn't count the ID3v1 tag as audio", () => {
    const plain = meta(silentMp3({ seconds: 3 }));
    expect(meta(silentMp3({ seconds: 3, id3v1: { title: "x" } })).durationMs).toBe(plain.durationMs);
  });

  it("falls back to TLEN when no frame is in the probed bytes", () => {
    const tag = id3v2Tag({ id3: 3, lengthMs: 123456 });
    expect(parseMp3(tag, tag.length).durationMs).toBe(123456);
  });

  it("finds the audio after a tag too large to read, from bytes read past it", () => {
    const tag = id3v2Tag({ id3: 3, title: "Big" });
    const file = silentMp3({ id3: 3, title: "Big", seconds: 4 });
    const audio = file.subarray(tag.length);
    const head = tag.subarray(0, 20); // only the tag's start was read
    expect(looksLikeMp3(head)).toBe(false);
    expect(looksLikeMp3(head, audio)).toBe(true);
    const m = parseMp3(head, file.length, null, audio);
    expect(m.durationMs).toBeGreaterThan(3900);
    expect(m.durationMs).toBeLessThan(4100);
  });

  it("skips padding between the tag and the audio", () => {
    const b = silentMp3({ id3: 3, title: "x", gap: 300 });
    expect(looksLikeMp3(b)).toBe(true);
    expect(meta(b).durationMs).toBeGreaterThan(1900);
  });
});

describe("frame headers", () => {
  it("parses MPEG-1 Layer III", () => {
    expect(frameHeader(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), 0)).toEqual({
      version: 1, layer: 3, bitrate: 128000, sampleRate: 44100, mono: false, samples: 1152, length: 417,
    });
  });

  it("parses MPEG-2 Layer III and Layer I", () => {
    // MPEG-2 L3, 64 kbit/s, 22.05 kHz, mono
    expect(frameHeader(new Uint8Array([0xff, 0xf3, 0x80, 0xc0]), 0)).toMatchObject({ version: 2, layer: 3, bitrate: 64000, sampleRate: 22050, mono: true, samples: 576 });
    // MPEG-1 L1, 384 kbit/s, 48 kHz
    expect(frameHeader(new Uint8Array([0xff, 0xff, 0xc4, 0x00]), 0)).toMatchObject({ layer: 1, bitrate: 384000, samples: 384, length: 96 * 4 });
  });

  it("rejects reserved values", () => {
    expect(frameHeader(new Uint8Array([0xff, 0xeb, 0x90, 0]), 0)).toBeNull(); // reserved version
    expect(frameHeader(new Uint8Array([0xff, 0xf9, 0x90, 0]), 0)).toBeNull(); // reserved layer
    expect(frameHeader(new Uint8Array([0xff, 0xfb, 0xf0, 0]), 0)).toBeNull(); // bad bitrate
    expect(frameHeader(new Uint8Array([0xff, 0xfb, 0x9c, 0]), 0)).toBeNull(); // reserved sample rate
  });

  it("needs a second frame where the first one ends", () => {
    const b = new Uint8Array(1000);
    b.set([0xff, 0xfb, 0x90, 0x00], 10); // a lone header, followed by zeros
    expect(firstFrame(b, 0)).toBeNull();
  });
});

describe("looksLikeMp3", () => {
  it("accepts MPEG audio, with or without a tag", () => {
    expect(looksLikeMp3(silentMp3())).toBe(true);
    expect(looksLikeMp3(silentMp3({ id3: 4, title: "x" }))).toBe(true);
  });

  it("rejects other files", () => {
    expect(looksLikeMp3(new TextEncoder().encode("<html>not audio</html>"))).toBe(false);
    expect(looksLikeMp3(new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0x22]))).toBe(false); // FLAC
    expect(looksLikeMp3(id3v2Tag({ id3: 3, title: "tag only" }))).toBe(false);
  });
});

describe("resync", () => {
  it("drops the zero after each 0xFF", () => {
    expect([...resync(new Uint8Array([1, 0xff, 0, 0xe0, 0xff, 0, 0, 2]))]).toEqual([1, 0xff, 0xe0, 0xff, 0, 2]);
  });
});
