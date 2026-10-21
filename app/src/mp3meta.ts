/**
 * Reads what Guitarfish needs from an MP3 file without decoding it: the ID3 tags
 * (title, artist, album, cover art) and the duration, from the first MPEG frame
 * (Xing/Info or VBRI header, else the constant bitrate). Only the start of the file
 * (the ID3v2 tag plus a little audio) and its last 128 bytes (ID3v1) are needed.
 */

export interface Mp3Art {
  mime: "image/jpeg" | "image/png";
  data: Uint8Array;
}

export interface Mp3Meta {
  title: string | null;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  art: Mp3Art | null;
}

/** Bytes of audio read after the ID3v2 tag, to find the first frame and its VBR header. */
export const AUDIO_PROBE_BYTES = 64 * 1024;
/** Larger tags (huge cover art) are read only this far; the art is then skipped. */
export const MAX_TAG_BYTES = 16 * 1024 * 1024;
export const ID3V1_BYTES = 128;

const syncsafe = (b: Uint8Array, i: number) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** Total size of the ID3v2 tag at the start of `head` (header and footer included), 0 without one. Needs 10 bytes. */
export function id3v2Size(head: Uint8Array): number {
  if (head.length < 10 || ascii(head, 0, 3) !== "ID3" || head[3] === 0xff || head[4] === 0xff) return 0;
  if ([6, 7, 8, 9].some((i) => head[i] & 0x80)) return 0;
  const footer = head[3] === 4 && head[5] & 0x10 ? 10 : 0;
  return 10 + syncsafe(head, 6) + footer;
}

/** Undoes ID3 unsynchronisation: every 0xFF 0x00 pair goes back to 0xFF. */
export function resync(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

/** Text in an ID3 encoding (0 Latin-1, 1 UTF-16 with BOM, 2 UTF-16BE, 3 UTF-8). */
function decodeText(enc: number, b: Uint8Array): string {
  let label = "latin1";
  let bytes = b;
  if (enc === 1 || enc === 2) {
    label = "utf-16be";
    if (bytes[0] === 0xff && bytes[1] === 0xfe) [label, bytes] = ["utf-16le", bytes.subarray(2)];
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) bytes = bytes.subarray(2);
  } else if (enc === 3) label = "utf-8";
  return new TextDecoder(label).decode(bytes);
}

/** End of a null-terminated string in `enc` from `start` (the terminator's index, or the length). */
function terminator(b: Uint8Array, start: number, enc: number): number {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return b.length;
  }
  const i = b.indexOf(0, start);
  return i < 0 ? b.length : i;
}

/** A text frame's first value (ID3v2.4 separates several with nulls). */
function textFrame(data: Uint8Array): string | null {
  if (!data.length) return null;
  const enc = data[0];
  const end = terminator(data, 1, enc);
  const s = decodeText(enc, data.subarray(1, end)).trim();
  return s || null;
}

function imageMime(data: Uint8Array): Mp3Art["mime"] | null {
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  return null;
}

/** An APIC (v2.3/2.4) or PIC (v2.2) frame: its picture type and image, if it is a JPEG or PNG. */
function pictureFrame(data: Uint8Array, v22: boolean): { type: number; art: Mp3Art } | null {
  if (data.length < 4) return null;
  const enc = data[0];
  let i: number;
  if (v22) i = 4; // encoding, 3-letter format, then the picture type
  else {
    i = data.indexOf(0, 1);
    if (i < 0) return null;
    i += 1;
  }
  const type = data[i];
  const descEnd = terminator(data, i + 1, enc);
  const image = data.subarray(descEnd + (enc === 1 || enc === 2 ? 2 : 1));
  const mime = imageMime(image);
  return mime ? { type, art: { mime, data: image } } : null;
}

interface Id3v2 {
  title: string | null;
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  lengthMs: number | null;
  art: Mp3Art | null;
}

const FRAME_IDS: Record<string, keyof Omit<Id3v2, "art"> | "art"> = {
  TIT2: "title", TT2: "title",
  TPE1: "artist", TP1: "artist",
  TPE2: "albumArtist", TP2: "albumArtist",
  TALB: "album", TAL: "album",
  TLEN: "lengthMs", TLE: "lengthMs",
  APIC: "art", PIC: "art",
};

