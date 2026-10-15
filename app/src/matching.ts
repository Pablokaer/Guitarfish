import { normalizeArtist, normalizeTitle, similarity, splitArtists } from "./normalize";

/** A catalogue song, as far as matching needs it. */
export interface MatchSong {
  id: number;
  title: string;
  artist: string;
  durationMs: number | null;
}

export interface LookupQuery {
  title: string;
  artist: string;
  durationMs?: number | null;
}

export interface Scored<S> {
  song: S;
  score: number;
}

export interface LookupResult<S> {
  /** Best match when we are confident enough to open it automatically. */
  match: S | null;
  confidence: number;
  method: "external-id" | "exact" | "fuzzy" | "none";
  /** Ranked alternatives, so the user can correct a wrong match. */
  candidates: Scored<S>[];
}

/** Confidence above which the app opens the tab without asking. */
export const AUTO_ACCEPT = 0.82;
/** Candidates below this are not shown at all. */
export const MIN_CANDIDATE = 0.35;

const TITLE_WEIGHT = 0.65;
const ARTIST_WEIGHT = 0.35;

/** A song with its normalized title and artist, computed once per lookup. */
interface Normalized<S> {
  song: S;
  titleNorm: string;
  artistNorm: string;
}

const normalized = <S extends MatchSong>(songs: readonly S[]): Normalized<S>[] =>
  songs.map((song) => ({ song, titleNorm: normalizeTitle(song.title), artistNorm: normalizeArtist(song.artist) }));

/** Score one stored song against a query, in [0, 1]. */
export function scoreSong(
  song: { titleNorm: string; artistNorm: string; durationMs: number | null },
  q: { titleNorm: string; artists: string[]; durationMs?: number | null },
): number {
  const titleSim = similarity(q.titleNorm, song.titleNorm);
  const artistSim = Math.max(0, ...q.artists.map((a) => similarity(a, song.artistNorm)));
  let score = TITLE_WEIGHT * titleSim + ARTIST_WEIGHT * artistSim;

  // Duration is a tie-breaker: different recordings of the same title by the same
  // artist are common (live, acoustic). Small bonus when close, penalty when far.
  if (q.durationMs && song.durationMs) {
    const diff = Math.abs(q.durationMs - song.durationMs);
    if (diff <= 3_000) score += 0.05;
    else if (diff > 30_000) score -= 0.1;
  }
  return Math.max(0, Math.min(1, score));
}

/**
 * Finds the catalogue song for a track, in three steps:
 * 1. `linked`: the song the user confirmed for this track's Spotify ID (certain);
 * 2. exact normalized title and artist, trying each of the track's artists;
 * 3. fuzzy trigram similarity of title and artist, duration as a tie-breaker.
 */
export function lookup<S extends MatchSong>(songs: readonly S[], q: LookupQuery, linked: S | null = null, limit = 5): LookupResult<S> {
  if (linked) return { match: linked, confidence: 1, method: "external-id", candidates: [{ song: linked, score: 1 }] };

  const all = normalized(songs);
  const artists = splitArtists(q.artist);
  const titleNorm = normalizeTitle(q.title);
  for (const a of artists) {
    const hit = all.find((s) => s.titleNorm === titleNorm && s.artistNorm === normalizeArtist(a));
    if (hit) return { match: hit.song, confidence: 0.97, method: "exact", candidates: [{ song: hit.song, score: 0.97 }] };
  }

  // Scans every song: fine for a personal catalogue of thousands of tabs.
  const scored = all
    .map((s) => ({ song: s.song, score: scoreSong({ ...s, durationMs: s.song.durationMs }, { titleNorm, artists, durationMs: q.durationMs }) }))
    .filter((s) => s.score >= MIN_CANDIDATE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => ({ ...s, score: Math.round(s.score * 1000) / 1000 }));

  const best = scored[0];
  if (best && best.score >= AUTO_ACCEPT) {
    return { match: best.song, confidence: best.score, method: "fuzzy", candidates: scored };
  }
  return { match: null, confidence: best?.score ?? 0, method: "none", candidates: scored };
}

/** Free-text search for the manual "find the right song" box. */
export function search<S extends MatchSong>(songs: readonly S[], text: string, limit = 20): Scored<S>[] {
  const qn = normalizeTitle(text);
  if (!qn) return [];
  return normalized(songs)
    .map(({ song, titleNorm, artistNorm }) => {
      const combined = `${artistNorm} ${titleNorm}`;
      const score = Math.max(
        similarity(qn, titleNorm),
        similarity(qn, artistNorm),
        similarity(qn, combined),
        combined.includes(qn) ? 0.9 : 0,
      );
      return { song, score };
    })
    .filter((s) => s.score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
