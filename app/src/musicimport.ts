import { AUDIO_PROBE_BYTES, ID3V1_BYTES, id3v2Size, looksLikeMp3, MAX_TAG_BYTES, parseMp3 } from "./mp3meta";
import type { LocalTrack, MusicLibrary } from "./music";

/**
 * Importing MP3 files into the music library. Each file is checked and its tags
 * read from its first bytes and last 128 bytes only, one file at a time, so a large
 * import never holds more than one file's tag in memory.
 */

/** A file to import: on disk (desktop, by path) or picked in the browser (kept as a copy). */
export interface ImportFile {
  name: string;
  size: number;
  /** `len` bytes from `offset` (fewer at the end of the file). */
  read(offset: number, len: number): Promise<Uint8Array>;
  /** Set for files on disk; the audio of the others is copied into the library. */
  path: string | null;
  /** The audio to keep in the library (files without a path). */
  blob?: Blob;
}

export interface ImportOutcome {
  added: LocalTrack[];
  /** Files already in the library. */
  duplicates: string[];
  /** Of those, files found in a new place (their old path no longer exists): the track now points there. */
  relocated: string[];
  /** The library's tracks for the duplicates (e.g. to add them to a playlist too). */
  existing: LocalTrack[];
  failed: { name: string; reason: string }[];
}

/** Copies kept in the library are capped (a file on disk can be any size). */
export const MAX_COPY_BYTES = 300 * 1024 * 1024;
const FINGERPRINT_BYTES = 256 * 1024;

export const isMp3Name = (name: string) => /\.mp3$/i.test(name.trim());

/** The file name without folders and extension, as a title for untagged files. */
export function titleFromName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\.mp3$/i, "").replace(/_/g, " ").trim() || base;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Same file, same fingerprint: a hash of its first 256 KB, plus its size. */
export async function fingerprint(head: Uint8Array, size: number): Promise<string> {
  return `${size}:${await sha256Hex(head.subarray(0, FINGERPRINT_BYTES))}`;
}

/** A file's tags and first bytes, or why it can't be imported. */
export async function readFile(f: ImportFile): Promise<
  | { ok: true; meta: ReturnType<typeof parseMp3>; head: Uint8Array }
  | { ok: false; reason: string }
> {
  if (!isMp3Name(f.name)) return { ok: false, reason: "not an .mp3 file" };
  if (f.size <= 0) return { ok: false, reason: "the file is empty" };
  if (!f.path && f.size > MAX_COPY_BYTES) return { ok: false, reason: "larger than 300 MB" };
  // One read covers a usual tag, the first frames and the fingerprint; a longer tag needs a second.
  let head = await f.read(0, FINGERPRINT_BYTES);
  const tagSize = id3v2Size(head);
  let audio: Uint8Array | undefined;
  if (tagSize > MAX_TAG_BYTES) {
    // A huge tag (cover art): read its start for the text, and the audio after it.
    head = await f.read(0, MAX_TAG_BYTES);
    audio = await f.read(tagSize, AUDIO_PROBE_BYTES);
  } else if (tagSize + AUDIO_PROBE_BYTES > head.length && head.length < f.size) {
    head = await f.read(0, tagSize + AUDIO_PROBE_BYTES);
  }
  if (!looksLikeMp3(head, audio)) return { ok: false, reason: "not MP3 audio (damaged, or another format renamed .mp3)" };
  const tail = f.size > ID3V1_BYTES ? await f.read(f.size - ID3V1_BYTES, ID3V1_BYTES) : null;
  return { ok: true, meta: parseMp3(head, f.size, tail, audio), head };
}

export type ImportLibrary = Pick<MusicLibrary, "addTrack" | "relocateTrack">;

export interface ImportOptions {
  onProgress?(done: number, total: number): void;
  /** Whether a file on disk still exists (desktop). Lets a moved file take its new path. */
  exists?(path: string): Promise<boolean>;
}

/**
 * Imports `files` one by one. Problems with one file (unreadable, not an MP3,
 * already imported) are reported and the others still go in.
 */
export async function importFiles(files: ImportFile[], lib: ImportLibrary, opts: ImportOptions = {}): Promise<ImportOutcome> {
  const { onProgress, exists } = opts;
  const out: ImportOutcome = { added: [], duplicates: [], relocated: [], existing: [], failed: [] };
  for (const [i, f] of files.entries()) {
    onProgress?.(i, files.length);
    try {
      const r = await readFile(f);
      if (!r.ok) {
        out.failed.push({ name: f.name, reason: r.reason });
        continue;
      }
      const fp = await fingerprint(r.head, f.size);
      // addTrack recognises a file already in the library (same path or content).
      const art = r.meta.art ? { id: await sha256Hex(r.meta.art.data), data: new Blob([r.meta.art.data as Uint8Array<ArrayBuffer>], { type: r.meta.art.mime }) } : null;
      const { track, duplicate } = await lib.addTrack(
        {
          title: r.meta.title ?? titleFromName(f.name),
          artist: r.meta.artist ?? "",
          album: r.meta.album ?? "",
          durationMs: r.meta.durationMs,
          fileName: f.name,
          size: f.size,
          fingerprint: fp,
          path: f.path,
        },
        { art, blob: f.path ? undefined : f.blob },
      );
      if (!duplicate) {
        out.added.push(track);
        continue;
      }
      out.duplicates.push(f.name);
      // Same content at a new path, and the old one is gone: the file was moved.
      if (f.path && track.path && track.path !== f.path && exists && !(await exists(track.path))) {
        out.existing.push((await lib.relocateTrack(track.id, f.path, f.name)) ?? track);
        out.relocated.push(f.name);
      } else out.existing.push(track);
    } catch (e) {
      out.failed.push({ name: f.name, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  onProgress?.(files.length, files.length);
  return out;
}

/** A file picked in the browser (or dropped there), to be copied into the library. */
export function fromBlobFile(file: File): ImportFile {
  return {
    name: file.name,
    size: file.size,
    path: null,
    blob: file,
    read: async (offset, len) => new Uint8Array(await file.slice(offset, offset + len).arrayBuffer()),
  };
}

/** One line on what an import did, for the library page. */
export function importSummary(o: ImportOutcome): string {
  const songs = (n: number) => `${n} ${n === 1 ? "song" : "songs"}`;
  const parts: string[] = [];
  if (o.added.length) parts.push(`Added ${songs(o.added.length)}.`);
  const kept = o.duplicates.length - o.relocated.length;
  if (kept) parts.push(`${songs(kept)} already in your library.`);
  if (o.relocated.length) parts.push(`Found ${songs(o.relocated.length)} in a new place.`);
  if (o.failed.length) {
    const shown = o.failed.slice(0, 3).map((f) => `${f.name} (${f.reason})`).join(", ");
    parts.push(`Couldn't import ${o.failed.length === 1 ? shown : `${o.failed.length} files: ${shown}${o.failed.length > 3 ? ", …" : ""}`}.`);
  }
  return parts.join(" ") || "No files to import.";
}
