/**
 * Builds small, valid MP3 files for tests: silent MPEG-1 Layer III frames (128 kbit/s,
 * 44.1 kHz) behind optional ID3v2/ID3v1 tags. Browsers decode them (as silence), so
 * the e2e tests play them too.
 */

export const FRAME_BYTES = 417; // 144 * 128000 / 44100, no padding
export const FRAME_MS = (1152 * 1000) / 44100;
/** A 1×1 JPEG's first bytes are enough for the parser (it only checks the signature). */
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

export interface Picture {
  type: number;
  data: Uint8Array;
  mime?: string;
}

export interface Mp3Options {
  seconds?: number;
  /** ID3v2 major version of the tag, if any. */
  id3?: 2 | 3 | 4;
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  lengthMs?: number;
  pictures?: Picture[];
  /** Add a Xing header frame with the real frame count (as VBR encoders do). */
  xing?: boolean;
  /** Apply tag-level unsynchronisation (ID3v2.3). */
  unsync?: boolean;
  id3v1?: { title?: string; artist?: string; album?: string };
  /** Zero bytes between the tag and the first frame. */
  gap?: number;
  /** Start the tag with an empty (size 0) genre frame, as some taggers write. */
  emptyFrame?: boolean;
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};

const syncsafe = (n: number) => new Uint8Array([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const be32 = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
const latin1 = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0) & 0xff));

/** UTF-16 with a little-endian BOM (encoding 1), for v2.2/v2.3. */
function utf16(s: string): Uint8Array {
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    out[2 + i * 2] = s.charCodeAt(i) & 0xff;
    out[3 + i * 2] = s.charCodeAt(i) >> 8;
  }
  return out;
}

function text(version: number, s: string): Uint8Array {
  return version === 4 ? concat([new Uint8Array([3]), new TextEncoder().encode(s)]) : concat([new Uint8Array([1]), utf16(s)]);
}

function picture(version: number, p: Picture): Uint8Array {
  if (version === 2) return concat([new Uint8Array([0]), latin1(p.mime === "image/png" ? "PNG" : "JPG"), new Uint8Array([p.type]), latin1("cover"), new Uint8Array([0]), p.data]);
  return concat([new Uint8Array([0]), latin1(p.mime ?? "image/jpeg"), new Uint8Array([0, p.type]), latin1("cover"), new Uint8Array([0]), p.data]);
}

function frame(version: number, id: string, data: Uint8Array): Uint8Array {
  if (version === 2) return concat([latin1(id.slice(0, 3)), new Uint8Array([(data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff]), data]);
  return concat([latin1(id), version === 4 ? syncsafe(data.length) : be32(data.length), new Uint8Array([0, 0]), data]);
}

/** Inserts 0x00 after every 0xFF that precedes 0x00 or a byte ≥ 0xE0 (ID3 unsynchronisation). */
export function unsynchronise(b: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < b.length; i++) {
    out.push(b[i]);
    if (b[i] === 0xff && (i + 1 === b.length || b[i + 1] === 0 || b[i + 1] >= 0xe0)) out.push(0);
  }
  return new Uint8Array(out);
}

export function id3v2Tag(o: Mp3Options): Uint8Array {
  const v = o.id3 ?? 3;
  const ids = v === 2 ? { title: "TT2", artist: "TP1", albumArtist: "TP2", album: "TAL", length: "TLE", pic: "PIC" } : { title: "TIT2", artist: "TPE1", albumArtist: "TPE2", album: "TALB", length: "TLEN", pic: "APIC" };
  const frames: Uint8Array[] = [];
  if (o.emptyFrame) frames.push(frame(v, v === 2 ? "TCO" : "TCON", new Uint8Array()));
  if (o.title != null) frames.push(frame(v, ids.title, text(v, o.title)));
  if (o.artist != null) frames.push(frame(v, ids.artist, text(v, o.artist)));
  if (o.albumArtist != null) frames.push(frame(v, ids.albumArtist, text(v, o.albumArtist)));
  if (o.album != null) frames.push(frame(v, ids.album, text(v, o.album)));
  if (o.lengthMs != null) frames.push(frame(v, ids.length, concat([new Uint8Array([0]), latin1(String(o.lengthMs))])));
  for (const p of o.pictures ?? []) frames.push(frame(v, ids.pic, picture(v, p)));
  let body = concat([...frames, new Uint8Array(16)]); // and some padding
  if (o.unsync) body = unsynchronise(body);
  return concat([latin1("ID3"), new Uint8Array([v, 0, o.unsync ? 0x80 : 0]), syncsafe(body.length), body]);
}

function audioFrame(): Uint8Array {
  const f = new Uint8Array(FRAME_BYTES);
  f.set([0xff, 0xfb, 0x90, 0x00]);
  return f;
}

/** A Xing frame (stereo MPEG-1: the tag sits 4 + 32 bytes in) counting `frames` audio frames. */
function xingFrame(frames: number): Uint8Array {
  const f = audioFrame();
  f.set(latin1("Xing"), 36);
  f.set(be32(1), 40);
  f.set(be32(frames), 44);
  return f;
}

function id3v1Tag(t: NonNullable<Mp3Options["id3v1"]>): Uint8Array {
  const out = new Uint8Array(128);
  out.set(latin1("TAG"));
  const put = (s: string | undefined, at: number) => s && out.set(latin1(s.slice(0, 30)), at);
  put(t.title, 3);
  put(t.artist, 33);
  put(t.album, 63);
  return out;
}

/** The number of audio frames in a file of `seconds`. */
export const framesFor = (seconds: number) => Math.round((seconds * 1000) / FRAME_MS);

export function silentMp3(o: Mp3Options = {}): Uint8Array {
  const frames = framesFor(o.seconds ?? 2);
  const parts: Uint8Array[] = [];
  if (o.id3) parts.push(id3v2Tag(o));
  if (o.gap) parts.push(new Uint8Array(o.gap));
  if (o.xing) parts.push(xingFrame(frames));
  for (let i = 0; i < frames; i++) parts.push(audioFrame());
  if (o.id3v1) parts.push(id3v1Tag(o.id3v1));
  return concat(parts);
}
