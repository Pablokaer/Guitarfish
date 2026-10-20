import { alphaTab } from "@coderline/alphatab-vite";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

// Set by `tauri android dev` so the phone can reach the dev server over the LAN.
const host = process.env.TAURI_DEV_HOST;

const safe = (s: string) => s.replace(/[^\w.-]/g, "_");

/** A POST body of 4-byte length of the JSON, the JSON, then a file. */
function readPost<T>(req: IncomingMessage): Promise<{ meta: T; file: Buffer }> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", fail);
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks);
        const n = body.readUInt32BE(0);
        done({ meta: JSON.parse(body.subarray(4, 4 + n).toString("utf8")) as T, file: body.subarray(4 + n) });
      } catch (e) {
        fail(e);
      }
    });
  });
}

/**
 * Dev server only: POST /__capture saves a camera frame and the neck found in it
 * (fretcam.ts "Record"), to train the fret model on the developer's own guitar.
 * Frames go to app/captures/ (ignored by git), or GUITARFISH_CAPTURES.
 */
function captureFrames(): Plugin {
  const dir = resolve(process.env.GUITARFISH_CAPTURES ?? join(__dirname, "captures"));
  return {
    name: "guitarfish-capture",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__capture", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        readPost<{ session: string; name: string }>(req).then(
          ({ meta, file }) => {
            const out = join(dir, safe(meta.session));
            mkdirSync(out, { recursive: true });
            writeFileSync(join(out, `${safe(meta.name)}.jpg`), file);
            writeFileSync(join(out, `${safe(meta.name)}.json`), JSON.stringify(meta));
            res.statusCode = 204;
            res.end();
          },
          (e) => {
            res.statusCode = 400;
            server.config.logger.warn(`capture failed: ${String(e)}`);
            res.end();
          },
        );
      });
    },
  };
}

/**
 * Dev server only: clips of the camera (fretcam.ts "Clip", clip.ts), to replay the neck
 * finding offline (replay.html, `npm run replay`). POST /__clip saves a clip's file;
 * GET /__clips lists the clips, GET /__clips/<clip>/<file> serves one of their files.
 * Clips go to app/clips/ (ignored by git), or GUITARFISH_CLIPS.
 */
export function clips(): Plugin {
  const dir = resolve(process.env.GUITARFISH_CLIPS ?? join(__dirname, "clips"));
  return {
    name: "guitarfish-clips",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__clip", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        readPost<{ session: string; name: string }>(req).then(
          ({ meta, file }) => {
            const out = join(dir, safe(meta.session));
            mkdirSync(out, { recursive: true });
            writeFileSync(join(out, safe(meta.name)), file);
            res.statusCode = 204;
            res.end();
          },
          (e) => {
            res.statusCode = 400;
            server.config.logger.warn(`clip failed: ${String(e)}`);
            res.end();
          },
        );
      });
      server.middlewares.use("/__clips", (req, res) => {
        const parts = decodeURIComponent((req.url ?? "/").split("?")[0]).split("/").filter(Boolean);
        if (parts.length === 0) {
          const list = existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, "clip.json"))).sort() : [];
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(list));
          return;
        }
        const file = parts.length === 2 && parts.every((p) => p === safe(p) && p !== "." && p !== "..") ? join(dir, ...parts) : null;
        if (!file || !existsSync(file)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : "image/jpeg");
        res.end(readFileSync(file));
      });
    },
  };
}

export default defineConfig({
  plugins: [alphaTab(), captureFrames(), clips()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/plugins/**", "**/captures/**", "**/clips/**"] },
  },
  build: {
    target: "es2022",
  },
});
