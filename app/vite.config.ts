import { alphaTab } from "@coderline/alphatab-vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

// Set by `tauri android dev` so the phone can reach the dev server over the LAN.
const host = process.env.TAURI_DEV_HOST;

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
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            // Body: 4-byte length of the JSON, the JSON, then the JPEG.
            const body = Buffer.concat(chunks);
            const n = body.readUInt32BE(0);
            const meta = JSON.parse(body.subarray(4, 4 + n).toString("utf8")) as { session: string; name: string };
            const safe = (s: string) => s.replace(/[^\w.-]/g, "_");
            const out = join(dir, safe(meta.session));
            mkdirSync(out, { recursive: true });
            writeFileSync(join(out, `${safe(meta.name)}.jpg`), body.subarray(4 + n));
            writeFileSync(join(out, `${safe(meta.name)}.json`), JSON.stringify(meta));
            res.statusCode = 204;
          } catch (e) {
            res.statusCode = 400;
            server.config.logger.warn(`capture failed: ${String(e)}`);
          }
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [alphaTab(), captureFrames()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/plugins/**", "**/captures/**"] },
  },
  build: {
    target: "es2022",
  },
});
