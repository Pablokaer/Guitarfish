import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import {
  getSong,
  getTab,
  insertSong,
  insertTab,
  linkExternalId,
  tabsForSong,
  type Db,
  type SongRow,
  type TabFormat,
} from "./db.js";
import { lookup, search } from "./matching.js";
import { searchSongsterr } from "./songsterr.js";
import * as spotify from "./spotify.js";

export interface AppOptions {
  db: Db;
  spotify: spotify.SpotifyConfig;
  logger?: boolean;
  /** Injected in tests so they don't hit songsterr.com. */
  songsterrFetch?: typeof fetch;
}

/** Public shape of a song, with its available tabs. */
function songDto(db: Db, s: SongRow) {
  return {
    id: s.id,
    title: s.title,
    artist: s.artist,
    durationMs: s.duration_ms,
    tabs: tabsForSong(db, s.id).map((t) => ({
      id: t.id,
      instrument: t.instrument,
      tuning: t.tuning,
      format: t.format,
      version: t.version,
      rating: t.rating,
      isPlaceholder: t.is_placeholder === 1,
    })),
  };
}

const FORMATS: TabFormat[] = ["alphatex", "gp", "musicxml"];

export function buildApp(opts: AppOptions): FastifyInstance {
  const { db } = opts;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 20 * 1024 * 1024 });

  // The Tauri webview has its own origin (tauri://localhost, http://tauri.localhost,
  // or the Vite dev server), so the API must allow cross-origin requests.
  app.register(cors, { origin: true });

  // Raw uploads for tab files (Guitar Pro is binary).
  app.addContentTypeParser(
    ["application/octet-stream", "text/plain"],
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  app.get("/health", async () => ({ ok: true }));

  // ---- Lookup -------------------------------------------------------------
  app.get<{ Querystring: { title?: string; artist?: string; durationMs?: string; spotifyId?: string } }>(
    "/v1/tabs/lookup",
    async (req, reply) => {
      const { title, artist, durationMs, spotifyId } = req.query;
      if (!title || !artist) return reply.code(400).send({ error: "title and artist are required" });
      const r = lookup(db, {
        title,
        artist,
        durationMs: durationMs ? Number(durationMs) : undefined,
        spotifyId: spotifyId || undefined,
      });
      return {
        match: r.match ? songDto(db, r.match) : null,
        confidence: r.confidence,
        method: r.method,
        candidates: r.candidates.map((c) => ({ ...songDto(db, c.song), score: c.score })),
      };
    },
  );

  // ---- Songs --------------------------------------------------------------
  app.get<{ Querystring: { q?: string } }>("/v1/songs", async (req) => {
    const q = (req.query.q ?? "").trim();
    return { results: search(db, q).map((r) => ({ ...songDto(db, r.song), score: r.score })) };
  });

  app.get<{ Params: { id: string } }>("/v1/songs/:id", async (req, reply) => {
    const s = getSong(db, Number(req.params.id));
    if (!s) return reply.code(404).send({ error: "song not found" });
    return songDto(db, s);
  });

  app.post<{ Body: { title?: string; artist?: string; durationMs?: number; isrc?: string } }>(
    "/v1/songs",
    async (req, reply) => {
      const { title, artist, durationMs, isrc } = req.body ?? {};
      if (!title || !artist) return reply.code(400).send({ error: "title and artist are required" });
      const s = insertSong(db, { title, artist, durationMs, isrc });
      return reply.code(201).send(songDto(db, s));
    },
  );

  // Confirm a match: link e.g. a Spotify track ID to one of our songs.
  app.post<{ Params: { id: string }; Body: { provider?: string; externalId?: string } }>(
    "/v1/songs/:id/external-ids",
    async (req, reply) => {
      const songId = Number(req.params.id);
      const { provider, externalId } = req.body ?? {};
      if (!getSong(db, songId)) return reply.code(404).send({ error: "song not found" });
      if (!provider || !externalId) return reply.code(400).send({ error: "provider and externalId are required" });
      linkExternalId(db, songId, provider, externalId);
      return { ok: true };
    },
  );

  // Upload a tab: raw body, format in the query string.
  // curl -X POST --data-binary @song.gp -H 'Content-Type: application/octet-stream' \
  //   'http://localhost:8787/v1/songs/1/tabs?format=gp'
  app.post<{ Params: { id: string }; Querystring: { format?: string; instrument?: string; tuning?: string } }>(
    "/v1/songs/:id/tabs",
    async (req, reply) => {
      const songId = Number(req.params.id);
      if (!getSong(db, songId)) return reply.code(404).send({ error: "song not found" });
      const format = req.query.format as TabFormat;
      if (!FORMATS.includes(format)) return reply.code(400).send({ error: `format must be one of ${FORMATS.join(", ")}` });
      const body = req.body;
      const content = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : "");
      if (content.length === 0) return reply.code(400).send({ error: "empty body" });
      const id = insertTab(db, { songId, format, content, instrument: req.query.instrument, tuning: req.query.tuning });
      return reply.code(201).send({ id });
    },
  );

  // ---- Tabs ---------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/v1/tabs/:id/content", async (req, reply) => {
    const t = getTab(db, Number(req.params.id));
    if (!t) return reply.code(404).send({ error: "tab not found" });
    reply.header("X-Tab-Format", t.format);
    reply.header("Access-Control-Expose-Headers", "X-Tab-Format");
    reply.header("Cache-Control", "public, max-age=3600");
    reply.type(t.format === "gp" ? "application/octet-stream" : "text/plain; charset=utf-8");
    return reply.send(t.content);
  });

  // ---- Songsterr (links only) -------------------------------------------
  app.get<{ Querystring: { q?: string } }>("/v1/songsterr/search", async (req, reply) => {
    const q = (req.query.q ?? "").trim();
    if (!q) return reply.code(400).send({ error: "q is required" });
    try {
      return { results: await searchSongsterr(q, opts.songsterrFetch) };
    } catch (e) {
      req.log.warn({ err: e }, "songsterr search failed");
      return reply.code(502).send({ error: "Songsterr search failed" });
    }
  });

  // ---- Spotify fallback ---------------------------------------------------
  app.get("/auth/spotify/login", async (_req, reply) => {
    if (!opts.spotify.clientId) {
      return reply
        .code(400)
        .type("text/html")
        .send("<h3>SPOTIFY_CLIENT_ID is not set.</h3><p>See README → Spotify fallback.</p>");
    }
    return reply.redirect(spotify.buildLoginUrl(opts.spotify));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/auth/spotify/callback",
    async (req, reply) => {
      const { code, state, error } = req.query;
      if (error || !code || !state) {
        return reply.code(400).type("text/html").send(`<h3>Spotify login failed: ${error ?? "missing code"}</h3>`);
      }
      await spotify.handleCallback(db, opts.spotify, code, state);
      return reply
        .type("text/html")
        .send("<h3>Spotify connected.</h3><p>You can close this tab and return to Guitarfish.</p>");
    },
  );

  app.get("/auth/spotify/status", async () => ({
    configured: Boolean(opts.spotify.clientId),
    connected: spotify.isConnected(db),
  }));

  app.post("/auth/spotify/logout", async () => {
    spotify.disconnect(db);
    return { ok: true };
  });

  app.get("/v1/spotify/now-playing", async () => ({
    track: await spotify.currentlyPlaying(db, opts.spotify),
  }));

  return app;
}
