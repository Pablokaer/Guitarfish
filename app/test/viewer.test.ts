import { beforeEach, describe, expect, it, vi } from "vitest";

/** Minimal alphaTab stand-in: events, settings and the calls the viewer makes. */
class Emitter<T = unknown> {
  private fns: ((v: T) => void)[] = [];
  on(fn: (v: T) => void) {
    this.fns.push(fn);
  }
  fire(v?: T) {
    for (const fn of this.fns) fn(v as T);
  }
}

class FakeApi {
  static last: FakeApi;
  settings: any;
  score: any = null;
  tracks: any[] = [];
  playbackSpeed = 1;
  isLooping = false;
  playbackRange: unknown = null;
  scoreLoaded = new Emitter<any>();
  renderStarted = new Emitter();
  postRenderFinished = new Emitter();
  playerReady = new Emitter();
  playerStateChanged = new Emitter<{ state: number; stopped: boolean }>();
  error = new Emitter();
  renderer = { boundsLookup: { findMasterBarByIndex: (i: number) => ({ visualBounds: { x: i * 100, y: 10, w: 100, h: 50 }, realBounds: { y: 900 } }) } };
  calls: string[] = [];
  constructor(
    public host: unknown,
    options: any,
  ) {
    this.settings = { ...options, notation: { transpositionPitches: [] } };
    FakeApi.last = this;
  }
  tex(t: string) {
    this.calls.push(`tex:${t}`);
  }
  load(d: Uint8Array) {
    this.calls.push(`load:${d.length}`);
  }
  updateSettings() {
    this.calls.push("updateSettings");
  }
  render() {
    this.calls.push("render");
  }
  play() {
    this.calls.push("play");
  }
  playPause() {
    this.calls.push("playPause");
  }
  stop() {
    this.calls.push("stop");
  }
  loadMidiForScore() {
    this.calls.push("loadMidiForScore");
  }
}

vi.mock("@coderline/alphatab", () => ({
  AlphaTabApi: FakeApi,
  LogLevel: { Warning: 2 },
  LayoutMode: { Page: 0 },
  PlayerMode: { Disabled: 0, EnabledSynthesizer: 2 },
  synth: { PlayerState: { Paused: 0, Playing: 1 } },
}));

const timeline = [
  { index: 0, startMs: 0, endMs: 2000 },
  { index: 1, startMs: 2000, endMs: 4000 },
  { index: 0, startMs: 4000, endMs: 6000 },
];
const scoreMock = vi.hoisted(() => ({ fail: false }));
vi.mock("../src/score", () => ({
  scoreTimeline: () => {
    if (scoreMock.fail) throw new Error("bad score");
    return timeline;
  },
  staffTuning: (_score: unknown, track: number) => (track === 0 ? { pitches: [64, 59, 55, 50, 45, 38], capo: 1 } : null),
}));

function fakeEl(): any {
  return { style: {}, dataset: {}, hidden: false, isConnected: false, className: "" };
}
vi.stubGlobal("document", { baseURI: "http://app/", createElement: () => fakeEl() });

const { TabViewer } = await import("../src/viewer");

function setup() {
  const host = { ...fakeEl(), offsetTop: 0, appended: [] as any[], appendChild(c: any) { c.isConnected = true; this.appended.push(c); }, querySelectorAll: () => [] };
  const scroller = { ...fakeEl(), scrollTop: 0, clientHeight: 300, scrollTo: vi.fn() };
  const viewer = new TabViewer(host as any, scroller as any, 1.2);
  const api = FakeApi.last;
  const highlight = () => host.appended[0];
  /** Loads a score and finishes rendering. */
  const ready = (score: any = { tracks: [{ index: 0 }] }) => {
    api.score = score;
    api.scoreLoaded.fire(score);
    api.postRenderFinished.fire();
  };
  return { viewer, api, host, scroller, highlight, ready };
}

beforeEach(() => {
  scoreMock.fail = false;
});

