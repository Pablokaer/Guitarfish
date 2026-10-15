import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { insertSong, insertTab, openDb, type Db } from "../src/db.js";
import { chordExercise } from "../seed/placeholder.js";

let db: Db;
let songsterrStatus = 200;
const songsterrQueries: string[] = [];

const fakeSongsterr = (async (url: string) => {
  songsterrQueries.push(new URL(url).searchParams.get("pattern") ?? "");
  const body = [
    { songId: 29482, title: "Uprising", artist: "Muse", tracks: [{ instrument: "Distortion Guitar" }, { instrument: "Distortion Guitar" }, { instrument: "Synth Bass 1" }] },
    { songId: 1, title: "Uprising (junk)", artist: "x", isJunk: true },
  ];
  return new Response(JSON.stringify(body), { status: songsterrStatus });
}) as typeof fetch;
let app: ReturnType<typeof buildApp>;
let serverNow = 1_000_000;

beforeEach(() => {
  db = openDb(":memory:");
  const s1 = insertSong(db, { title: "Wonderwall", artist: "Oasis", durationMs: 258_000 });
  insertTab(db, { songId: s1.id, format: "alphatex", content: Buffer.from(chordExercise("x")), isPlaceholder: true });
  insertSong(db, { title: "Seven Nation Army", artist: "The White Stripes" });
  insertSong(db, { title: "Tempo Perdido", artist: "Legião Urbana" });
  app = buildApp({
    db,
    spotify: { redirectUri: "http://127.0.0.1:8787/auth/spotify/callback" },
    songsterrFetch: fakeSongsterr,
    now: () => serverNow,
  });
});

const lookup = async (q: Record<string, string>) =>
  (await app.inject({ method: "GET", url: "/v1/tabs/lookup", query: q })).json();

describe("GET /v1/tabs/lookup", () => {
  it("matches exactly despite Spotify title noise", async () => {
    const r = await lookup({ title: "Wonderwall - Remastered", artist: "Oasis" });
    expect(r.method).toBe("exact");
    expect(r.match.title).toBe("Wonderwall");
    expect(r.match.tabs).toHaveLength(1);
    expect(r.match.tabs[0].isPlaceholder).toBe(true);
  });

  it("matches with accents, 'The' and combined artists", async () => {
    expect((await lookup({ title: "Tempo Perdido", artist: "Legiao Urbana" })).match?.title).toBe("Tempo Perdido");
    expect((await lookup({ title: "Seven Nation Army", artist: "White Stripes" })).match?.title).toBe("Seven Nation Army");
    expect((await lookup({ title: "Wonderwall", artist: "Oasis, Someone Else" })).method).toBe("exact");
  });

  it("fuzzy matches small differences", async () => {
    const r = await lookup({ title: "Wonderwal", artist: "Oasis" });
    expect(r.method).toBe("fuzzy");
    expect(r.match?.title).toBe("Wonderwall");
  });

  it("returns candidates but no match when unsure", async () => {
    const r = await lookup({ title: "Wonder", artist: "Unknown Band" });
    expect(r.match).toBeNull();
  });

  it("uses a confirmed Spotify ID link first", async () => {
    const song = (await lookup({ title: "Seven Nation Army", artist: "The White Stripes" })).match;
    await app.inject({
      method: "POST",
      url: `/v1/songs/${song.id}/external-ids`,
      payload: { provider: "spotify", externalId: "abc123" },
    });
    const r = await lookup({ title: "Totally different title", artist: "x", spotifyId: "abc123" });
    expect(r.method).toBe("external-id");
    expect(r.match.id).toBe(song.id);
  });

  it("requires title and artist", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/tabs/lookup?title=x" });
    expect(res.statusCode).toBe(400);
  });
});

