/**
 * Runs in the page before the app (bundled by fixtures.ts, injected with
 * page.addInitScript): makes the built UI behave as inside Tauri.
 *
 * - `mockIPC` answers every `invoke()` by asking the test, through the
 *   `__e2eInvoke` binding (page.exposeFunction): see FakeTauri in fixtures.ts.
 * - `mockWindows("main")` gives the app its window and webview labels.
 * - `mockConvertFileSrc("windows")` turns local file paths into
 *   http://asset.localhost/… URLs, which FakeTauri serves from its fake disk.
 * - The catalogue is seeded through the app's own Catalogue class (same
 *   IndexedDB schema), once per test, before any IPC call is answered, so the
 *   first track lookup already sees it.
 */
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { Catalogue } from "../src/catalogue";
import type { TabFormat } from "../src/types";

/** A tab to seed: the song, the file (as text) and an optional confirmed Spotify ID. */
export interface SeedTab {
  title: string;
  artist: string;
  name: string;
  format: TabFormat;
  text: string;
  spotifyId?: string;
}

declare global {
  interface Window {
    __e2eInvoke(cmd: string, args: unknown): Promise<unknown>;
    __e2eSeed?: SeedTab[];
    isTauri?: boolean;
  }
}

async function seed(): Promise<void> {
  const tabs = window.__e2eSeed ?? [];
  // Only on the first load of the test's page: reloads keep what the test changed.
  if (!tabs.length || sessionStorage.getItem("e2e.catalogue")) return;
  sessionStorage.setItem("e2e.catalogue", "1");
  const c = await Catalogue.open();
  for (const t of tabs) {
    const { song } = await c.addTab({ ...t, data: new TextEncoder().encode(t.text).buffer as ArrayBuffer });
    if (t.spotifyId) await c.confirm({ spotifyId: t.spotifyId }, song);
  }
  c.close();
}

const ready = seed();
mockWindows("main");
/** Binary answers cross from the test as `{ base64 }` (a long list of numbers is slow); the app gets an ArrayBuffer, as from the real shell. */
function unwrap(r: unknown): unknown {
  const b64 = (r as { base64?: unknown } | null)?.base64;
  if (typeof b64 !== "string") return r;
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}

mockIPC(
  async (cmd, args) => {
    await ready;
    return unwrap(await window.__e2eInvoke(cmd, args ?? {}));
  },
  { shouldMockEvents: true },
);
mockConvertFileSrc("windows");
window.isTauri = true;
