import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { findForTrack, formatSize, OfflineStore, parseSnapshot, type NewSavedPage, type SnapshotPart } from "../src/offline";

/** The app shell's answer (snapshot.rs encode_parts), built by hand. */
function container(parts: [number, number[]][], version = 1): Uint8Array {
  const bytes: number[] = [..."GFSN"].map((c) => c.charCodeAt(0));
  bytes.push(version);
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  bytes.push(...u32(parts.length));
  for (const [kind, data] of parts) bytes.push(kind, ...u32(data.length), ...data);
  return new Uint8Array(bytes);
}

const png = (n: number): SnapshotPart => ({ mime: "image/png", data: new Uint8Array([0x89, 0x50, n]) });
const meta = (over: Partial<NewSavedPage> = {}): NewSavedPage => ({
  url: "https://www.songsterr.com/a/wa/song?id=11",
  songId: 11,
  title: "Wonderwall",
  artist: "Oasis",
  trackKey: "sp:abc",
  ...over,
});

describe("parseSnapshot", () => {
  it("reads PNG strips and a PDF", () => {
    const parts = parseSnapshot(container([[0, [1, 2]], [0, [3]], [1, [9, 9, 9]]]));
    expect(parts.map((p) => p.mime)).toEqual(["image/png", "image/png", "application/pdf"]);
    expect([...parts[2].data]).toEqual([9, 9, 9]);
  });

  it("accepts the answer as a buffer or a list of bytes", () => {
    const c = container([[0, [7]]]);
    expect(parseSnapshot(c.buffer as ArrayBuffer)[0].data[0]).toBe(7);
    expect(parseSnapshot([...c])[0].data[0]).toBe(7);
  });

  it("rejects anything else", () => {
    expect(() => parseSnapshot(new Uint8Array([1, 2, 3]))).toThrow(/Not a saved page/);
    expect(() => parseSnapshot(container([[0, [1]]], 2))).toThrow(/version 2/);
    expect(() => parseSnapshot(container([[5, [1]]]))).toThrow(/kind 5/);
    const cut = container([[0, [1, 2, 3]]]).slice(0, -1);
    expect(() => parseSnapshot(cut)).toThrow(/cut short/);
  });
});

describe("findForTrack", () => {
  const pages = [
    { ...meta(), savedAt: 1 },
    { ...meta({ url: "u2", trackKey: null, title: "Champagne Supernova", songId: 12 }), savedAt: 2 },
    { ...meta({ url: "u3", trackKey: "sp:abc", title: "Wonderwall (live)" }), savedAt: 3 },
  ];

  it("prefers the page saved for that very track, newest first", () => {
    expect(findForTrack(pages, { title: "Wonderwall", artist: "Oasis" }, "sp:abc")?.url).toBe("u3");
  });

  it("else matches title and artist", () => {
    expect(findForTrack(pages, { title: "Champagne Supernova - Remastered", artist: "Oasis" }, "at:x")?.url).toBe("u2");
    expect(findForTrack(pages, { title: "Live Forever", artist: "Oasis" }, "at:y")).toBeNull();
  });
});

describe("formatSize", () => {
  it("shows KB and MB", () => {
    expect(formatSize(500)).toBe("1 KB");
    expect(formatSize(300 * 1024)).toBe("300 KB");
    expect(formatSize(12.34 * 1024 * 1024)).toBe("12.3 MB");
  });
});

describe("OfflineStore", () => {
  let factory: IDBFactory;
  let store: OfflineStore;
  beforeEach(async () => {
    factory = new IDBFactory();
    store = await OfflineStore.open(factory);
  });

  it("saves a page with its images, and reads them back in order", async () => {
    const page = await store.save(meta(), [png(1), png(2)], 100);
    expect(page).toMatchObject({ title: "Wonderwall", savedAt: 100, parts: [{ mime: "image/png", size: 3 }, { mime: "image/png", size: 3 }] });
    const blobs = await store.parts(page);
    expect(await Promise.all(blobs.map(async (b) => new Uint8Array(await b.arrayBuffer())[2]))).toEqual([1, 2]);
    expect(blobs[0].type).toBe("image/png");
  });

  it("keeps each page once: saving the same URL again replaces it", async () => {
    const first = await store.save(meta(), [png(1), png(2)], 100);
    const again = await store.save(meta(), [png(3)], 200);
    const all = await store.pages();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(again.id);
    await expect(store.parts(first)).rejects.toThrow(/missing/);
  });

  it("lists newest first, survives reopening, and deletes", async () => {
    await store.save(meta(), [png(1)], 100);
    const b = await store.save(meta({ url: "u2", title: "Champagne Supernova" }), [png(2)], 200);
    store.close();
    const again = await OfflineStore.open(factory);
    expect((await again.pages()).map((p) => p.title)).toEqual(["Champagne Supernova", "Wonderwall"]);
    await again.remove(b.id);
    expect((await again.pages()).map((p) => p.title)).toEqual(["Wonderwall"]);
    expect(await again.page(b.id)).toBeNull();
    await again.remove(999);
  });

  it("refuses an empty page", async () => {
    await expect(store.save(meta(), [])).rejects.toThrow(/Nothing to save/);
  });
});
