import type { TabFormat } from "./types";

/** File extensions the importer takes, by format. alphaTab reads all of them. */
const EXTENSIONS: Record<string, TabFormat> = {
  ".gp": "gp", // Guitar Pro 7 and 8
  ".gp3": "gp",
  ".gp4": "gp",
  ".gp5": "gp",
  ".gp6": "gp",
  ".gp7": "gp",
  ".gpx": "gp", // Guitar Pro 6
  ".alphatex": "alphatex",
  ".atex": "alphatex",
  ".musicxml": "musicxml",
  ".xml": "musicxml",
  ".mxl": "musicxml", // compressed MusicXML
};

/** For the file picker's `accept` attribute. */
export const ACCEPTED_EXTENSIONS: readonly string[] = Object.keys(EXTENSIONS);
export const MAX_TAB_BYTES = 20 * 1024 * 1024;
export const MAX_NAME_CHARS = 200;
export const TOO_LARGE = "The file is too large (20 MB at most).";
/** How much of a text file is read to recognise it. */
const SNIFF_BYTES = 64 * 1024;

export interface ImportInput {
  fileName: string;
  data: ArrayBuffer;
  title: string;
  artist: string;
}

/** A file ready for the catalogue: its format, and the trimmed names. */
export interface CheckedImport {
  format: TabFormat;
  /** The file's name, shown to tell several tabs of a song apart. */
  name: string;
  title: string;
  artist: string;
}

export type ImportCheck = { ok: true; value: CheckedImport } | { ok: false; error: string };

/** The format of a tab file, from its extension. Null: not a supported file. */
export function formatOf(fileName: string): TabFormat | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXTENSIONS[fileName.slice(dot).trim().toLowerCase()] ?? null;
}

const startsWith = (b: Uint8Array, magic: string, at = 0) =>
  b.length >= at + magic.length && [...magic].every((c, i) => b[at + i] === c.charCodeAt(0));

const isZip = (b: Uint8Array) => startsWith(b, "PK\x03\x04");

function isGuitarPro(b: Uint8Array): boolean {
  // GP7/8: ZIP. GP6 (.gpx): a BCFZ/BCFS container. GP3-5: a length byte, then the version.
  return isZip(b) || startsWith(b, "BCFZ") || startsWith(b, "BCFS") || startsWith(b, "FICHIER GUITAR PRO", 1);
}

function text(b: Uint8Array): string {
  const head = b.subarray(0, SNIFF_BYTES);
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder("utf-16le").decode(head);
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder("utf-16be").decode(head);
  return new TextDecoder().decode(head);
}

const isMusicXml = (b: Uint8Array) => /<score-(?:partwise|timewise)\b/.test(text(b));

/** alphaTex is plain text: no NUL bytes, and not blank. */
const isAlphaTex = (b: Uint8Array) => !b.subarray(0, SNIFF_BYTES).includes(0) && text(b).trim() !== "";

/** Why the content doesn't match the format, or null when it does. */
function contentError(format: TabFormat, fileName: string, b: Uint8Array): string | null {
  switch (format) {
    case "gp":
      return isGuitarPro(b) ? null : "This isn't a Guitar Pro file.";
    case "musicxml":
      if (fileName.toLowerCase().endsWith(".mxl")) return isZip(b) ? null : "This isn't a compressed MusicXML (.mxl) file.";
      return isMusicXml(b) ? null : "This isn't a MusicXML score.";
    case "alphatex":
      return isAlphaTex(b) ? null : "This isn't an alphaTex text file.";
  }
}

function nameError(value: string, what: "artist" | "title"): string | null {
  if (!value) return what === "artist" ? "Enter the artist." : "Enter the song title.";
  if (value.length > MAX_NAME_CHARS) return `The ${what} is too long (${MAX_NAME_CHARS} characters at most).`;
  return null;
}

/** Checks a file to import and the song it is for: the file first, then the names. */
export function checkImport(input: ImportInput): ImportCheck {
  const name = input.fileName.trim();
  const format = formatOf(name);
  if (!format) {
    return {
      ok: false,
      error: "Unsupported file type. Use Guitar Pro (.gp, .gp3–.gp7, .gpx), alphaTex (.alphatex, .atex) or MusicXML (.musicxml, .xml, .mxl).",
    };
  }
  if (input.data.byteLength === 0) return { ok: false, error: "The file is empty." };
  if (input.data.byteLength > MAX_TAB_BYTES) return { ok: false, error: TOO_LARGE };
  const bad = contentError(format, name, new Uint8Array(input.data));
  if (bad) return { ok: false, error: bad };

  const artist = input.artist.trim();
  const title = input.title.trim();
  const missing = nameError(artist, "artist") ?? nameError(title, "title");
  if (missing) return { ok: false, error: missing };
  return { ok: true, value: { format, name: name.slice(0, MAX_NAME_CHARS), title, artist } };
}
