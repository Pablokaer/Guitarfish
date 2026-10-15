import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { getSetting, openDb, setSetting, type Db } from "../src/db.js";
import {
  buildLoginUrl,
  currentlyPlaying,
  disconnect,
  handleCallback,
  isConnected,
  pickArtwork,
  type SpotifyConfig,
} from "../src/spotify.js";

describe("pickArtwork", () => {
  it("picks the smallest image that is still at least 200 px wide", () => {
    const images = [
      { url: "640", width: 640 },
      { url: "300", width: 300 },
      { url: "64", width: 64 },
    ];
    expect(pickArtwork(images)).toBe("300");
  });

  it("falls back to the first image, or nothing", () => {
    expect(pickArtwork([{ url: "a", width: 64 }])).toBe("a");
    expect(pickArtwork([])).toBeUndefined();
    expect(pickArtwork(undefined)).toBeUndefined();
  });
});

// ---- OAuth flow, with Spotify stubbed ------------------------------------

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const NOW_PLAYING_URL = "https://api.spotify.com/v1/me/player/currently-playing";
const REDIRECT = "http://127.0.0.1:8787/auth/spotify/callback";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  form?: Record<string, string>;
}

let db: Db;
let clock: number;
let calls: Call[];
/** Responses served in order, one per fetch call. */
let responses: Response[];
let cfg: SpotifyConfig;

const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
  const body = init?.body;
  calls.push({
    url: String(input),
    method: init?.method ?? "GET",
    headers: (init?.headers ?? {}) as Record<string, string>,
    form: body instanceof URLSearchParams ? Object.fromEntries(body) : undefined,
  });
  const next = responses.shift();
  if (!next) throw new Error(`unexpected fetch ${input}`);
  return next;
}) as typeof fetch;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tokenResponse = (access: string, refresh?: string, expiresIn = 3600) =>
  json({ access_token: access, token_type: "Bearer", expires_in: expiresIn, ...(refresh ? { refresh_token: refresh } : {}) });

const storedTokens = () => JSON.parse(getSetting(db, "spotify.tokens") ?? "null");
const storeTokens = (t: { accessToken: string; refreshToken: string; expiresAt: number }) =>
  setSetting(db, "spotify.tokens", JSON.stringify(t));

beforeEach(() => {
  db = openDb(":memory:");
  clock = 1_700_000_000_000;
  calls = [];
  responses = [];
  cfg = { clientId: "client-123", redirectUri: REDIRECT, fetch: fakeFetch, now: () => clock };
});

const base64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("buildLoginUrl", () => {
  it("requires a client id", () => {
    expect(() => buildLoginUrl({ redirectUri: REDIRECT })).toThrow(/SPOTIFY_CLIENT_ID/);
  });

  it("asks for an authorization code with a PKCE S256 challenge", () => {
    const url = new URL(buildLoginUrl(cfg));
    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("client-123");
    expect(p.get("redirect_uri")).toBe(REDIRECT);
    expect(p.get("scope")).toBe("user-read-currently-playing user-read-playback-state");
    expect(p.get("code_challenge_method")).toBe("S256");
    // SHA-256 digest, base64url without padding.
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("state")).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(calls).toEqual([]);
  });

  it("uses a fresh state and challenge for every login", () => {
    const a = new URL(buildLoginUrl(cfg)).searchParams;
    const b = new URL(buildLoginUrl(cfg)).searchParams;
    expect(a.get("state")).not.toBe(b.get("state"));
    expect(a.get("code_challenge")).not.toBe(b.get("code_challenge"));
  });
});

