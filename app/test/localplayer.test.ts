import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampSpeed, LocalPlayer, MAX_SPEED, mediaErrorMessage, MIN_SPEED, PLAYER_KEY, SPEED_RAMP_MS, type MediaLike, type PlayerDeps } from "../src/localplayer";
import type { LocalTrack } from "../src/music";

/** An HTMLAudioElement stand-in: the test fires the events a browser would. */
class FakeMedia implements MediaLike {
  src = "";
  currentTime = 0;
  duration = NaN;
  paused = true;
  error: { code: number } | null = null;
  volume = 1;
  muted = false;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = false;
  playError: unknown = null;
  private handlers = new Map<string, (() => void)[]>();
  addEventListener(type: string, fn: () => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  emit(type: string) {
    for (const fn of this.handlers.get(type) ?? []) fn();
  }
  play = vi.fn(async () => {
    if (this.playError) throw this.playError;
    this.paused = false;
    this.emit("play");
    this.emit("playing");
  });
  pause = vi.fn(() => {
    if (this.paused) return;
    this.paused = true;
    this.emit("pause");
  });
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });
  /** The browser opened the file. */
  opened(seconds: number) {
    this.duration = seconds;
    this.emit("loadedmetadata");
  }
}

const track = (id: number, over: Partial<LocalTrack> = {}): LocalTrack => ({
  id,
  title: `Song ${id}`,
  artist: "Band",
  album: "",
  durationMs: 200_000,
  fileName: `${id}.mp3`,
  size: 1,
  fingerprint: `fp${id}`,
  path: `/m/${id}.mp3`,
  artId: null,
  addedAt: 0,
  ...over,
});

function memoryStorage() {
  const data: Record<string, string> = {};
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
}

