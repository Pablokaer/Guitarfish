import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanPlaylistName, MusicLibrary, type NewLocalTrack } from "../src/music";

const file = (n: number, over: Partial<NewLocalTrack> = {}): NewLocalTrack => ({
  title: `Song ${n}`,
  artist: "Band",
  album: "Album",
  durationMs: 1000 * n,
  fileName: `song${n}.mp3`,
  size: 1000 + n,
  fingerprint: `fp${n}`,
  path: `/music/song${n}.mp3`,
  ...over,
});
const art = (id: string) => ({ id, data: new Blob([new Uint8Array([0xff, 0xd8])], { type: "image/jpeg" }) });

let factory: IDBFactory;
let lib: MusicLibrary;

beforeEach(async () => {
  factory = new IDBFactory();
  lib = await MusicLibrary.open(factory);
});

describe("tracks", () => {
  it("adds tracks and lists them", async () => {
    const { track, duplicate } = await lib.addTrack(file(1));
    expect(duplicate).toBe(false);
    expect(track).toMatchObject({ title: "Song 1", path: "/music/song1.mp3", artId: null });
    await lib.addTrack(file(2));
    expect((await lib.tracks()).map((t) => t.title)).toEqual(["Song 1", "Song 2"]);
    expect(await lib.track(track.id)).toEqual(track);
    expect(await lib.track(999)).toBeNull();
  });

  it("persists across reopening", async () => {
    await lib.addTrack(file(1));
    lib.close();
    const again = await MusicLibrary.open(factory);
    expect(await again.tracks()).toHaveLength(1);
  });

  it("detects the same path or the same content as a duplicate", async () => {
    const first = (await lib.addTrack(file(1))).track;
    const samePath = await lib.addTrack(file(2, { path: "/music/song1.mp3" }));
    expect(samePath).toEqual({ track: first, duplicate: true });
    const sameContent = await lib.addTrack(file(3, { fingerprint: "fp1", path: "/elsewhere/copy.mp3" }));
    expect(sameContent.duplicate).toBe(true);
    // Copies kept in the library have no path: only the content counts.
    await lib.addTrack(file(4, { path: null }));
    expect((await lib.addTrack(file(5, { path: null, fingerprint: "fp4" }))).duplicate).toBe(true);
    expect((await lib.addTrack(file(6, { path: null }))).duplicate).toBe(false);
    expect(await lib.tracks()).toHaveLength(3);
  });

  it("keeps a copied file's audio apart from the track", async () => {
    const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" });
    const { track } = await lib.addTrack(file(1, { path: null }), { blob: audio });
    const back = await lib.blob(track.id);
    expect(new Uint8Array(await back!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(await lib.blob(12345)).toBeNull();
  });

  it("stores each cover once and drops it with its last track", async () => {
    const a = (await lib.addTrack(file(1), { art: art("cover") })).track;
    const b = (await lib.addTrack(file(2), { art: art("cover") })).track;
    expect(a.artId).toBe("cover");
    expect(await lib.art("cover")).not.toBeNull();
    await lib.removeTrack(a.id);
    expect(await lib.art("cover")).not.toBeNull();
    await lib.removeTrack(b.id);
    expect(await lib.art("cover")).toBeNull();
  });

  it("points a moved track at its new path", async () => {
    const { track } = await lib.addTrack(file(1));
    const moved = await lib.relocateTrack(track.id, "/new/place.mp3", "place.mp3");
    expect(moved).toMatchObject({ path: "/new/place.mp3", fileName: "place.mp3", title: "Song 1" });
    expect(await lib.findDuplicate("nope", "/new/place.mp3")).toEqual(moved);
    expect(await lib.relocateTrack(999, "/x.mp3", "x.mp3")).toBeNull();
  });

  it("edits title and artist", async () => {
    const { track } = await lib.addTrack(file(1));
    const t = await lib.updateTrack(track.id, { title: "Wonderwall", artist: "Oasis" });
    expect(t).toMatchObject({ title: "Wonderwall", artist: "Oasis", album: "Album" });
    expect(await lib.track(track.id)).toEqual(t);
    expect(await lib.updateTrack(999, { title: "x" })).toBeNull();
  });

  it("removes a track from the library, its copy and every playlist", async () => {
    const a = (await lib.addTrack(file(1, { path: null }), { blob: new Blob(["x"]) })).track;
    const b = (await lib.addTrack(file(2))).track;
    const p = await lib.createPlaylist("Mix", [a.id, b.id]);
    await lib.removeTrack(a.id);
    expect((await lib.tracks()).map((t) => t.id)).toEqual([b.id]);
    expect(await lib.blob(a.id)).toBeNull();
    expect((await lib.playlist(p.id))!.trackIds).toEqual([b.id]);
    await lib.removeTrack(999); // nothing to do
  });
});

describe("playlists", () => {
  it("creates, renames and deletes", async () => {
    const p = await lib.createPlaylist("  Warm   ups ");
    expect(p).toMatchObject({ name: "Warm ups", trackIds: [] });
    expect((await lib.renamePlaylist(p.id, "Solos"))!.name).toBe("Solos");
    await lib.createPlaylist("Second");
    expect((await lib.playlists()).map((x) => x.name)).toEqual(["Solos", "Second"]);
    await lib.deletePlaylist(p.id);
    expect((await lib.playlists()).map((x) => x.name)).toEqual(["Second"]);
    expect(await lib.renamePlaylist(p.id, "Gone")).toBeNull();
  });

  it("needs a name", async () => {
    await expect(lib.createPlaylist("   ")).rejects.toThrow(/name/);
    const p = await lib.createPlaylist("Mix");
    await expect(lib.renamePlaylist(p.id, "")).rejects.toThrow(/name/);
  });

  it("adds songs once each and removes them", async () => {
    const p = await lib.createPlaylist("Mix");
    expect(await lib.addToPlaylist(p.id, [1, 2])).toMatchObject({ added: 2, skipped: 0 });
    const again = await lib.addToPlaylist(p.id, [2, 3]);
    expect(again).toMatchObject({ added: 1, skipped: 1 });
    expect(again.playlist!.trackIds).toEqual([1, 2, 3]);
    expect((await lib.removeFromPlaylist(p.id, 2))!.trackIds).toEqual([1, 3]);
    expect((await lib.addToPlaylist(999, [1])).playlist).toBeNull();
  });

  it("keeps the order the user drags songs into, across reopening", async () => {
    const p = await lib.createPlaylist("Mix", [1, 2, 3, 4]);
    await lib.reorderPlaylist(p.id, 0, 3);
    await lib.reorderPlaylist(p.id, 2, 0);
    lib.close();
    const again = await MusicLibrary.open(factory);
    expect((await again.playlist(p.id))!.trackIds).toEqual([4, 2, 3, 1]);
  });
});

describe("cleanPlaylistName", () => {
  it("trims, collapses spaces and caps the length", () => {
    expect(cleanPlaylistName("  a  b ")).toBe("a b");
    expect(cleanPlaylistName(" \n ")).toBeNull();
    expect(cleanPlaylistName("x".repeat(200))).toHaveLength(80);
  });
});