describe("handleCallback", () => {
  const login = () => new URL(buildLoginUrl(cfg)).searchParams;

  it("exchanges the code with the verifier that matches the challenge, and stores the tokens", async () => {
    const p = login();
    responses.push(tokenResponse("access-1", "refresh-1", 3600));
    await handleCallback(db, cfg, "the-code", p.get("state")!);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe(TOKEN_URL);
    expect(call.method).toBe("POST");
    expect(call.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const { code_verifier, ...rest } = call.form!;
    expect(rest).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: REDIRECT,
      client_id: "client-123",
    });
    expect(base64url(crypto.createHash("sha256").update(code_verifier).digest())).toBe(p.get("code_challenge"));

    expect(isConnected(db)).toBe(true);
    // Expiry is brought forward by a minute so a token is never used right at the edge.
    expect(storedTokens()).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: clock + (3600 - 60) * 1000,
    });
  });

  it("rejects an unknown state without calling Spotify", async () => {
    login();
    await expect(handleCallback(db, cfg, "code", "made-up-state")).rejects.toThrow(/Unknown or expired/);
    expect(calls).toEqual([]);
    expect(isConnected(db)).toBe(false);
  });

  it("accepts each state only once", async () => {
    const state = login().get("state")!;
    responses.push(tokenResponse("access-1", "refresh-1"));
    await handleCallback(db, cfg, "code", state);
    await expect(handleCallback(db, cfg, "code", state)).rejects.toThrow(/Unknown or expired/);
    expect(calls).toHaveLength(1);
  });

  it("drops login attempts older than 10 minutes when a new one starts", async () => {
    const old = login().get("state")!;
    clock += 10 * 60_000 + 1;
    login();
    await expect(handleCallback(db, cfg, "code", old)).rejects.toThrow(/Unknown or expired/);
    expect(calls).toEqual([]);
  });

  it("stores nothing when Spotify refuses the code", async () => {
    const state = login().get("state")!;
    responses.push(json({ error: "invalid_grant" }, 400));
    await expect(handleCallback(db, cfg, "bad-code", state)).rejects.toThrow(/400/);
    expect(isConnected(db)).toBe(false);
  });
});

describe("access token refresh", () => {
  it("uses the stored token while it is valid", async () => {
    storeTokens({ accessToken: "valid", refreshToken: "r", expiresAt: clock + 1000 });
    responses.push(new Response(null, { status: 204 }));
    await currentlyPlaying(db, cfg);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(NOW_PLAYING_URL);
    expect(calls[0].headers.Authorization).toBe("Bearer valid");
  });

  it("refreshes an expired token and keeps the old refresh token when Spotify doesn't rotate it", async () => {
    storeTokens({ accessToken: "old", refreshToken: "refresh-1", expiresAt: clock });
    responses.push(tokenResponse("new-access", undefined, 3600), new Response(null, { status: 204 }));
    await currentlyPlaying(db, cfg);

    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL, NOW_PLAYING_URL]);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].form).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "client-123" });
    expect(calls[1].headers.Authorization).toBe("Bearer new-access");
    expect(storedTokens()).toEqual({
      accessToken: "new-access",
      refreshToken: "refresh-1",
      expiresAt: clock + (3600 - 60) * 1000,
    });
  });

  it("stores a rotated refresh token", async () => {
    storeTokens({ accessToken: "old", refreshToken: "refresh-1", expiresAt: clock - 1 });
    responses.push(tokenResponse("new-access", "refresh-2"), new Response(null, { status: 204 }));
    await currentlyPlaying(db, cfg);
    expect(storedTokens().refreshToken).toBe("refresh-2");
  });
});