function setup(over: Partial<PlayerDeps> = {}) {
  const media = new FakeMedia();
  const tracks = new Map([1, 2, 3, 4].map((id) => [id, track(id)]));
  const released: string[] = [];
  const storage = memoryStorage();
  const deps: PlayerDeps = {
    media,
    getTrack: (id) => tracks.get(id) ?? null,
    resolve: vi.fn(async (t: LocalTrack) => ({ url: `asset://${t.id}`, release: () => void released.push(`asset://${t.id}`) })),
    storage,
    rng: () => 0.5,
    onChange: vi.fn(),
    onError: vi.fn(),
    onDuration: vi.fn(),
    ...over,
  };
  const player = new LocalPlayer(deps);
  return { player, media, tracks, released, storage, deps };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("clampSpeed", () => {
  it("keeps the speed between 0.25× and 1.5×", () => {
    expect(clampSpeed(0.1)).toBe(MIN_SPEED);
    expect(clampSpeed(3)).toBe(MAX_SPEED);
    expect(clampSpeed("0.754")).toBe(0.75);
    expect(clampSpeed("fast")).toBe(1);
  });
});

describe("playback", () => {
  it("plays a list from the chosen track", async () => {
    const { player, media } = setup();
    await player.playList([1, 2, 3], 1, { kind: "library" });
    expect(media.src).toBe("asset://2");
    expect(media.play).toHaveBeenCalled();
    expect(player.playing).toBe(true);
    expect(player.nowPlaying()).toMatchObject({ title: "Song 2", isPlaying: true, source: "local", spotifyId: null });
  });

  it("pauses, resumes and seeks", async () => {
    const { player, media } = setup();
    await player.playList([1], 0, { kind: "library" });
    media.opened(200);
    await player.toggle();
    expect(player.playing).toBe(false);
    player.seek(30_000);
    expect(media.currentTime).toBe(30);
    expect(player.positionMs).toBe(30_000);
    player.seek(999_999);
    expect(media.currentTime).toBe(200);
    player.seek(-5);
    expect(media.currentTime).toBe(0);
    await player.toggle();
    expect(player.playing).toBe(true);
  });

  it("moves through the queue and stops at its end", async () => {
    const { player, media } = setup();
    await player.playList([1, 2], 0, { kind: "library" });
    await player.next();
    expect(media.src).toBe("asset://2");
    await player.next();
    expect(player.playing).toBe(false);
    expect(player.track?.id).toBe(2);
  });

  it("previous restarts the track after 3 s, else goes back", async () => {
    const { player, media } = setup();
    await player.playList([1, 2], 1, { kind: "library" });
    media.opened(200);
    media.currentTime = 10;
    await player.previous();
    expect(media.currentTime).toBe(0);
    expect(player.track?.id).toBe(2);
    await player.previous();
    expect(player.track?.id).toBe(1);
  });

  it("plays on when a track ends, and repeats one without reopening it", async () => {
    const { player, media, deps } = setup();
    await player.playList([1, 2], 0, { kind: "library" });
    media.emit("ended");
    await vi.waitFor(() => expect(media.src).toBe("asset://2"));
    player.setRepeat("one");
    media.currentTime = 199;
    media.emit("ended");
    await vi.waitFor(() => expect(media.currentTime).toBe(0));
    expect(deps.resolve).toHaveBeenCalledTimes(2);
    player.setRepeat("all");
    media.emit("ended");
    await vi.waitFor(() => expect(media.src).toBe("asset://1"));
  });

  it("shuffles the rest of the queue, keeping the current track", async () => {
    const { player } = setup();
    await player.playList([1, 2, 3, 4], 2, { kind: "library" });
    player.setShuffle(true);
    expect(player.upNext.order[0]).toBe(3);
    expect([...player.upNext.order].sort()).toEqual([1, 2, 3, 4]);
    player.setShuffle(false);
    expect(player.upNext).toEqual({ order: [1, 2, 3, 4], pos: 2 });
  });

  it("jumps to a track of the queue", async () => {
    const { player, media } = setup();
    await player.playList([1, 2, 3], 0, { kind: "library" });
    await player.playInQueue(3);
    expect(media.src).toBe("asset://3");
  });

  it("does nothing without a track", async () => {
    const { player, media } = setup();
    await player.play();
    await player.next();
    await player.playList([], 0, { kind: "library" });
    expect(media.play).not.toHaveBeenCalled();
    expect(player.nowPlaying()).toBeNull();
  });
});

describe("resources", () => {
  it("releases the previous file when another track loads", async () => {
    const { player, media, released } = setup();
    await player.playList([1, 2], 0, { kind: "library" });
    await player.next();
    expect(released).toEqual(["asset://1"]);
    expect(media.removeAttribute).toHaveBeenCalledWith("src");
  });

  it("drops a file that resolves after a newer track was chosen", async () => {
    let finish!: () => void;
    const slow = new Promise<void>((r) => (finish = r));
    const released: string[] = [];
    const { player, media } = setup({
      resolve: async (t) => {
        if (t.id === 1) await slow;
        return { url: `asset://${t.id}`, release: () => void released.push(`asset://${t.id}`) };
      },
    });
    const first = player.playList([1, 2], 0, { kind: "library" });
    await player.next();
    finish();
    await first;
    expect(media.src).toBe("asset://2");
    expect(released).toEqual(["asset://1"]);
  });
});

describe("volume", () => {
  it("sets volume and mute on the element", async () => {
    const { player, media } = setup();
    player.setVolume(30);
    expect(media.volume).toBeCloseTo(0.3);
    player.toggleMute();
    expect(media.muted).toBe(true);
    expect(player.muted).toBe(true);
    player.setVolume(40); // raising the volume unmutes
    expect(media.muted).toBe(false);
    player.setVolume(0);
    player.toggleMute();
    player.toggleMute(); // unmuting at 0 restores an audible level
    expect(player.volume).toBe(50);
    player.setVolume(Number.NaN);
    expect(player.volume).toBe(0);
  });
});

describe("speed", () => {
  it("keeps the pitch and glides to the new speed while playing", async () => {
    const { player, media } = setup();
    await player.playList([1], 0, { kind: "library" });
    player.setSpeed(0.5);
    expect(player.speed).toBe(0.5);
    expect(media.preservesPitch).toBe(true);
    expect(media.playbackRate).toBe(1); // not yet: it glides
    vi.advanceTimersByTime(SPEED_RAMP_MS / 2);
    expect(media.playbackRate).toBeGreaterThan(0.5);
    expect(media.playbackRate).toBeLessThan(1);
    vi.advanceTimersByTime(SPEED_RAMP_MS);
    expect(media.playbackRate).toBe(0.5);
  });

  it("jumps when paused or asked to", async () => {
    const { player, media } = setup();
    player.setSpeed(1.25);
    expect(media.playbackRate).toBe(1.25);
    await player.playList([1], 0, { kind: "library" });
    player.setSpeed(0.75, false);
    expect(media.playbackRate).toBe(0.75);
  });

  it("a new change replaces a glide in progress", async () => {
    const { player, media } = setup();
    await player.playList([1], 0, { kind: "library" });
    player.setSpeed(0.25);
    vi.advanceTimersByTime(60);
    player.setSpeed(1.5);
    vi.advanceTimersByTime(SPEED_RAMP_MS * 2);
    expect(media.playbackRate).toBe(1.5);
  });

  it("keeps the speed across tracks (a new file resets the element's rate)", async () => {
    const { player, media } = setup();
    player.setSpeed(0.75, false);
    await player.playList([1, 2], 0, { kind: "library" });
    await player.next();
    media.playbackRate = 1; // what a browser does on a new source
    media.opened(100);
    expect(media.playbackRate).toBe(0.75);
    expect(media.defaultPlaybackRate).toBe(0.75);
  });
});

describe("A/B loop", () => {
  it("jumps back to A when B is reached", async () => {
    const { player, media } = setup();
    await player.playList([1], 0, { kind: "library" });
    media.opened(200);
    player.setLoop(10_000, 20_000);
    media.currentTime = 19.9;
    vi.advanceTimersByTime(30);
    expect(media.currentTime).toBe(19.9);
    media.currentTime = 20.01;
    vi.advanceTimersByTime(30);
    expect(media.currentTime).toBe(10);
    media.currentTime = 20.5;
    media.emit("timeupdate");
    expect(media.currentTime).toBe(10);
  });

  it("one button sets A, then B (jumping to A), then clears", async () => {
    const { player, media } = setup();
    await player.playList([1], 0, { kind: "library" });
    media.opened(200);
    media.currentTime = 5;
    player.cycleLoop();
    expect(player.loop).toEqual({ a: 5000, b: null });
    media.currentTime = 5.1; // too short a loop: ignored
    player.cycleLoop();
    expect(player.loop.b).toBeNull();
    media.currentTime = 12;
    player.cycleLoop();
    expect(player.loop).toEqual({ a: 5000, b: 12000 });
    expect(media.currentTime).toBe(5);
    player.cycleLoop();
    expect(player.loop).toEqual({ a: null, b: null });
  });

  it("rejects an end before the start and clears with the track", async () => {
    const { player, media } = setup();
    await player.playList([1, 2], 0, { kind: "library" });
    media.opened(200);
    player.setLoop(30_000, 10_000);
    expect(player.loop).toEqual({ a: 30_000, b: null });
    player.setLoop(0, 500_000);
    expect(player.loop.b).toBe(200_000);
    await player.next();
    expect(player.loop).toEqual({ a: null, b: null });
  });

  it("repeat one keeps repeating a song that left its playlist", async () => {
    const { player, media, deps } = setup();
    await player.playList([1, 2, 3], 1, { kind: "playlist", id: 1 });
    player.setRepeat("one");
    player.listChanged({ kind: "playlist", id: 1 }, [1, 3]);
    media.currentTime = 199;
    media.emit("ended");
    await vi.waitFor(() => expect(media.currentTime).toBe(0));
    expect(media.src).toBe("asset://2");
    expect(deps.resolve).toHaveBeenCalledTimes(1);
  });

  it("loops a section that ends at the end of the track", async () => {
    const { player, media } = setup();
    await player.playList([1, 2], 0, { kind: "library" });
    media.opened(200);
    player.setLoop(190_000, 200_000);
    media.currentTime = 200;
    media.emit("ended");
    await vi.waitFor(() => expect(media.currentTime).toBe(190));
    expect(media.src).toBe("asset://1");
    expect(player.loopActive).toBe(true);
  });

  it("keeps a loop set on a restored track when Play opens it", async () => {
    const a = setup();
    await a.player.playList([1, 2], 1, { kind: "library" });
    a.player.pause();
    const b = setup({ storage: a.storage });
    b.player.restore();
    b.player.setLoop(5000, 9000);
    await b.player.play();
    expect(b.player.loop).toEqual({ a: 5000, b: 9000 });
  });

  it("doesn't check the loop while paused", async () => {
    const { player, media } = setup();
    await player.playList([1], 0, { kind: "library" });
    media.opened(200);
    player.setLoop(1000, 2000);
    player.pause();
    media.currentTime = 50;
    vi.advanceTimersByTime(100);
    expect(media.currentTime).toBe(50);
  });
});

describe("errors", () => {
  it("reports a missing file and moves on to the next track", async () => {
    const { player, media, deps } = setup({
      resolve: async (t) => {
        if (t.id === 1) throw new Error("The file is no longer at /m/1.mp3");
        return { url: `asset://${t.id}`, release: () => {} };
      },
    });
    await player.playList([1, 2], 0, { kind: "library" });
    await vi.waitFor(() => expect(media.src).toBe("asset://2"));
    expect(deps.onError).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "The file is no longer at /m/1.mp3");
  });

  it("reports a decoding failure", async () => {
    const { player, media, deps } = setup();
    await player.playList([1], 0, { kind: "library" });
    media.error = { code: 3 };
    media.emit("error");
    expect(player.error).toMatch(/damaged/);
    expect(deps.onError).toHaveBeenCalledTimes(1);
  });

  it("stops when every track of the queue fails", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("gone");
    });
    const { player } = setup({ resolve });
    player.setRepeat("all");
    await player.playList([1, 2, 3], 0, { kind: "library" });
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(100);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(player.error).toBe("gone");
  });

  it("reports a refused play(), but not one cut short by a newer load", async () => {
    const { player, media, deps } = setup();
    media.playError = new DOMException("blocked", "NotAllowedError");
    await player.playList([1], 0, { kind: "library" });
    expect(deps.onError).toHaveBeenCalledTimes(1);
    media.playError = new DOMException("interrupted", "AbortError");
    await player.play();
    expect(deps.onError).toHaveBeenCalledTimes(1);
  });

  it("ignores the error of a source removed on purpose", async () => {
    const { player, media, deps } = setup();
    await player.playList([1], 0, { kind: "library" });
    player.trackRemoved(1);
    media.emit("error");
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("names media errors", () => {
    expect(mediaErrorMessage(2)).toMatch(/moved, deleted/);
    expect(mediaErrorMessage(4)).toMatch(/missing/);
    expect(mediaErrorMessage(undefined)).toMatch(/couldn't be played/);
  });
});

describe("library changes", () => {
  it("follows edits of the playing playlist", async () => {
    const { player } = setup();
    await player.playList([1, 2, 3], 0, { kind: "playlist", id: 7 });
    player.listChanged({ kind: "playlist", id: 8 }, [3, 2, 1]); // another playlist: ignored
    expect(player.upNext.order).toEqual([1, 2, 3]);
    player.listChanged({ kind: "playlist", id: 7 }, [3, 1, 2]);
    expect(player.upNext).toEqual({ order: [3, 1, 2], pos: 1 });
  });

  it("a playing track removed from the library gives way to the one that took its place", async () => {
    const { player, media, released } = setup();
    await player.playList([1, 2, 3], 1, { kind: "library" });
    player.trackRemoved(2);
    expect(released).toEqual(["asset://2"]);
    await vi.waitFor(() => expect(media.src).toBe("asset://3"));
    expect(player.track?.id).toBe(3);
    expect(player.upNext.order).toEqual([1, 3]);
  });

  it("a paused track removed: the next one is ready, and Play plays it", async () => {
    const { player, media } = setup();
    await player.playList([1, 2], 0, { kind: "library" });
    player.pause();
    player.trackRemoved(1);
    expect(player.track?.id).toBe(2);
    expect(media.paused).toBe(true);
    await player.play();
    expect(media.src).toBe("asset://2");
  });

  it("the last track removed: nothing is current, and Play starts the queue over", async () => {
    const { player, media } = setup();
    await player.playList([1, 2, 3], 2, { kind: "library" });
    player.pause();
    player.trackRemoved(3);
    expect(player.track).toBeNull();
    expect(player.upNext.pos).toBe(-1);
    await player.play();
    expect(media.src).toBe("asset://1");
  });

  it("the last of two tracks removed: Play plays the first", async () => {
    const { player, media } = setup();
    await player.playList([1, 2], 1, { kind: "library" });
    player.pause();
    player.trackRemoved(2);
    expect(player.track).toBeNull();
    await player.play();
    expect(media.src).toBe("asset://1");
  });

  it("drops a load still opening the track that was removed", async () => {
    let finish!: () => void;
    const opening = new Promise<void>((r) => (finish = r));
    const released: string[] = [];
    const { player, media } = setup({
      resolve: async (t) => {
        if (t.id === 1) await opening;
        return { url: `asset://${t.id}`, release: () => void released.push(`asset://${t.id}`) };
      },
    });
    const load = player.playList([1], 0, { kind: "library" });
    player.trackRemoved(1);
    finish();
    await load;
    expect(media.src).toBe("");
    expect(media.play).not.toHaveBeenCalled();
    expect(released).toEqual(["asset://1"]);
  });

  it("previous after the playing track left its playlist goes to the track before it, not two back", async () => {
    const { player, media } = setup();
    await player.playList([1, 2, 3, 4], 2, { kind: "playlist", id: 1 });
    player.listChanged({ kind: "playlist", id: 1 }, [1, 2, 4]); // 3, playing, removed from the playlist
    expect(player.track?.id).toBe(3); // still plays: it's still in the library
    await player.previous();
    expect(media.src).toBe("asset://2");
  });

  it("learns the real duration from the file", async () => {
    const { player, media, deps } = setup();
    await player.playList([1], 0, { kind: "library" });
    media.opened(181.5);
    expect(deps.onDuration).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 181500);
    expect(player.durationMs).toBe(181500);
  });

  it("forgets a deleted playlist as the queue's source", async () => {
    const { player } = setup();
    await player.playList([1], 0, { kind: "playlist", id: 3 });
    player.contextDeleted({ kind: "playlist", id: 3 });
    expect(player.context).toBeNull();
  });
});