describe("tabs", () => {
  it("serves content with format header", async () => {
    const r = await lookup({ title: "Wonderwall", artist: "Oasis" });
    const res = await app.inject({ method: "GET", url: `/v1/tabs/${r.match.tabs[0].id}/content` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-tab-format"]).toBe("alphatex");
    expect(res.body).toContain("\\title");
  });

  it("accepts raw uploads", async () => {
    const created = (await app.inject({ method: "POST", url: "/v1/songs", payload: { title: "New", artist: "Band" } })).json();
    const up = await app.inject({
      method: "POST",
      url: `/v1/songs/${created.id}/tabs?format=gp`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from([1, 2, 3]),
    });
    expect(up.statusCode).toBe(201);
    const song = (await app.inject({ method: "GET", url: `/v1/songs/${created.id}` })).json();
    expect(song.tabs[0].format).toBe("gp");
  });

  it("searches songs", async () => {
    const r = (await app.inject({ method: "GET", url: "/v1/songs?q=nation" })).json();
    expect(r.results[0].title).toBe("Seven Nation Army");
  });
});

describe("spotify fallback", () => {
  it("reports not configured without a client id", async () => {
    const r = (await app.inject({ method: "GET", url: "/auth/spotify/status" })).json();
    expect(r).toEqual({ configured: false, connected: false });
    const np = (await app.inject({ method: "GET", url: "/v1/spotify/now-playing" })).json();
    expect(np.track).toBeNull();
  });
});

describe("songsterr", () => {
  it("returns links, drops junk and dedupes instruments", async () => {
    songsterrStatus = 200;
    const res = await app.inject({ method: "GET", url: "/v1/songsterr/search?q=Muse%20Uprising" });
    expect(res.statusCode).toBe(200);
    expect(songsterrQueries.at(-1)).toBe("Muse Uprising");
    expect(res.json().results).toEqual([
      {
        songId: 29482,
        title: "Uprising",
        artist: "Muse",
        instruments: ["Distortion Guitar", "Synth Bass 1"],
        url: "https://www.songsterr.com/a/wa/song?id=29482",
      },
    ]);
  });

  it("requires q and reports upstream failures as 502", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/songsterr/search" })).statusCode).toBe(400);
    songsterrStatus = 503;
    expect((await app.inject({ method: "GET", url: "/v1/songsterr/search?q=x" })).statusCode).toBe(502);
  });
});


describe("library sync", () => {
  const entry = (songId: number, at: number) => ({
    url: `https://www.songsterr.com/a/wa/song?id=${songId}`,
    songId,
    title: `Song ${songId}`,
    artist: "Band",
    at,
  });
  const sync = (payload: unknown) => app.inject({ method: "POST", url: "/v1/library/sync", payload: payload as object });
  const library = async () => (await app.inject({ method: "GET", url: "/v1/library" })).json();

  it("starts empty", async () => {
    expect(await library()).toEqual({ history: [], favorites: [] });
  });

  it("merges a device's changes and returns the merged lists", async () => {
    await sync({ history: [entry(1, 100)], favorites: [entry(1, 100), entry(2, 150)] });
    const res = await sync({ history: [entry(2, 200), entry(1, 50)] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      history: [entry(2, 200), entry(1, 100)],
      favorites: [entry(2, 150), entry(1, 100)],
    });
    expect(await library()).toEqual(res.json());
  });

  it("propagates a removal to every device", async () => {
    const otherDevice = buildApp({ db, spotify: { redirectUri: "x" }, now: () => serverNow });
    await sync({ favorites: [entry(1, 100), entry(2, 200)] });
    await otherDevice.inject({ method: "POST", url: "/v1/library/sync", payload: { favorites: [{ songId: 1, deletedAt: 300 }] } });
    // The first device still has song 1 locally and pushes it again: the removal wins.
    const res = await sync({ favorites: [entry(1, 100)] });
    expect(res.json().favorites).toEqual([entry(2, 200)]);
  });

  it("accepts an empty body as a plain fetch", async () => {
    await sync({ history: [entry(1, 100)] });
    const res = await app.inject({ method: "POST", url: "/v1/library/sync" });
    expect(res.statusCode).toBe(200);
    expect(res.json().history).toEqual([entry(1, 100)]);
  });

  it("drops unknown fields from entries", async () => {
    const res = await sync({ history: [{ ...entry(1, 100), instruments: ["Guitar"] }] });
    expect(res.json().history).toEqual([entry(1, 100)]);
  });

  it("clamps timestamps from the future to the server clock", async () => {
    serverNow = 5_000;
    const res = await sync({ history: [entry(1, 99_999_999)], favorites: [{ songId: 2, deletedAt: 99_999_999 }] });
    expect(res.json().history).toEqual([entry(1, 5_000)]);
    // The clamped tombstone is beaten by a later add.
    serverNow = 6_000;
    expect((await sync({ favorites: [entry(2, 5_500)] })).json().favorites).toEqual([entry(2, 5_500)]);
    serverNow = 1_000_000;
  });

  it.each([
    ["a non-object body", [entry(1, 1)]],
    ["an unknown list", { favourites: [] }],
    ["a list that is not an array", { history: entry(1, 1) }],
    ["a change that is not an object", { history: [42] }],
    ["a missing url", { history: [{ ...entry(1, 1), url: undefined }] }],
    ["an empty url", { history: [{ ...entry(1, 1), url: "" }] }],
    ["a non-string title", { history: [{ ...entry(1, 1), title: 3 }] }],
    ["a fractional songId", { history: [entry(1.5, 1)] }],
    ["a zero songId", { history: [entry(0, 1)] }],
    ["a string timestamp", { history: [{ ...entry(1, 1), at: "1" }] }],
    ["a negative timestamp", { favorites: [{ songId: 1, deletedAt: -1 }] }],
    ["both at and deletedAt", { favorites: [{ ...entry(1, 1), deletedAt: 2 }] }],
    ["an overlong title", { history: [{ ...entry(1, 1), title: "x".repeat(513) }] }],
    ["too many changes", { history: Array.from({ length: 501 }, (_, i) => entry(i + 1, 1)) }],
  ])("rejects %s with 400 and stores nothing", async (_what, payload) => {
    const res = await sync(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual(expect.any(String));
    expect(await library()).toEqual({ history: [], favorites: [] });
  });

  it("rejects oversized bodies", async () => {
    const res = await sync({ history: [{ ...entry(1, 1), title: "x".repeat(3 * 1024 * 1024) }] });
    expect(res.statusCode).toBe(413);
  });
});
