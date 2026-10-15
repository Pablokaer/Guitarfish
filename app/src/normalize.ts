/**
 * Title and artist normalization for the on-device catalogue (see matching.ts).
 * Imported songs and Spotify tracks go through the same functions, so their keys agree.
 */

// Suffixes that streaming services append to titles but tab sites usually omit.
const TITLE_NOISE: RegExp[] = [
  // "Song - Remastered 2011", "Song - Live at Wembley", "Song - Radio Edit", "Song - 2015 Remaster"
  /\s+-\s+(?:\d{4}\s+)?(?:re-?master(?:ed)?|live|radio edit|single version|album version|mono|stereo|demo|acoustic|edit|version|mix|remix|bonus track|from\b|recorded\b|bbc\b|deluxe)\b.*$/i,
  // "(feat. X)", "[feat. X]", "(with X)"
  /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]*[)\]]/gi,
  // "(Remastered 2009)", "[Live]", "(2011 Remaster)", "(Radio Edit)"
  /\s*[([][^)\]]*(?:re-?master|live|edit|version|mono|stereo|demo|acoustic|remix|mix|deluxe)[^)\]]*[)\]]/gi,
];

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function basicNormalize(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining accents
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`´]/g, "") // "don't" -> "dont"
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Normalize a track title: drop remaster/live/feat. noise, then basic normalize. */
export function normalizeTitle(title: string): string {
  let t = title;
  for (const re of TITLE_NOISE) t = t.replace(re, "");
  const out = basicNormalize(t);
  // Never return empty: fall back to the raw normalized title.
  return out || basicNormalize(title);
}

/** Normalize an artist string. Also strips a leading "the ". */
export function normalizeArtist(artist: string): string {
  return basicNormalize(artist).replace(/^the /, "");
}

/**
 * Split a combined artist string ("A, B", "A & B", "A feat. B") into individual
 * normalized artists. The first entry is the primary artist.
 */
export function splitArtists(artist: string): string[] {
  const parts = artist
    .split(/\s*(?:,|;|\/|\s&\s|\sx\s|\sfeat\.?\s|\sft\.?\s|\sfeaturing\s|\swith\s)\s*/i)
    .map(normalizeArtist)
    .filter(Boolean);
  const whole = normalizeArtist(artist);
  return Array.from(new Set([...parts, whole].filter(Boolean)));
}

/** Character trigrams with padding, as used by Postgres pg_trgm. */
export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of s.split(" ")) {
    if (!word) continue;
    const w = `  ${word} `;
    for (let i = 0; i < w.length - 2; i++) out.add(w.slice(i, i + 3));
  }
  return out;
}

/** Trigram similarity in [0, 1] (Jaccard index, same definition as pg_trgm). */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}
