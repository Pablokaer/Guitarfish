/**
 * Optional Spotify Web API fallback.
 *
 * The OS-level detectors on each device are the primary source. This module is only
 * used when the device sees nothing locally, e.g. when Spotify plays on another
 * device via Spotify Connect. Login happens once, in a browser on the machine that
 * runs this server (Authorization Code + PKCE, no client secret needed), and the
 * tokens are stored server-side so every client (desktop or Android) can use them.
 *
 * MVP limitation: one Spotify account per server (personal use / Development Mode).
 */
import crypto from "node:crypto";
import { deleteSetting, getSetting, setSetting, type Db } from "./db.js";

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";
const SCOPES = "user-read-currently-playing user-read-playback-state";

export interface SpotifyConfig {
  clientId?: string;
  redirectUri: string;
  /** Injected in tests so they don't call Spotify. */
  fetch?: typeof fetch;
  /** Clock (epoch ms); injected in tests. */
  now?: () => number;
}

const now = (cfg: SpotifyConfig) => (cfg.now ?? Date.now)();
const doFetch = (cfg: SpotifyConfig): typeof fetch => cfg.fetch ?? fetch;

/** Same shape the device detectors return, so the client treats both alike. */
export interface NowPlayingTrack {
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  positionMs?: number;
  isPlaying: boolean;
  spotifyId?: string;
  artworkUrl?: string;
  source: "os" | "spotify-api";
  player: string;
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

const TOKENS_KEY = "spotify.tokens";
const pendingLogins = new Map<string, { verifier: string; createdAt: number }>();
const LOGIN_TTL_MS = 600_000;

/** The callback's state doesn't match a login started in the last 10 minutes. */
export class LoginStateError extends Error {}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildLoginUrl(cfg: SpotifyConfig): string {
  if (!cfg.clientId) throw new Error("SPOTIFY_CLIENT_ID is not set");
  // Drop stale login attempts (older than 10 minutes).
  for (const [k, v] of pendingLogins) if (now(cfg) - v.createdAt > LOGIN_TTL_MS) pendingLogins.delete(k);

  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));
  pendingLogins.set(state, { verifier, createdAt: now(cfg) });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    scope: SCOPES,
    redirect_uri: cfg.redirectUri,
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(
  cfg: SpotifyConfig,
  body: Record<string, string>,
): Promise<Tokens & { refreshToken?: string }> {
  const res = await doFetch(cfg)(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Spotify token request failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? "",
    expiresAt: now(cfg) + (j.expires_in - 60) * 1000,
  };
}

export async function handleCallback(db: Db, cfg: SpotifyConfig, code: string, state: string): Promise<void> {
  const pending = pendingLogins.get(state);
  pendingLogins.delete(state);
  if (!pending || now(cfg) - pending.createdAt > LOGIN_TTL_MS) {
    throw new LoginStateError("Unknown or expired login state. Start the login again.");
  }
  const t = await tokenRequest(cfg, {
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId!,
    code_verifier: pending.verifier,
  });
  setSetting(db, TOKENS_KEY, JSON.stringify(t));
}

function loadTokens(db: Db): Tokens | null {
  const raw = getSetting(db, TOKENS_KEY);
  return raw ? (JSON.parse(raw) as Tokens) : null;
}

async function accessToken(db: Db, cfg: SpotifyConfig): Promise<string | null> {
  const t = loadTokens(db);
  if (!t) return null;
  if (now(cfg) < t.expiresAt) return t.accessToken;
  const fresh = await tokenRequest(cfg, {
    grant_type: "refresh_token",
    refresh_token: t.refreshToken,
    client_id: cfg.clientId!,
  });
  // Spotify may or may not rotate the refresh token.
  const next: Tokens = { ...fresh, refreshToken: fresh.refreshToken || t.refreshToken };
  setSetting(db, TOKENS_KEY, JSON.stringify(next));
  return next.accessToken;
}

export function isConnected(db: Db): boolean {
  return loadTokens(db) !== null;
}

export function disconnect(db: Db): void {
  deleteSetting(db, TOKENS_KEY);
}

/** Spotify lists album images largest first; a ~300 px one suits the player. */
export function pickArtwork(images: { url: string; width?: number | null }[] | undefined): string | undefined {
  if (!images?.length) return undefined;
  const fit = images.filter((i) => (i.width ?? 0) >= 200).at(-1);
  return (fit ?? images[0]).url;
}

// Tiny cache so several clients polling at once only cost one Spotify call.
// Kept per database, i.e. per server (and per test).
const caches = new WeakMap<Db, { at: number; value: NowPlayingTrack | null }>();
const CACHE_MS = 2_000;

export async function currentlyPlaying(db: Db, cfg: SpotifyConfig): Promise<NowPlayingTrack | null> {
  if (!cfg.clientId) return null;
  const cache = caches.get(db);
  if (cache && now(cfg) - cache.at < CACHE_MS) return cache.value;

  const token = await accessToken(db, cfg);
  if (!token) return null;

  const res = await doFetch(cfg)(`${API}/me/player/currently-playing`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let value: NowPlayingTrack | null = null;
  if (res.status === 200) {
    const j = (await res.json()) as {
      is_playing: boolean;
      progress_ms: number | null;
      currently_playing_type: string;
      item: null | {
        id: string;
        name: string;
        duration_ms: number;
        artists?: { name: string }[];
        album?: { name: string; images?: { url: string; width?: number | null }[] };
      };
    };
    // Ads, podcasts and unknown items are ignored.
    if (j.item && j.currently_playing_type === "track") {
      value = {
        title: j.item.name,
        artist: (j.item.artists ?? []).map((a) => a.name).join(", "),
        album: j.item.album?.name,
        durationMs: j.item.duration_ms,
        positionMs: j.progress_ms ?? undefined,
        isPlaying: j.is_playing,
        spotifyId: j.item.id,
        artworkUrl: pickArtwork(j.item.album?.images),
        source: "spotify-api",
        player: "Spotify (Web API)",
      };
    }
  } else if (res.status === 401) {
    // Token revoked: force a new login.
    disconnect(db);
  } else if (res.status !== 204) {
    throw new Error(`Spotify API error ${res.status}`);
  }
  caches.set(db, { at: now(cfg), value });
  return value;
}
