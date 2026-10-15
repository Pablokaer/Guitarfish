import { describe, expect, it } from "vitest";
import { ACCEPTED_EXTENSIONS, checkImport, formatOf, MAX_TAB_BYTES } from "../src/tabfile";

const bytes = (...parts: (string | number[])[]): ArrayBuffer => {
  const out: number[] = [];
  for (const p of parts) out.push(...(typeof p === "string" ? [...new TextEncoder().encode(p)] : p));
  return new Uint8Array(out).buffer;
};
/** Guitar Pro 3–5: a length byte, then the version string. */
const GP5 = bytes([24], "FICHIER GUITAR PRO v5.00", [0, 0, 0, 0]);
const ZIP = bytes([0x50, 0x4b, 0x03, 0x04], [20, 0, 0, 0]);
const GPX = bytes("BCFZ", [1, 2, 3, 4]);
const TEX = bytes('\\title "Test"\n.\n:4 0.6 0.5 |');
const XML = bytes('<?xml version="1.0"?>\n<!DOCTYPE score-partwise>\n<score-partwise version="3.1"><part-list/></score-partwise>');

const input = (fileName: string, data: ArrayBuffer, over: Partial<{ title: string; artist: string }> = {}) => ({
  fileName,
  data,
  title: "Wonderwall",
  artist: "Oasis",
  ...over,
});

describe("formatOf", () => {
  it.each([
    ["song.gp", "gp"],
    ["song.gp3", "gp"],
    ["song.gp4", "gp"],
    ["SONG.GP5", "gp"],
    ["song.gp6", "gp"],
    ["song.gp7", "gp"],
    ["song.gpx", "gp"],
    ["song.alphatex", "alphatex"],
    ["song.atex", "alphatex"],
    ["song.musicxml", "musicxml"],
    ["song.xml", "musicxml"],
    ["song.mxl", "musicxml"],
    ["my.song.v2.gp5", "gp"],
  ])("%s is %s", (name, format) => {
    expect(formatOf(name)).toBe(format);
  });

  it.each(["song", "song.pdf", "song.txt", "song.gp2", "gp5", "song.gp5.zip", ""])("rejects %j", (name) => {
    expect(formatOf(name)).toBeNull();
  });

  it("lists the extensions for the file picker", () => {
    expect(ACCEPTED_EXTENSIONS).toEqual([".gp", ".gp3", ".gp4", ".gp5", ".gp6", ".gp7", ".gpx", ".alphatex", ".atex", ".musicxml", ".xml", ".mxl"]);
  });
});

describe("checkImport", () => {
  it.each([
    ["song.gp5", GP5, "gp"],
    ["song.gp", ZIP, "gp"],
    ["song.gpx", GPX, "gp"],
    ["song.alphatex", TEX, "alphatex"],
    ["song.musicxml", XML, "musicxml"],
    ["song.mxl", ZIP, "musicxml"],
  ])("accepts %s", (name, data, format) => {
    expect(checkImport(input(name, data))).toEqual({ ok: true, value: { format, name, title: "Wonderwall", artist: "Oasis" } });
  });

  it("trims the artist, the title and the file name", () => {
    const r = checkImport({ ...input(" song.gp5 ", GP5), title: "  Wonderwall ", artist: " Oasis  " });
    expect(r).toEqual({ ok: true, value: { format: "gp", name: "song.gp5", title: "Wonderwall", artist: "Oasis" } });
  });

  it("detects the format from the extension, not from what the bytes resemble", () => {
    // A Guitar Pro 7 file and a compressed MusicXML file are both ZIP archives.
    expect(checkImport(input("a.gp", ZIP))).toMatchObject({ ok: true, value: { format: "gp" } });
    expect(checkImport(input("a.mxl", ZIP))).toMatchObject({ ok: true, value: { format: "musicxml" } });
  });

  it("rejects an unsupported file type", () => {
    expect(checkImport(input("song.pdf", GP5))).toEqual({ ok: false, error: expect.stringMatching(/^Unsupported file type\. Use Guitar Pro/) });
  });

  it("rejects an empty or too large file", () => {
    expect(checkImport(input("song.gp5", new ArrayBuffer(0)))).toEqual({ ok: false, error: "The file is empty." });
    expect(checkImport(input("song.alphatex", new ArrayBuffer(MAX_TAB_BYTES + 1)))).toEqual({ ok: false, error: "The file is too large (20 MB at most)." });
  });

  it.each([
    ["song.gp5", TEX, "This isn't a Guitar Pro file."],
    ["song.gpx", XML, "This isn't a Guitar Pro file."],
    ["song.gp", bytes("PK"), "This isn't a Guitar Pro file."],
    ["song.xml", bytes("<html><body>hi</body></html>"), "This isn't a MusicXML score."],
    ["song.musicxml", GP5, "This isn't a MusicXML score."],
    ["song.mxl", XML, "This isn't a compressed MusicXML (.mxl) file."],
    ["song.alphatex", GP5, "This isn't an alphaTex text file."],
    ["song.atex", bytes("   \n\t "), "This isn't an alphaTex text file."],
  ])("rejects %s whose content doesn't match", (name, data, error) => {
    expect(checkImport(input(name, data))).toEqual({ ok: false, error });
  });

  it("requires the artist and the title", () => {
    expect(checkImport(input("song.gp5", GP5, { artist: "  " }))).toEqual({ ok: false, error: "Enter the artist." });
    expect(checkImport(input("song.gp5", GP5, { title: "" }))).toEqual({ ok: false, error: "Enter the song title." });
  });

  it("limits the artist and the title to 200 characters", () => {
    expect(checkImport(input("song.gp5", GP5, { title: "x".repeat(200) })).ok).toBe(true);
    expect(checkImport(input("song.gp5", GP5, { title: "x".repeat(201) }))).toEqual({ ok: false, error: "The title is too long (200 characters at most)." });
    expect(checkImport(input("song.gp5", GP5, { artist: "x".repeat(201) }))).toEqual({ ok: false, error: "The artist is too long (200 characters at most)." });
  });

  it("checks the file before the names", () => {
    expect(checkImport(input("song.pdf", GP5, { artist: "", title: "" })).ok).toBe(false);
    expect((checkImport(input("song.pdf", GP5, { artist: "" })) as { error: string }).error).toMatch(/Unsupported/);
  });
});
