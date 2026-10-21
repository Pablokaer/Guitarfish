import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MusicLibrary } from "../src/music";
import { fingerprint, fromBlobFile, importFiles, importSummary, isMp3Name, MAX_COPY_BYTES, titleFromName, type ImportFile } from "../src/musicimport";
import { JPEG, silentMp3 } from "./mp3fixture";

/** A file on disk (desktop): read by range, recording how much was read. */
function diskFile(path: string, bytes: Uint8Array) {
  const reads: [number, number][] = [];
  const f: ImportFile = {
    name: path.split("/").pop()!,
    size: bytes.length,
    path,
    read: async (offset, len) => {
      reads.push([offset, len]);
      return bytes.slice(offset, offset + len);
    },
  };
  return { f, reads };
}

let lib: MusicLibrary;
beforeEach(async () => {
  lib = await MusicLibrary.open(new IDBFactory());
});

describe("importFiles", () => {
  it("imports tagged files with their art", async () => {
    const { f } = diskFile("/m/wonderwall.mp3", silentMp3({ id3: 3, title: "Wonderwall", artist: "Oasis", album: "Morning Glory", pictures: [{ type: 3, data: JPEG }] }));
    const out = await importFiles([f], lib);
    expect(out.failed).toEqual([]);
    expect(out.added[0]).toMatchObject({ title: "Wonderwall", artist: "Oasis", album: "Morning Glory", path: "/m/wonderwall.mp3", fileName: "wonderwall.mp3" });
    expect(out.added[0].durationMs).toBeGreaterThan(1900);
    const art = await lib.art(out.added[0].artId!);
    expect(art!.type).toBe("image/jpeg");
  });

  it("names untagged files after the file", async () => {
    const out = await importFiles([diskFile("/m/My_Demo Take 2.MP3", silentMp3()).f], lib);
    expect(out.added[0]).toMatchObject({ title: "My Demo Take 2", artist: "", album: "", artId: null });
  });

  it("only reads the start and the end of a file", async () => {
    const bytes = silentMp3({ seconds: 60, id3: 3, title: "Long" });
    const { f, reads } = diskFile("/m/long.mp3", bytes);
    await importFiles([f], lib);
    const total = reads.reduce((n, [, len]) => n + Math.min(len, bytes.length), 0);
    expect(total).toBeLessThan(bytes.length / 2);
    expect(reads.at(-1)).toEqual([bytes.length - 128, 128]);
  });

  it("reports duplicates, by path or content, and keeps going", async () => {
    const bytes = silentMp3({ id3: 3, title: "Same" });
    await importFiles([diskFile("/m/a.mp3", bytes).f], lib);
    const out = await importFiles([diskFile("/m/a.mp3", bytes).f, diskFile("/copy/a.mp3", bytes).f, diskFile("/m/b.mp3", silentMp3({ id3: 3, title: "Other" })).f], lib);
    expect(out.duplicates).toEqual(["a.mp3", "a.mp3"]);
    expect(out.added.map((t) => t.title)).toEqual(["Other"]);
    // The same file twice in one import goes in once.
    const twice = await importFiles([diskFile("/n/c.mp3", silentMp3({ seconds: 3 })).f, diskFile("/n/c.mp3", silentMp3({ seconds: 3 })).f], lib);
    expect(twice).toMatchObject({ duplicates: ["c.mp3"] });
    expect(twice.added).toHaveLength(1);
  });

  it("re-importing a moved file updates its path; a copy elsewhere stays a duplicate", async () => {
    const bytes = silentMp3({ id3: 3, title: "Moved" });
    const first = (await importFiles([diskFile("/old/song.mp3", bytes).f], lib)).added[0];
    const exists = vi.fn(async (p: string) => p !== "/old/song.mp3");
    const out = await importFiles([diskFile("/new/song.mp3", bytes).f], lib, { exists });
    expect(out).toMatchObject({ added: [], duplicates: ["song.mp3"], relocated: ["song.mp3"] });
    expect(out.existing[0]).toMatchObject({ id: first.id, path: "/new/song.mp3" });
    expect((await lib.track(first.id))!.path).toBe("/new/song.mp3");
    expect(importSummary(out)).toBe("Found 1 song in a new place.");
    // The original is still there: just a duplicate.
    const copy = await importFiles([diskFile("/copy/song.mp3", bytes).f], lib, { exists: async () => true });
    expect(copy).toMatchObject({ relocated: [], duplicates: ["song.mp3"] });
    expect(copy.existing[0].path).toBe("/new/song.mp3");
  });

  it("rejects files that aren't MP3s", async () => {
    const out = await importFiles(
      [
        diskFile("/m/notes.txt", new TextEncoder().encode("hello")).f,
        diskFile("/m/fake.mp3", new TextEncoder().encode("<html>nope</html>".repeat(10))).f,
        diskFile("/m/empty.mp3", new Uint8Array()).f,
      ],
      lib,
    );
    expect(out.added).toEqual([]);
    expect(out.failed.map((f) => f.name)).toEqual(["notes.txt", "fake.mp3", "empty.mp3"]);
    expect(out.failed[0].reason).toMatch(/not an \.mp3/);
    expect(out.failed[1].reason).toMatch(/not MP3 audio/);
    expect(out.failed[2].reason).toMatch(/empty/);
  });

  it("imports a file whose tag is larger than the part read (huge cover art)", async () => {
    const huge = new Uint8Array(17 * 1024 * 1024);
    huge.set(JPEG);
    const bytes = silentMp3({ id3: 3, title: "Huge Cover", artist: "Band", seconds: 3, pictures: [{ type: 3, data: huge }] });
    const { f, reads } = diskFile("/m/huge.mp3", bytes);
    const out = await importFiles([f], lib);
    expect(out.failed).toEqual([]);
    expect(out.added[0]).toMatchObject({ title: "Huge Cover", artist: "Band", artId: null });
    expect(out.added[0].durationMs).toBeGreaterThan(2900);
    expect(reads.every(([, len]) => len <= 16 * 1024 * 1024)).toBe(true);
  });

  it("reads the start of a file once when its tag is small", async () => {
    const { f, reads } = diskFile("/m/small.mp3", silentMp3({ id3: 3, title: "Small", seconds: 30 }));
    await importFiles([f], lib);
    expect(reads.filter(([offset]) => offset === 0)).toHaveLength(1);
  });

  it("reports a file that can't be read", async () => {
    const f: ImportFile = { name: "gone.mp3", size: 5000, path: "/m/gone.mp3", read: () => Promise.reject(new Error("No such file")) };
    expect((await importFiles([f], lib)).failed).toEqual([{ name: "gone.mp3", reason: "No such file" }]);
  });

  it("copies picked files into the library", async () => {
    const bytes = silentMp3({ id3: 4, title: "Picked" });
    const file = new File([bytes as Uint8Array<ArrayBuffer>], "picked.mp3", { type: "audio/mpeg" });
    const out = await importFiles([fromBlobFile(file)], lib);
    const t = out.added[0];
    expect(t).toMatchObject({ title: "Picked", path: null });
    expect((await lib.blob(t.id))!.size).toBe(bytes.length);
  });

  it("caps the size of copies", async () => {
    const f: ImportFile = { name: "huge.mp3", size: MAX_COPY_BYTES + 1, path: null, read: vi.fn() };
    expect((await importFiles([f], lib)).failed[0].reason).toMatch(/300 MB/);
    expect(f.read).not.toHaveBeenCalled();
  });

  it("reports progress", async () => {
    const progress = vi.fn();
    await importFiles([diskFile("/m/1.mp3", silentMp3()).f, diskFile("/m/2.mp3", silentMp3({ seconds: 3 })).f], lib, { onProgress: progress });
    expect(progress.mock.calls).toEqual([[0, 2], [1, 2], [2, 2]]);
  });
});

