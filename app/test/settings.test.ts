import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("navigator", { userAgent: "Macintosh" });
const { parseSettings } = await import("../src/settings");

describe("parseSettings", () => {
  it("defaults to Songsterr, following Spotify, automatic search", () => {
    expect(parseSettings(null)).toMatchObject({ songsterrPanel: true, followSpotify: true, autoSearch: true, theme: "graphite", version: 2 });
  });

  it("moves v1 users to Songsterr once, keeping their other settings", () => {
    const s = parseSettings({ songsterrPanel: false, zoom: 1.2, serverUrl: "http://x" });
    expect(s).toMatchObject({ songsterrPanel: true, zoom: 1.2, serverUrl: "http://x", version: 2 });
  });

  it("respects a v2 choice of the local tab", () => {
    expect(parseSettings({ version: 2, songsterrPanel: false }).songsterrPanel).toBe(false);
  });

  it("rejects unknown themes", () => {
    expect(parseSettings({ version: 2, theme: "neon" }).theme).toBe("graphite");
  });
});
