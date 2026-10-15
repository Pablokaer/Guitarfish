import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { Catalogue, type NewTab } from "../src/catalogue";

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const text = (b: ArrayBuffer) => new TextDecoder().decode(b);

const tab = (title: string, artist: string, over: Partial<NewTab> = {}): NewTab => ({
  title,
  artist,
  format: "alphatex",
  name: `${title}.alphatex`,
  data: bytes(`\\title "${title}"`),
  ...over,
});

/** A fresh, empty catalogue in its own in-memory IndexedDB. */
const fresh = () => Catalogue.open(new IDBFactory());

describe("catalogue storage", () => {
  it("starts empty", async () => {
    const c = await fresh();
    expect(await c.songs()).toEqual([]);
  });

  it("stores an imported tab under a new song", async () => {
    const c = await fresh();
    const { song, tab: info } = await c.addTab(tab("Wonderwall", "Oasis", { durationMs: 258_000 }));
    expect(song).toEqual({ id: song.id, title: "Wonderwall", artist: "Oasis", durationMs: 258_000, tabs: [info] });
    expect(info).toEqual({ id: info.id, format: "alphatex", name: "Wonderwall.alphatex" });
    expect(await c.songs()).toEqual([song]);
    expect(await c.song(song.id)).toEqual(song);
    expect(await c.song(song.id + 100)).toBeNull();
  });

  it("returns a tab's file as it was imported", async () => {
    const c = await fresh();
    const gp = new Uint8Array([24, 70, 73, 67, 0, 255]).buffer;
    const { tab: info } = await c.addTab(tab("Wonderwall", "Oasis", { format: "gp", name: "w.gp5", data: gp }));
    const file = await c.tab(info.id);
    expect(file.format).toBe("gp");
    expect([...new Uint8Array(file.data)]).toEqual([24, 70, 73, 67, 0, 255]);
  });

  it("rejects an unknown tab", async () => {
    const c = await fresh();
    await expect(c.tab(42)).rejects.toThrow("Tab 42 is not in the catalogue");
  });

  it("adds another tab of the same song to that song, oldest first", async () => {
    const c = await fresh();
    const first = await c.addTab(tab("Wonderwall", "Oasis"));
    // Same song after normalization: title noise, case, a leading "The".
    const second = await c.addTab(tab("Wonderwall - Remastered", "the OASIS", { name: "solo.gp", format: "gp", data: bytes("PK\x03\x04") }));
    expect(second.song.id).toBe(first.song.id);
    expect(second.song.title).toBe("Wonderwall");
    expect(second.song.tabs.map((t) => t.name)).toEqual(["Wonderwall.alphatex", "solo.gp"]);
    expect(await c.songs()).toHaveLength(1);
  });

  it("lists songs by artist, then title", async () => {
    const c = await fresh();
    await c.addTab(tab("Uprising", "Muse"));
    await c.addTab(tab("Wonderwall", "Oasis"));
    await c.addTab(tab("hysteria", "muse"));
    expect((await c.songs()).map((s) => `${s.artist} – ${s.title}`)).toEqual(["muse – hysteria", "Muse – Uprising", "Oasis – Wonderwall"]);
  });

  it("deletes a tab, and the song with its last tab", async () => {
    const c = await fresh();
    const a = await c.addTab(tab("Wonderwall", "Oasis"));
    const b = await c.addTab(tab("Wonderwall", "Oasis", { name: "second.alphatex" }));
    await c.deleteTab(a.tab.id);
    expect((await c.songs())[0].tabs).toEqual([b.tab]);
    await expect(c.tab(a.tab.id)).rejects.toThrow();
    await c.deleteTab(b.tab.id);
    expect(await c.songs()).toEqual([]);
    expect(await c.song(a.song.id)).toBeNull();
  });

  it("ignores deleting a tab that is already gone", async () => {
    const c = await fresh();
    await expect(c.deleteTab(7)).resolves.toBeUndefined();
  });

  it("keeps everything on the device across restarts", async () => {
    const factory = new IDBFactory();
    const before = await Catalogue.open(factory);
    const { song, tab: info } = await before.addTab(tab("Wonderwall", "Oasis"));
    before.close();
    const after = await Catalogue.open(factory);
    expect(await after.songs()).toEqual([song]);
    expect(text((await after.tab(info.id)).data)).toBe('\\title "Wonderwall"');
  });

  it("fails to open when IndexedDB is unavailable", async () => {
    const broken = { open: () => { throw new Error("blocked"); } } as unknown as IDBFactory;
    await expect(Catalogue.open(broken)).rejects.toThrow("blocked");
  });
});