/** The frames Guitarfish uses from the ID3v2 tag at the start of `head`, or null without one. */
export function parseId3v2(head: Uint8Array): Id3v2 | null {
  const size = id3v2Size(head);
  if (!size) return null;
  const version = head[3];
  if (version < 2 || version > 4) return null;
  const flags = head[5];
  let body = head.subarray(10, Math.min(head.length, 10 + syncsafe(head, 6)));
  // v2.2/2.3 unsynchronise the whole tag; v2.4 marks it per frame.
  if (flags & 0x80 && version < 4) body = resync(body);
  let pos = 0;
  if (flags & 0x40 && version > 2) pos = version === 3 ? 4 + u32(body, 0) : syncsafe(body, 0);

  const out: Id3v2 = { title: null, artist: null, albumArtist: null, album: null, lengthMs: null, art: null };
  let artType = -1;
  const idLen = version === 2 ? 3 : 4;
  const headerLen = version === 2 ? 6 : 10;
  while (pos + headerLen <= body.length) {
    const id = ascii(body, pos, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    const frameSize =
      version === 2 ? (body[pos + 3] << 16) | (body[pos + 4] << 8) | body[pos + 5] : version === 3 ? u32(body, pos + 4) : syncsafe(body, pos + 4);
    const fmt = version === 2 ? 0 : body[pos + 9];
    const start = pos + headerLen;
    pos = start + frameSize;
    if (pos > body.length) break;
    if (frameSize === 0) continue; // an empty frame (some taggers write them): skip it, keep reading
    const field = FRAME_IDS[id];
    if (!field) continue;
    let data = body.subarray(start, pos);
    if (version === 3) {
      if (fmt & 0xc0) continue; // compressed or encrypted
      if (fmt & 0x20) data = data.subarray(1); // group id
    } else if (version === 4) {
      if (fmt & 0x0c) continue; // compressed or encrypted
      if (fmt & 0x40) data = data.subarray(1); // group id
      if (fmt & 0x01) data = data.subarray(4); // data length indicator
      if (fmt & 0x02 || flags & 0x80) data = resync(data);
    }
    if (field === "art") {
      const pic = pictureFrame(data, version === 2);
      // The front cover (type 3) wins over any other picture.
      if (pic && (artType < 0 || (pic.type === 3 && artType !== 3))) {
        out.art = pic.art;
        artType = pic.type;
      }
    } else if (field === "lengthMs") {
      const ms = Number(textFrame(data));
      out.lengthMs = Number.isFinite(ms) && ms > 0 ? ms : null;
    } else {
      out[field] = textFrame(data);
    }
  }
  return out;
}

/** The ID3v1 tag in the file's last 128 bytes. */
export function parseId3v1(tail: Uint8Array | null | undefined): { title: string | null; artist: string | null; album: string | null } | null {
  if (!tail || tail.length < ID3V1_BYTES) return null;
  const t = tail.subarray(tail.length - ID3V1_BYTES);
  if (ascii(t, 0, 3) !== "TAG") return null;
  const field = (i: number) => {
    const raw = t.subarray(i, i + 30);
    const end = raw.indexOf(0);
    const s = new TextDecoder("latin1").decode(end < 0 ? raw : raw.subarray(0, end)).trim();
    return s || null;
  };
  return { title: field(3), artist: field(33), album: field(63) };
}

// ---- MPEG audio frames ------------------------------------------------------------
const BITRATES = {
  v1l1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  v1l2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2l1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  v2l23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] } as const;

export interface FrameHeader {
  version: 1 | 2 | 2.5;
  layer: 1 | 2 | 3;
  bitrate: number; // bits per second
  sampleRate: number;
  mono: boolean;
  samples: number; // per frame
  length: number; // bytes
}