describe("TabViewer setup", () => {
  it("starts with the player off and the sounds, scroller and zoom configured", () => {
    const { api, host, scroller } = setup();
    expect(api.settings.player.playerMode).toBe(0);
    expect(api.settings.player.soundFont).toBe("http://app/soundfont/sonivox.sf3");
    expect(api.settings.player.scrollElement).toBe(scroller);
    expect(api.settings.core.fontDirectory).toBe("http://app/font/");
    expect(api.settings.display.scale).toBe(1.2);
    expect(host.dataset.player).toBe("stopped");
  });

  it("loads alphaTex as text and other formats as bytes", () => {
    const { viewer, api, scroller } = setup();
    scroller.scrollTop = 500;
    viewer.load("alphatex", new TextEncoder().encode(". 1.1.1").buffer);
    viewer.load("gp", new Uint8Array(4).buffer);
    expect(api.calls).toEqual(["tex:. 1.1.1", "load:4"]);
    expect(scroller.scrollTop).toBe(0);
  });

  it("draws a score loaded while hidden once it is shown", () => {
    const { viewer, api, ready } = setup();
    // Loaded behind the Songsterr view: alphaTab skips rendering at width 0.
    viewer.load("alphatex", new TextEncoder().encode(". 1.1.1").buffer);
    api.score = { tracks: [] };
    api.scoreLoaded.fire(api.score);
    viewer.whenShown();
    expect(api.calls).toEqual(["tex:. 1.1.1", "render"]);
    // Drawn: showing it again doesn't redraw.
    ready(api.score);
    viewer.whenShown();
    expect(api.calls).toEqual(["tex:. 1.1.1", "render"]);
    // A new score loads undrawn again.
    viewer.load("gp", new Uint8Array(4).buffer);
    viewer.whenShown();
    expect(api.calls.slice(2)).toEqual(["load:4", "render"]);
  });

  it("doesn't draw a score cleared before it was shown", () => {
    const { viewer, api } = setup();
    viewer.load("alphatex", new TextEncoder().encode(". 1.1.1").buffer);
    api.score = { tracks: [] };
    viewer.clear();
    viewer.whenShown();
    expect(api.calls).not.toContain("render");
  });

  it("has nothing to draw when shown before any score", () => {
    const { viewer, api } = setup();
    viewer.whenShown();
    expect(api.calls).toEqual([]);
  });

  it("re-renders on zoom", () => {
    const { viewer, api } = setup();
    viewer.setZoom(0.8);
    expect(api.settings.display.scale).toBe(0.8);
    expect(api.calls).toEqual(["updateSettings", "render"]);
  });
});

describe("TabViewer follow", () => {
  it("highlights the master bar of the play-order timeline and scrolls to it", () => {
    const { viewer, highlight, ready, scroller } = setup();
    const onScore = vi.fn();
    viewer.onScore = onScore;
    ready();
    expect(onScore).toHaveBeenCalled();
    viewer.follow(2500);
    expect(highlight().style.left).toBe("100px");
    expect(highlight().hidden).toBe(false);
    viewer.follow(4500); // the repeat: back to bar 0
    expect(highlight().style.left).toBe("0px");
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 800, behavior: "smooth" });
  });

  it("does nothing before rendering or without a timeline", () => {
    const { viewer, api, host } = setup();
    viewer.follow(1000);
    expect(host.appended).toEqual([]);
    scoreMock.fail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    api.scoreLoaded.fire({});
    api.postRenderFinished.fire();
    viewer.follow(1000);
    expect(host.appended[0].hidden).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("hides the highlight on request and while re-rendering", () => {
    const { viewer, api, highlight, ready } = setup();
    ready();
    viewer.follow(0);
    viewer.hideHighlight();
    expect(highlight().hidden).toBe(true);
    viewer.follow(0);
    api.renderStarted.fire();
    expect(highlight().hidden).toBe(true);
  });

  it("clears the timeline", () => {
    const { viewer, highlight, ready } = setup();
    ready();
    viewer.clear();
    viewer.follow(2500);
    expect(highlight().hidden).toBe(true);
  });
});