describe("helpers", () => {
  it("recognises .mp3 names", () => {
    expect(isMp3Name("a.MP3")).toBe(true);
    expect(isMp3Name("a.mp3.txt")).toBe(false);
  });

  it("makes titles from file names", () => {
    expect(titleFromName("C:\\Music\\Some_Song.mp3")).toBe("Some Song");
    expect(titleFromName(".mp3")).toBe(".mp3");
  });

  it("fingerprints content and size", async () => {
    const a = silentMp3({ seconds: 2 });
    expect(await fingerprint(a, a.length)).toBe(await fingerprint(a.slice(), a.length));
    expect(await fingerprint(a, a.length)).not.toBe(await fingerprint(a, a.length + 1));
  });

  it("summarises an import", () => {
    const none = { added: [], duplicates: [], relocated: [], existing: [], failed: [] };
    expect(importSummary({ ...none, added: [{} as never], duplicates: ["a", "b"] })).toBe("Added 1 song. 2 songs already in your library.");
    expect(importSummary({ ...none, failed: [{ name: "x.mp3", reason: "broken" }] })).toBe("Couldn't import x.mp3 (broken).");
    const many = Array.from({ length: 4 }, (_, i) => ({ name: `${i}.mp3`, reason: "r" }));
    expect(importSummary({ ...none, failed: many })).toBe("Couldn't import 4 files: 0.mp3 (r), 1.mp3 (r), 2.mp3 (r), ….");
    expect(importSummary(none)).toBe("No files to import.");
  });
});
