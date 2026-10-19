import { invoke, isTauri } from "@tauri-apps/api/core";
import { cleanTitle, mainArtist } from "./match";
import type { Key } from "./scales";
import type { Track } from "./types";

/** The key of a recording as the `song_key` command returns it (src-tauri/src/songkey.rs). */
export interface SongKeyAnswer extends Key {
  tempo: number | null;
  via: "spotify-id" | "isrc";
}

/** Validates the command's answer; anything unexpected is no answer. */
export function parseSongKey(raw: unknown): SongKeyAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.tonic !== "number" || !Number.isInteger(r.tonic) || r.tonic < 0 || r.tonic > 11) return null;
  if (r.mode !== "major" && r.mode !== "minor") return null;
  if (r.via !== "spotify-id" && r.via !== "isrc") return null;
  const tempo = typeof r.tempo === "number" && Number.isFinite(r.tempo) && r.tempo > 0 ? r.tempo : null;
  return { tonic: r.tonic, mode: r.mode, tempo, via: r.via };
}

export function canLookUpKeys(): boolean {
  return isTauri();
}

/**
 * Looks up the key of the playing recording (Spotify's analysis, served by
 * ReccoBeats; by Spotify id, or by title and artist through Deezer). Resolves null
 * when no matching recording has a key; rejects when the services can't be reached.
 */
export async function lookUpSongKey(t: Pick<Track, "title" | "artist" | "spotifyId">): Promise<SongKeyAnswer | null> {
  if (!isTauri()) return null;
  const raw = await invoke("song_key", { title: cleanTitle(t.title), artist: mainArtist(t.artist), spotifyId: t.spotifyId ?? null });
  return parseSongKey(raw);
}
