// Replays clips recorded in the app (fretcam "Clip") through the neck finding, headless,
// and prints how well the neck was followed (src/replay.ts, src/replaymetrics.ts).
//
//   npm run replay                         every clip in app/clips (or GUITARFISH_CLIPS)
//   npm run replay -- <clip> …             these clips
//   npm run replay -- --save before        also keep the results as "before"
//   npm run replay -- --base before        and show the change since "before"
//
// Results go to app/clips/<clip>/replay-<name>.json ("latest" unless --save).
import { chromium } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(process.env.GUITARFISH_CLIPS ?? join(app, "clips"));

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const [, value] = args.splice(i, 2);
  return value;
};
const save = option("--save") ?? "latest";
const base = option("--base");
const names = args.length ? args : existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, "clip.json"))).sort() : [];
if (!names.length) {
  console.error(`No clips in ${dir}: record one with "Clip" in a dev build.`);
  process.exit(1);
}

const server = await createServer({ root: app, configFile: join(app, "vite.config.ts"), server: { port: 1430, strictPort: false, hmr: false }, logLevel: "warn" });
await server.listen();
const url = server.resolvedUrls.local[0];
// WebGPU where the machine has it, as in the app (else the model runs on the CPU: slower, and a little different).
const browser = await chromium.launch({ args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"] });
const results = [];
try {
  for (const name of names) {
    const page = await browser.newPage();
    page.on("console", (m) => m.type() === "error" && console.error(`  [page] ${m.text()}`));
    const started = Date.now();
    process.stdout.write(`${name} … `);
    await page.goto(`${url}replay.html?clip=${encodeURIComponent(name)}`);
    await page.waitForFunction(() => window.replayResult || window.replayError, null, { timeout: 0, polling: 500 });
    const [result, error] = await page.evaluate(() => [window.replayResult, window.replayError]);
    await page.close();
    if (error) {
      console.log(`failed: ${error}`);
      continue;
    }
    console.log(`${((Date.now() - started) / 1000).toFixed(0)} s (model: ${result.backend})`);
    writeFileSync(join(dir, name, `replay-${save}.json`), JSON.stringify(result, null, 2));
    const before = base && existsSync(join(dir, name, `replay-${base}.json`)) ? JSON.parse(readFileSync(join(dir, name, `replay-${base}.json`), "utf8")) : null;
    results.push({ name, result, before });
  }
} finally {
  await browser.close();
  await server.close();
}

// Each row: label, how to read it from the stats, decimals, and which way is better.
const ROWS = [
  ["shown %", (s) => 100 * s.shown, 1, +1],
  ["locked %", (s) => 100 * s.locked, 1, +1],
  ["first lock s", (s) => s.firstLock, 2, -1],
  ["losses", (s) => s.losses, 0, -1],
  ["longest gap s", (s) => s.longestGap, 2, -1],
  ["jitter median %", (s) => s.jitter.median, 3, -1],
  ["jitter p95 %", (s) => s.jitter.p95, 3, -1],
  ["jumps", (s) => s.jumps, 0, -1],
  ["answers ok", (s) => s.answers.ok, 0, +1],
  ["disagree median", (s) => s.disagree.median, 3, -1],
  ["disagree p95", (s) => s.disagree.p95, 3, -1],
  ["disagree > 0.4 %", (s) => 100 * s.disagree.over, 1, -1],
];
const fmt = (v, d) => (v === null || v === undefined || Number.isNaN(v) ? "—" : v.toFixed(d));
for (const { name, result, before } of results) {
  const s = result.stats;
  console.log(`\n${name}: ${s.frames} frames, ${s.seconds.toFixed(1)} s${result.missing ? `, ${result.missing} missing` : ""}${before ? ` (vs ${base})` : ""}`);
  for (const [label, get, d, better] of ROWS) {
    const now = get(s);
    let change = "";
    if (before) {
      const was = get(before.stats);
      if (Number.isFinite(now) && Number.isFinite(was) && now.toFixed(d) !== was.toFixed(d)) change = `  ${was.toFixed(d)} → ${now.toFixed(d)} ${(now - was) * better > 0 ? "better" : "worse"}`;
    }
    console.log(`  ${label.padEnd(17)} ${fmt(now, d).padStart(8)}${change}`);
  }
}