/** The MPEG audio frame header at `i`, or null when the bytes there aren't one. */
export function frameHeader(b: Uint8Array, i: number): FrameHeader | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const v = (b[i + 1] >> 3) & 3;
  const l = (b[i + 1] >> 1) & 3;
  const br = b[i + 2] >> 4;
  const sr = (b[i + 2] >> 2) & 3;
  if (v === 1 || l === 0 || br === 0 || br === 15 || sr === 3) return null;
  const version = v === 3 ? 1 : v === 2 ? 2 : 2.5;
  const layer = (4 - l) as 1 | 2 | 3;
  const table = version === 1 ? (layer === 1 ? BITRATES.v1l1 : layer === 2 ? BITRATES.v1l2 : BITRATES.v1l3) : layer === 1 ? BITRATES.v2l1 : BITRATES.v2l23;
  const bitrate = table[br] * 1000;
  const sampleRate = SAMPLE_RATES[version][sr];
  const padding = (b[i + 2] >> 1) & 1;
  const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
  const length = layer === 1 ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4 : Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  return { version, layer, bitrate, sampleRate, mono: b[i + 3] >> 6 === 3, samples, length };
}

/**
 * The first MPEG frame at or after `from`: a header followed by another one (when
 * the buffer reaches that far), so stray 0xFF bytes in padding aren't taken for audio.
 */
export function firstFrame(b: Uint8Array, from: number): { offset: number; header: FrameHeader } | null {
  for (let i = from; i + 4 <= b.length; i++) {
    if (b[i] !== 0xff) continue;
    const h = frameHeader(b, i);
    if (!h) continue;
    const next = i + h.length;
    if (next + 4 <= b.length && !frameHeader(b, next)) continue;
    return { offset: i, header: h };
  }
  return null;
}

/** Frame count from a Xing/Info or VBRI header in the first frame, if it has one. */
function vbrFrames(b: Uint8Array, offset: number, h: FrameHeader): number | null {
  const side = h.version === 1 ? (h.mono ? 17 : 32) : h.mono ? 9 : 17;
  const x = offset + 4 + side;
  if (x + 12 <= b.length) {
    const tag = ascii(b, x, 4);
    if ((tag === "Xing" || tag === "Info") && u32(b, x + 4) & 1) return u32(b, x + 8) || null;
  }
  const vbri = offset + 36;
  if (vbri + 18 <= b.length && ascii(b, vbri, 4) === "VBRI") return u32(b, vbri + 14) || null;
  return null;
}

/**
 * Whether the file holds MPEG audio after any ID3v2 tag: in `head` (the file's
 * start), or in `audio` (bytes read from the tag's end, for a tag too large to read).
 */
export function looksLikeMp3(head: Uint8Array, audio?: Uint8Array): boolean {
  return (audio ? firstFrame(audio, 0) : firstFrame(head, id3v2Size(head))) !== null;
}

/**
 * Metadata of an MP3 file from its start (`head`: the ID3v2 tag plus some audio),
 * its size and its last 128 bytes. A tag larger than MAX_TAG_BYTES is read only in
 * part: then `audio` holds the bytes after the tag. Fields the file doesn't have are null.
 */
export function parseMp3(head: Uint8Array, fileSize: number, tail?: Uint8Array | null, audio?: Uint8Array): Mp3Meta {
  const v2 = parseId3v2(head);
  const v1 = parseId3v1(tail);
  const tagSize = id3v2Size(head);
  const [buf, base, from] = audio ? [audio, tagSize, 0] : [head, 0, tagSize];
  const frame = firstFrame(buf, from);
  let durationMs: number | null = null;
  if (frame) {
    const frames = vbrFrames(buf, frame.offset, frame.header);
    if (frames) durationMs = (frames * frame.header.samples * 1000) / frame.header.sampleRate;
    else {
      const audioBytes = fileSize - base - frame.offset - (v1 ? ID3V1_BYTES : 0);
      if (audioBytes > 0) durationMs = (audioBytes * 8 * 1000) / frame.header.bitrate;
    }
  }
  durationMs ??= v2?.lengthMs ?? null;
  return {
    title: v2?.title ?? v1?.title ?? null,
    artist: v2?.artist ?? v2?.albumArtist ?? v1?.artist ?? null,
    album: v2?.album ?? v1?.album ?? null,
    durationMs: durationMs != null ? Math.round(durationMs) : null,
    art: v2?.art ?? null,
  };
}