describe("persistence", () => {
  it("restores queue, track, position, volume and speed, paused", async () => {
    const a = setup();
    await a.player.playList([1, 2, 3], 0, { kind: "playlist", id: 5 });
    await a.player.next();
    a.media.opened(200);
    a.media.currentTime = 42;
    a.player.setVolume(35);
    a.player.setSpeed(0.75, false);
    a.player.setShuffle(true);
    a.player.setRepeat("all");
    a.player.pause();

    const b = setup({ storage: a.storage });
    b.player.restore();
    expect(b.player.track?.id).toBe(2);
    expect(b.player.playing).toBe(false);
    expect(b.player.positionMs).toBe(42_000);
    expect(b.player.context).toEqual({ kind: "playlist", id: 5 });
    expect(b.player).toMatchObject({ volume: 35, speed: 0.75, shuffle: true, repeat: "all" });
    expect(b.media.src).toBe(""); // the file opens on play, not at startup
    await b.player.play();
    expect(b.media.src).toBe("asset://2");
    b.media.opened(200);
    expect(b.media.currentTime).toBe(42);
  });

  it("drops tracks that left the library", async () => {
    const a = setup();
    await a.player.playList([1, 2, 3], 2, { kind: "library" });
    const b = setup({ storage: a.storage });
    b.tracks.delete(3);
    b.tracks.delete(1);
    b.player.restore();
    expect(b.player.track).toBeNull();
    expect(b.player.upNext.order).toEqual([2]);
  });

  it("scrubbing doesn't save the session on every move", async () => {
    const { player, media, storage } = setup();
    await player.playList([1], 0, { kind: "library" });
    media.opened(200);
    player.seek(10_000);
    player.seek(50_000, false);
    expect(media.currentTime).toBe(50);
    expect(JSON.parse(storage.data[PLAYER_KEY]).positionMs).toBe(10_000);
  });

  it("saves the position now and then while playing", async () => {
    const { player, media, storage } = setup();
    await player.playList([1], 0, { kind: "library" });
    media.opened(200);
    media.currentTime = 12;
    vi.advanceTimersByTime(6000);
    media.emit("timeupdate");
    expect(JSON.parse(storage.data[PLAYER_KEY]).positionMs).toBe(12_000);
  });

  it("survives missing or corrupt storage", () => {
    const storage = memoryStorage();
    storage.data[PLAYER_KEY] = "{oops";
    const { player } = setup({ storage });
    player.restore();
    expect(player.track).toBeNull();
    const none = setup({ storage: undefined });
    none.player.restore();
    none.player.setVolume(20);
  });
});
