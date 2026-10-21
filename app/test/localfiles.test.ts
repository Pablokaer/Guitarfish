import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalTrack } from "../src/music";

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  convertFileSrc: vi.fn((p: string) => `http://asset.localhost/${encodeURIComponent(p)}`),
}));
vi.mock("@tauri-apps/api/core", () => core);
const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

const { filesFromPaths, OPEN_BATCH, pickPaths, readPath, resolveTrack, usesPaths } = await import("../src/localfiles");

const track = (over: Partial<LocalTrack> = {}): LocalTrack => ({
  id: 1,
  title: "Song",
  artist: "Band",
  album: "",
  durationMs: null,
  fileName: "song.mp3",
  size: 10,
  fingerprint: "fp",
  path: "/m/song.mp3",
  artId: null,
  addedAt: 0,
  ...over,
});

beforeEach(() => {
  core.invoke.mockReset();
  core.isTauri.mockReturnValue(true);
  dialog.open.mockReset();
});

describe("usesPaths", () => {
  it("keeps paths in the desktop app only", () => {
    expect(usesPaths("Mozilla/5.0 (Windows NT 10.0)")).toBe(true);
    expect(usesPaths("Mozilla/5.0 (Linux; Android 14)")).toBe(false);
    core.isTauri.mockReturnValue(false);
    expect(usesPaths("Mozilla/5.0 (Windows NT 10.0)")).toBe(false);
  });
});

describe("filesFromPaths", () => {
  it("splits files the shell opened from those it refused", async () => {
    core.invoke.mockResolvedValueOnce([
      { path: "/m/a.mp3", name: "a.mp3", size: 100, error: null },
      { path: "/m/gone.mp3", name: "gone.mp3", size: null, error: "the file is no longer there" },
      { path: "/m/odd", name: "", size: null, error: null },
    ]);
    const { files, failed } = await filesFromPaths(["/m/a.mp3", "/m/gone.mp3", "/m/odd"]);
    expect(core.invoke).toHaveBeenCalledWith("local_audio_open", { paths: ["/m/a.mp3", "/m/gone.mp3", "/m/odd"] });
    expect(files.map((f) => [f.name, f.size, f.path])).toEqual([["a.mp3", 100, "/m/a.mp3"]]);
    expect(failed).toEqual([
      { name: "gone.mp3", reason: "the file is no longer there" },
      { name: "/m/odd", reason: "can't read the file" },
    ]);
    core.invoke.mockResolvedValueOnce(new Uint8Array([1, 2]).buffer);
    expect([...(await files[0].read(5, 2))]).toEqual([1, 2]);
    expect(core.invoke).toHaveBeenLastCalledWith("local_audio_read", { path: "/m/a.mp3", offset: 5, len: 2 });
  });

  it("opens a large selection in batches, losing no file", async () => {
    core.invoke.mockImplementation(async (_cmd: string, args: { paths: string[] }) => args.paths.map((path) => ({ path, name: path, size: 1, error: null })));
    const paths = Array.from({ length: OPEN_BATCH * 2 + 3 }, (_, i) => `/m/${i}.mp3`);
    const { files } = await filesFromPaths(paths);
    expect(files).toHaveLength(paths.length);
    expect(core.invoke).toHaveBeenCalledTimes(3);
    expect(core.invoke.mock.calls.every(([, a]) => (a as { paths: string[] }).paths.length <= OPEN_BATCH)).toBe(true);
  });

  it("reads bytes sent as a list too", async () => {
    core.invoke.mockResolvedValueOnce([7, 8, 9]);
    expect([...(await readPath("/m/a.mp3", 0, 3))]).toEqual([7, 8, 9]);
  });
});

describe("pickPaths", () => {
  it("returns the chosen files, or none when cancelled", async () => {
    dialog.open.mockResolvedValueOnce(["/m/a.mp3", "/m/b.mp3"]);
    expect(await pickPaths()).toEqual(["/m/a.mp3", "/m/b.mp3"]);
    expect(dialog.open).toHaveBeenCalledWith(expect.objectContaining({ multiple: true, filters: [expect.objectContaining({ extensions: expect.arrayContaining(["mp3"]) })] }));
    dialog.open.mockResolvedValueOnce(null);
    expect(await pickPaths()).toEqual([]);
    dialog.open.mockResolvedValueOnce("/m/one.mp3");
    expect(await pickPaths()).toEqual(["/m/one.mp3"]);
  });
});

describe("resolveTrack", () => {
  const lib = { blob: vi.fn() };

  it("opens a file on disk and streams it through the asset protocol", async () => {
    core.invoke.mockResolvedValueOnce([{ path: "/m/song.mp3", name: "song.mp3", size: 10, error: null }]);
    const r = await resolveTrack(track(), lib);
    expect(r.url).toBe("http://asset.localhost/%2Fm%2Fsong.mp3");
    r.release();
    expect(lib.blob).not.toHaveBeenCalled();
  });

  it("reports a file that moved", async () => {
    core.invoke.mockResolvedValueOnce([{ path: "/m/song.mp3", name: "song.mp3", size: null, error: "the file is no longer there" }]);
    await expect(resolveTrack(track(), lib)).rejects.toThrow("Can't play “Song”: the file is no longer there (/m/song.mp3).");
    core.invoke.mockResolvedValueOnce([]);
    await expect(resolveTrack(track(), lib)).rejects.toThrow(/can't be opened/);
  });

  it("plays the library's copy through an object URL, revoked on release", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    lib.blob.mockResolvedValueOnce(new Blob(["x"], { type: "audio/mpeg" }));
    const r = await resolveTrack(track({ path: null }), lib);
    expect(r.url).toMatch(/^blob:/);
    r.release();
    expect(revoke).toHaveBeenCalledWith(r.url);
    lib.blob.mockResolvedValueOnce(null);
    await expect(resolveTrack(track({ path: null }), lib)).rejects.toThrow(/copy is missing/);
  });
});
