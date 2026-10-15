import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SongsterrResult } from "../src/types";

const core = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => core);

const { searchSongsterr } = await import("../src/songsterr");

const uprising: SongsterrResult = {
  songId: 29482,
  title: "Uprising",
  artist: "Muse",
  instruments: ["Distortion Guitar", "Synth Bass 1"],
  url: "https://www.songsterr.com/a/wa/song?id=29482",
};

beforeEach(() => {
  core.invoke.mockReset();
  core.isTauri.mockReturnValue(true);
});

describe("searchSongsterr", () => {
  it("asks the app shell's songsterr_search command", async () => {
    core.invoke.mockResolvedValue([uprising]);
    expect(await searchSongsterr("Muse Uprising")).toEqual([uprising]);
    expect(core.invoke).toHaveBeenCalledWith("songsterr_search", { query: "Muse Uprising" });
  });

  it("keeps only well-formed results", async () => {
    core.invoke.mockResolvedValue([uprising, { songId: "1", title: "x" }, null, { ...uprising, instruments: "Guitar" }]);
    expect(await searchSongsterr("Muse")).toEqual([uprising]);
    core.invoke.mockResolvedValue({ results: [uprising] });
    expect(await searchSongsterr("Muse")).toEqual([]);
  });

  it("rejects with the command's message when the search fails", async () => {
    core.invoke.mockRejectedValue("Songsterr search failed: timeout");
    await expect(searchSongsterr("Muse")).rejects.toThrow("Songsterr search failed: timeout");
  });

  it("needs the app: in a plain browser it fails without calling anything", async () => {
    core.isTauri.mockReturnValue(false);
    await expect(searchSongsterr("Muse")).rejects.toThrow(/Guitarfish app/);
    expect(core.invoke).not.toHaveBeenCalled();
  });
});