describe("currentlyPlaying", () => {
  const playing = (over: Record<string, unknown> = {}, item: Record<string, unknown> = {}) =>
    json({
      is_playing: true,
      progress_ms: 42_000,
      currently_playing_type: "track",
      item: {
        id: "track-1",
        name: "Uprising",
        duration_ms: 305_000,
        artists: [{ name: "Muse" }, { name: "Someone" }],
        album: {
          name: "The Resistance",
          images: [
            { url: "img-640", width: 640 },
            { url: "img-300", width: 300 },
            { url: "img-64", width: 64 },
          ],
        },
        ...item,
      },
      ...over,
    });

  beforeEach(() => storeTokens({ accessToken: "valid", refreshToken: "r", expiresAt: clock + 3_600_000 }));

  it("returns null without a client id or without tokens, without calling Spotify", async () => {
    expect(await currentlyPlaying(db, { ...cfg, clientId: undefined })).toBeNull();
    disconnect(db);
    expect(await currentlyPlaying(db, cfg)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("maps the playing track to the shared Track shape", async () => {
    responses.push(playing());
    expect(await currentlyPlaying(db, cfg)).toEqual({
      title: "Uprising",
      artist: "Muse, Someone",
      album: "The Resistance",
      durationMs: 305_000,
      positionMs: 42_000,
      isPlaying: true,
      spotifyId: "track-1",
      artworkUrl: "img-300",
      source: "spotify-api",
      player: "Spotify (Web API)",
    });
  });

  it("copes with missing optional fields", async () => {
    responses.push(playing({ is_playing: false, progress_ms: null }, { artists: undefined, album: undefined }));
    const t = await currentlyPlaying(db, cfg);
    expect(t).toMatchObject({ title: "Uprising", artist: "", isPlaying: false });
    expect(t?.positionMs).toBeUndefined();
    expect(t?.album).toBeUndefined();
    expect(t?.artworkUrl).toBeUndefined();
  });

  it.each([
    ["nothing is playing (204)", () => new Response(null, { status: 204 })],
    ["there is no item", () => playing({ item: null })],
    ["an ad is playing", () => playing({ currently_playing_type: "ad" })],
    ["a podcast episode is playing", () => playing({ currently_playing_type: "episode" })],
  ])("returns null when %s", async (_what, response) => {
    responses.push(response());
    expect(await currentlyPlaying(db, cfg)).toBeNull();
  });

  it("disconnects when Spotify revokes the token (401)", async () => {
    responses.push(json({ error: { status: 401 } }, 401));
    expect(await currentlyPlaying(db, cfg)).toBeNull();
    expect(isConnected(db)).toBe(false);
  });

  it("reports other Spotify errors", async () => {
    responses.push(json({}, 503));
    await expect(currentlyPlaying(db, cfg)).rejects.toThrow(/503/);
  });

  it("serves polls within 2 seconds from a cache", async () => {
    responses.push(playing(), new Response(null, { status: 204 }));
    const first = await currentlyPlaying(db, cfg);
    clock += 1_999;
    expect(await currentlyPlaying(db, cfg)).toEqual(first);
    expect(calls).toHaveLength(1);
    clock += 1;
    expect(await currentlyPlaying(db, cfg)).toBeNull();
    expect(calls).toHaveLength(2);
  });
});

describe("disconnect", () => {
  it("forgets the stored tokens", () => {
    storeTokens({ accessToken: "a", refreshToken: "r", expiresAt: clock });
    expect(isConnected(db)).toBe(true);
    disconnect(db);
    expect(isConnected(db)).toBe(false);
    expect(getSetting(db, "spotify.tokens")).toBeUndefined();
  });
});

describe("Spotify routes", () => {
  const app = () => buildApp({ db, spotify: cfg });

  it("redirects /auth/spotify/login to Spotify", async () => {
    const res = await app().inject({ method: "GET", url: "/auth/spotify/login" });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
  });

  it("connects through the callback, then reports status, now playing and logout", async () => {
    const a = app();
    const login = await a.inject({ method: "GET", url: "/auth/spotify/login" });
    const state = new URL(login.headers.location as string).searchParams.get("state")!;
    responses.push(tokenResponse("access-1", "refresh-1"));
    const cb = await a.inject({ method: "GET", url: "/auth/spotify/callback", query: { code: "c", state } });
    expect(cb.statusCode).toBe(200);
    expect(cb.body).toContain("Spotify connected");
    expect((await a.inject({ method: "GET", url: "/auth/spotify/status" })).json()).toEqual({
      configured: true,
      connected: true,
    });

    responses.push(new Response(null, { status: 204 }));
    expect((await a.inject({ method: "GET", url: "/v1/spotify/now-playing" })).json()).toEqual({ track: null });

    expect((await a.inject({ method: "POST", url: "/auth/spotify/logout" })).json()).toEqual({ ok: true });
    expect(isConnected(db)).toBe(false);
  });

  it("rejects a callback without a code", async () => {
    const res = await app().inject({ method: "GET", url: "/auth/spotify/callback", query: { error: "access_denied" } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("access_denied");
    expect(calls).toEqual([]);
  });
});
