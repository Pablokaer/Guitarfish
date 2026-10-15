/**
 * Update check: compares the installed version with the latest published GitHub
 * release, periodically (checkForUpdate) or when the user asks (checkNow).
 * Installing is selfupdate.ts's job.
 */

export const RELEASES_API = "https://api.github.com/repos/Pablokaer/Guitarfish/releases/latest";
/** The last version the user was told about, so each release is announced once. */
const ANNOUNCED_KEY = "tabsync.update.announced";
const TIMEOUT_MS = 10_000;

export interface UpdateInfo {
  version: string;
  name: string;
  /** Release page, with the installers. */
  url: string;
}

/** Numeric comparison of dotted versions; a leading "v" is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(".").map((p) => Number.parseInt(p, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** A published, non-pre-release GitHub release with a vX.Y.Z tag, or null. */
export function parseRelease(raw: unknown): UpdateInfo | null {
  const r = raw as { tag_name?: unknown; name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown } | null;
  if (!r || r.draft || r.prerelease) return null;
  if (typeof r.tag_name !== "string" || typeof r.html_url !== "string") return null;
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(r.tag_name);
  if (!m) return null;
  const version = m[1];
  return { version, name: typeof r.name === "string" && r.name ? r.name : `Guitarfish ${version}`, url: r.html_url };
}

/** The latest release, or null when it isn't a usable one. Throws on network and HTTP errors. */
async function fetchLatestRelease(fetchImpl: typeof fetch): Promise<UpdateInfo | null> {
  const res = await fetchImpl(RELEASES_API, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return parseRelease(await res.json());
}

/**
 * Returns the latest release when it is newer than `currentVersion` and has not
 * been announced yet, and records it as announced. Errors count as "no update".
 */
export async function checkForUpdate(opts: {
  currentVersion: string;
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem">;
}): Promise<UpdateInfo | null> {
  const { currentVersion, fetchImpl = fetch, storage = localStorage } = opts;
  let release: UpdateInfo | null;
  try {
    release = await fetchLatestRelease(fetchImpl);
  } catch {
    return null;
  }
  if (!release || compareVersions(release.version, currentVersion) <= 0) return null;
  try {
    if (storage.getItem(ANNOUNCED_KEY) === release.version) return null;
    storage.setItem(ANNOUNCED_KEY, release.version);
  } catch {
    // Storage unavailable: announce anyway.
  }
  return release;
}

export type UpdateCheck = { status: "available"; update: UpdateInfo } | { status: "current" } | { status: "error" };

/**
 * The check the user asks for: always answers, even for a release already
 * announced, and tells a failed check apart from "up to date". A newer release
 * is recorded as announced, so the periodic check doesn't announce it again.
 */
export async function checkNow(opts: {
  currentVersion: string;
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, "setItem">;
}): Promise<UpdateCheck> {
  const { currentVersion, fetchImpl = fetch, storage = localStorage } = opts;
  let release: UpdateInfo | null;
  try {
    release = await fetchLatestRelease(fetchImpl);
  } catch {
    return { status: "error" };
  }
  if (!release || compareVersions(release.version, currentVersion) <= 0) return { status: "current" };
  try {
    storage.setItem(ANNOUNCED_KEY, release.version);
  } catch {
    // Storage unavailable: the periodic check may announce it once more.
  }
  return { status: "available", update: release };
}
