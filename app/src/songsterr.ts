import { invoke, isTauri } from "@tauri-apps/api/core";
import type { SongsterrResult } from "./types";

function isResult(v: unknown): v is SongsterrResult {
  const r = v as SongsterrResult;
  return (
    !!r &&
    typeof r.songId === "number" &&
    typeof r.title === "string" &&
    typeof r.artist === "string" &&
    typeof r.url === "string" &&
    Array.isArray(r.instruments) &&
    r.instruments.every((i) => typeof i === "string")
  );
}

/**
 * Searches Songsterr's catalogue (links only). The request runs in the app shell
 * (the `songsterr_search` command): the webview can't call songsterr.com itself.
 * Rejects when Songsterr can't be reached, and always outside the app.
 */
export async function searchSongsterr(query: string): Promise<SongsterrResult[]> {
  if (!isTauri()) throw new Error("Songsterr search needs the Guitarfish app");
  let raw: unknown;
  try {
    raw = await invoke("songsterr_search", { query });
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
  return Array.isArray(raw) ? raw.filter(isResult) : [];
}
