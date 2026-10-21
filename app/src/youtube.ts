import type { Track } from "./types";

/**
 * YouTube reports a video, not a song: its title ("Oasis - Wonderwall (Official
 * Video)") and its channel ("OasisVEVO", "Oasis - Topic", a label, a cover
 * channel) as the artist. These turn that into the song's title and artist, so
 * the tab search works as for a Spotify track. YouTube Music already reports
 * songs; only its channel suffixes are tidied.
 */

/** Words that mark a bracketed or trailing part of a title as video noise, not part of the song's name. */
const NOISE =
  /\b(official|oficial|video|vídeo|videoclipe?|clipe?|audio|áudio|lyrics?|letra|legendad[oa]|tradu[çc][ãa]o|visuali[sz]er|hd|hq|4k|8k|mv|m\/v|remaster(ed)?|full song|music video|with lyrics)\b/iu;

/** "(Official Video)", "[HD]", "【MV】", "(Clipe Oficial)": a bracketed part made of noise. */
const BRACKETS = /\s*[([【「]([^)\]】」]*)[)\]】」]/gu;

/** Title and artist separators: "Artist - Title", "Artist – Title", "Artist — Title". */
const DASH = /\s+[-–—]\s+/u;

/** The channel's name without YouTube's decorations. */
export function cleanChannel(channel: string): string {
  let c = channel.trim().replace(/\s+-\s+Topic$/iu, "");
  const vevo = /^(.+?)\s*VEVO$/u.exec(c);
  if (vevo) {
    c = vevo[1];
    // "ArcticMonkeysVEVO": the channel name has no spaces; put them back.
    if (!/\s/.test(c)) c = c.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2");
  }
  c = c.replace(/\s+(official( channel)?|oficial|canal oficial|tv)$/iu, "");
  return c.trim();
}

/** The title without video noise: bracketed tags, "| …" tails, hashtags, "official video" suffixes. */
export function cleanVideoTitle(title: string): string {
  let t = title.replace(BRACKETS, (whole, inner: string) => (NOISE.test(inner) ? "" : whole));
  // "Song | Official Video", "Artist - Song | Lyrics": the first part is the song.
  t = t.split(/\s+[|｜]\s+/u)[0];
  t = t.replace(/\s+#[\p{L}\p{N}_]+/gu, "");
  // "Song Official Video" without brackets.
  t = t.replace(/\s+(official\s+(music\s+)?video|official\s+audio|lyric\s+video|clipe\s+oficial|v[ií]deo\s+oficial)\s*$/iu, "");
  return t.replace(/\s{2,}/g, " ").trim();
}

/** Artist and title from a video title, when it names both ("Artist - Title", `Artist "Title"`). */
export function splitVideoTitle(title: string): { artist: string; title: string } | null {
  const dash = DASH.exec(title);
  if (dash) {
    const artist = title.slice(0, dash.index).trim();
    const song = title.slice(dash.index + dash[0].length).trim();
    if (artist && song) return { artist, title: song };
  }
  const quoted = /^(.+?)\s+["“'‘](.+?)["”'’]/u.exec(title);
  if (quoted) return { artist: quoted[1].trim(), title: quoted[2].trim() };
  return null;
}

/**
 * A playing track as Guitarfish should search it. YouTube videos and media in a
 * browser (mostly YouTube) are read as above; other tracks are left alone.
 */
export function songOf(track: Track): Track {
  const service = track.service;
  if (service === "youtube-music") return { ...track, artist: cleanChannel(track.artist) };
  if (service !== "youtube" && service !== "browser") return track;
  const cleaned = cleanVideoTitle(track.title);
  const split = splitVideoTitle(cleaned);
  const channel = cleanChannel(track.artist);
  return {
    ...track,
    // The title naming the artist beats the channel, which may be a label or a cover channel.
    artist: split ? split.artist : channel,
    title: split ? split.title : cleaned || track.title,
    album: null,
  };
}