describe("catalogue lookup", () => {
  const track = (title: string, artist: string, spotifyId: string | null = null, durationMs: number | null = null) => ({ title, artist, spotifyId, durationMs });

  async function seeded() {
    const c = await fresh();
    const wonderwall = (await c.addTab(tab("Wonderwall", "Oasis", { durationMs: 258_000 }))).song;
    const seven = (await c.addTab(tab("Seven Nation Army", "The White Stripes"))).song;
    const tempo = (await c.addTab(tab("Tempo Perdido", "Legião Urbana"))).song;
    return { c, wonderwall, seven, tempo };
  }

  it("finds an exact match despite Spotify's title noise, with its tabs", async () => {
    const { c, wonderwall } = await seeded();
    expect(await c.lookup(track("Wonderwall - Remastered", "Oasis"))).toEqual({
      match: wonderwall,
      confidence: 0.97,
      method: "exact",
      candidates: [{ ...wonderwall, score: 0.97 }],
    });
  });

  it("finds a close match by similarity", async () => {
    const { c, wonderwall } = await seeded();
    const r = await c.lookup(track("Wonderwal", "Oasis", null, 258_500));
    expect(r.method).toBe("fuzzy");
    expect(r.match).toEqual(wonderwall);
    expect(r.candidates[0]).toEqual({ ...wonderwall, score: r.confidence });
  });

  it("offers scored candidates when unsure", async () => {
    const { c, wonderwall } = await seeded();
    const r = await c.lookup(track("Wonderwal", "Unknown Band"));
    expect(r.match).toBeNull();
    expect(r.method).toBe("none");
    expect(r.candidates.map((s) => s.id)).toContain(wonderwall.id);
    expect(r.candidates.every((s) => typeof s.score === "number" && s.tabs.length === 1)).toBe(true);
  });

  it("finds nothing in an empty catalogue", async () => {
    const c = await fresh();
    expect(await c.lookup(track("Wonderwall", "Oasis", "sp1"))).toEqual({ match: null, confidence: 0, method: "none", candidates: [] });
  });

  it("confirming a song links the Spotify track, so the next lookup is certain", async () => {
    const { c, seven } = await seeded();
    const t = track("Totally different title", "x", "sp-seven");
    expect((await c.lookup(t)).match).toBeNull();
    await c.confirm(t, seven);
    expect(await c.lookup(t)).toEqual({ match: seven, confidence: 1, method: "external-id", candidates: [{ ...seven, score: 1 }] });
  });

  it("a new confirmation replaces the previous one", async () => {
    const { c, seven, tempo } = await seeded();
    const t = track("Something", "x", "sp1");
    await c.confirm(t, seven);
    await c.confirm(t, tempo);
    expect((await c.lookup(t)).match).toEqual(tempo);
  });

  it("without a Spotify ID, confirming stores nothing", async () => {
    const { c, seven } = await seeded();
    const t = track("Totally different title", "x");
    await c.confirm(t, seven);
    expect((await c.lookup(t)).match).toBeNull();
  });

  it("forgets the link when the song is deleted", async () => {
    const { c, seven } = await seeded();
    const t = track("Seven Nation Army", "The White Stripes", "sp-seven");
    await c.confirm(t, seven);
    await c.deleteTab(seven.tabs[0].id);
    expect((await c.lookup(t)).match).toBeNull();
    // A new import of the song isn't linked to the old confirmation.
    const again = (await c.addTab(tab("Seven Nation Army (Live)", "White Stripes"))).song;
    expect(await c.lookup(t)).toMatchObject({ method: "exact", match: again });
  });

  it("searches songs by title or artist", async () => {
    const { c, seven, wonderwall } = await seeded();
    expect((await c.search("nation"))[0]).toEqual({ ...seven, score: expect.any(Number) });
    expect((await c.search("oasis")).map((s) => s.id)).toEqual([wonderwall.id]);
    expect(await c.search("  ")).toEqual([]);
  });
});