describe("TabViewer built-in player", () => {
  it("enables the player on the first Play and starts once it is ready", () => {
    const { viewer, api, ready } = setup();
    const seen: string[] = [];
    viewer.onPlayer = (s) => seen.push(`${s.state}${s.loading ? "+loading" : ""}`);
    viewer.playPause(); // no score yet
    expect(api.calls).toEqual([]);
    ready();
    viewer.playPause();
    expect(api.settings.player.playerMode).toBe(2);
    expect(api.calls).toEqual(["updateSettings"]);
    expect(viewer.player).toEqual({ state: "stopped", loading: true });
    api.playerReady.fire();
    expect(api.calls).toEqual(["updateSettings", "play"]);
    api.playerStateChanged.fire({ state: 1, stopped: false });
    expect(viewer.player).toEqual({ state: "playing", loading: false });
    expect(seen).toEqual(["stopped+loading", "stopped", "playing"]);
  });

  it("toggles a pending start while the sounds load, and gives up on an error", () => {
    const { viewer, api, ready } = setup();
    ready();
    viewer.playPause();
    viewer.playPause(); // changed their mind
    api.playerReady.fire();
    expect(api.calls).not.toContain("play");
    viewer.playPause();
    expect(api.calls).toContain("playPause");

    const b = setup();
    b.ready();
    b.viewer.playPause();
    b.api.error.fire();
    expect(b.viewer.player.loading).toBe(false);
    b.api.playerReady.fire();
    expect(b.api.calls).not.toContain("play");
    b.api.error.fire(); // not loading: ignored
  });

  it("hides the Spotify highlight while playing, and tracks pause and stop", () => {
    const { viewer, api, host, highlight, ready } = setup();
    ready();
    viewer.follow(0);
    viewer.playPause();
    api.playerReady.fire();
    api.playerStateChanged.fire({ state: 1, stopped: false });
    expect(highlight().hidden).toBe(true);
    expect(host.dataset.player).toBe("playing");
    api.playerStateChanged.fire({ state: 0, stopped: false });
    expect(viewer.player.state).toBe("paused");
    api.playerStateChanged.fire({ state: 0, stopped: true });
    expect(viewer.player.state).toBe("stopped");
  });

  it("stops the player on stop, load and clear", () => {
    const { viewer, api, ready } = setup();
    ready();
    viewer.stop(); // nothing playing: no call
    expect(api.calls).toEqual([]);
    viewer.playPause();
    api.playerReady.fire();
    api.playerStateChanged.fire({ state: 1, stopped: false });
    viewer.stop();
    expect(api.calls.at(-1)).toBe("stop");
    expect(viewer.player.state).toBe("stopped");
    api.playerStateChanged.fire({ state: 1, stopped: false });
    viewer.load("gp", new ArrayBuffer(1));
    expect(viewer.player.state).toBe("stopped");
    api.playerStateChanged.fire({ state: 1, stopped: false });
    viewer.clear();
    expect(viewer.player.state).toBe("stopped");
  });

  it("sets speed, looping and selection", () => {
    const { viewer, api } = setup();
    viewer.setSpeed(0.5);
    viewer.setLooping(true);
    expect(api.playbackSpeed).toBe(0.5);
    expect(api.isLooping).toBe(true);
    expect(viewer.hasSelection).toBe(false);
    api.playbackRange = { startTick: 0, endTick: 960 };
    expect(viewer.hasSelection).toBe(true);
    viewer.clearSelection();
    expect(viewer.hasSelection).toBe(false);
  });
});

describe("TabViewer transpose and tuning", () => {
  it("stores the transposition for the next load, without re-rendering", () => {
    const { viewer, api } = setup();
    viewer.setTranspose(3);
    expect(api.settings.notation.transpositionPitches.slice(0, 3)).toEqual([3, 3, 3]);
    expect(api.calls).toEqual([]);
    viewer.setTranspose(0);
    expect(api.settings.notation.transpositionPitches).toEqual([]);
  });

  it("re-renders a loaded score and reloads the player's song", () => {
    const { viewer, api, ready } = setup();
    ready();
    viewer.setTranspose(-2);
    expect(api.calls).toEqual(["updateSettings", "render"]);
    viewer.playPause();
    api.playerReady.fire();
    api.playerStateChanged.fire({ state: 1, stopped: false });
    api.calls = [];
    viewer.setTranspose(1);
    expect(api.calls).toEqual(["updateSettings", "render", "loadMidiForScore"]);
    expect(viewer.player.state).toBe("stopped");
  });

  it("describes the first shown track's tuning", () => {
    const { viewer, api, ready } = setup();
    expect(viewer.tuning()).toBeNull();
    ready();
    expect(viewer.tuning()).toEqual({ notes: "D A D G B E", name: "Drop D", capo: 1 });
    api.tracks = [{ index: 2 }];
    expect(viewer.tuning()).toBeNull();
  });
});
