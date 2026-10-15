import { describe, expect, it, vi } from "vitest";
import { checkForUpdate, compareVersions, parseRelease, RELEASES_API } from "../src/update";

function memoryStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

function releaseJson(tag: string, extra: Record<string, unknown> = {}) {
  return { tag_name: tag, name: `Guitarfish ${tag.slice(1)}`, html_url: `https://github.com/x/y/releases/tag/${tag}`, draft: false, prerelease: false, ...extra };
}

function fetchReturning(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response);
}

describe("compareVersions", () => {
  it("compares each part as a number", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.3.0", "0.3.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("ignores a leading v and treats missing parts as 0", () => {
    expect(compareVersions("v0.4.0", "0.4.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });
});

describe("parseRelease", () => {
  it("reads the version and the release page", () => {
    expect(parseRelease(releaseJson("v0.4.0"))).toEqual({
      version: "0.4.0",
      name: "Guitarfish 0.4.0",
      url: "https://github.com/x/y/releases/tag/v0.4.0",
    });
  });

  it("rejects drafts, pre-releases and malformed data", () => {
    expect(parseRelease(releaseJson("v0.4.0", { draft: true }))).toBeNull();
    expect(parseRelease(releaseJson("v0.4.0", { prerelease: true }))).toBeNull();
    expect(parseRelease(releaseJson("nightly"))).toBeNull();
    expect(parseRelease({ message: "Not Found" })).toBeNull();
    expect(parseRelease(null)).toBeNull();
  });
});

describe("checkForUpdate", () => {
  it("asks GitHub for the latest release", async () => {
    const fetchImpl = fetchReturning(releaseJson("v0.4.0"));
    await checkForUpdate({ currentVersion: "0.3.0", fetchImpl, storage: memoryStorage() });
    expect(fetchImpl).toHaveBeenCalledWith(RELEASES_API, expect.anything());
  });

  it("reports a newer release once, then stays quiet for that version", async () => {
    const storage = memoryStorage();
    const fetchImpl = fetchReturning(releaseJson("v0.4.0"));
    const first = await checkForUpdate({ currentVersion: "0.3.0", fetchImpl, storage });
    expect(first?.version).toBe("0.4.0");
    expect(await checkForUpdate({ currentVersion: "0.3.0", fetchImpl, storage })).toBeNull();
  });

  it("reports the next release even after an earlier one was announced", async () => {
    const storage = memoryStorage();
    await checkForUpdate({ currentVersion: "0.3.0", fetchImpl: fetchReturning(releaseJson("v0.4.0")), storage });
    const next = await checkForUpdate({ currentVersion: "0.3.0", fetchImpl: fetchReturning(releaseJson("v0.5.0")), storage });
    expect(next?.version).toBe("0.5.0");
  });

  it("stays quiet when up to date or ahead", async () => {
    const storage = memoryStorage();
    expect(await checkForUpdate({ currentVersion: "0.4.0", fetchImpl: fetchReturning(releaseJson("v0.4.0")), storage })).toBeNull();
    expect(await checkForUpdate({ currentVersion: "0.5.0", fetchImpl: fetchReturning(releaseJson("v0.4.0")), storage })).toBeNull();
  });

  it("treats network and HTTP errors as no update", async () => {
    const storage = memoryStorage();
    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await checkForUpdate({ currentVersion: "0.3.0", fetchImpl: failing, storage })).toBeNull();
    expect(await checkForUpdate({ currentVersion: "0.3.0", fetchImpl: fetchReturning({}, false), storage })).toBeNull();
    expect(storage.data.size).toBe(0);
  });
});
