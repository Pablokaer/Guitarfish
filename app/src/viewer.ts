import * as alphaTab from "@coderline/alphatab";
import { barAt, barStarts } from "./timeline";
import type { TabInfo } from "./types";

/**
 * Wraps alphaTab: renders a tab and follows a playback position.
 *
 * Following works by converting the song position (ms) into a bar index using the
 * score's tempo (see timeline.ts), then scrolling that bar into view and highlighting it.
 */
export class TabViewer {
  private api: alphaTab.AlphaTabApi;
  private barStartsMs: number[] = [];
  private currentBar = -1;
  private highlight: HTMLDivElement;
  private ready = false;

  constructor(
    private host: HTMLElement,
    private scroller: HTMLElement,
    zoom = 1,
  ) {
    this.api = new alphaTab.AlphaTabApi(host, {
      core: {
        logLevel: alphaTab.LogLevel.Warning,
        // The Vite plugin copies the music font to /font/; point alphaTab at it
        // explicitly (its auto-detection looks next to the bundled script).
        fontDirectory: new URL("font/", document.baseURI).href,
      },
      display: { layoutMode: alphaTab.LayoutMode.Page, scale: zoom },
      player: { enablePlayer: false },
    });

    this.highlight = document.createElement("div");
    this.highlight.className = "bar-highlight";
    this.highlight.hidden = true;
    host.style.position = "relative";

    this.api.scoreLoaded.on((score) => this.computeTimeline(score));
    this.api.renderStarted.on(() => {
      this.ready = false;
      this.highlight.hidden = true;
    });
    this.api.postRenderFinished.on(() => {
      this.ready = true;
      // alphaTab rebuilds its DOM on render; re-attach our overlay.
      if (!this.highlight.isConnected) this.host.appendChild(this.highlight);
      this.currentBar = -1;
    });
  }

  load(format: TabInfo["format"], data: ArrayBuffer): void {
    this.scroller.scrollTop = 0;
    if (format === "alphatex") {
      this.api.tex(new TextDecoder().decode(data));
    } else {
      // Guitar Pro (3-7) and MusicXML are detected from the bytes.
      this.api.load(new Uint8Array(data));
    }
  }

  setZoom(scale: number): void {
    this.api.settings.display.scale = scale;
    this.api.updateSettings();
    this.api.render();
  }

  clear(): void {
    this.barStartsMs = [];
    this.host.querySelectorAll(".at-surface").forEach((el) => ((el as HTMLElement).innerHTML = ""));
    this.highlight.hidden = true;
  }

  /** Bar start times in ms, from time signatures and tempo automations. */
  private computeTimeline(score: alphaTab.model.Score): void {
    this.barStartsMs = barStarts(
      score.tempo,
      score.masterBars.map((mb) => ({ ticks: mb.calculateDuration(), tempo: mb.tempoAutomations?.[0]?.value })),
    );
    this.currentBar = -1;
  }

  /** Scroll to and highlight the bar playing at `positionMs`. */
  follow(positionMs: number): void {
    if (!this.ready || this.barStartsMs.length === 0) return;
    const bar = barAt(this.barStartsMs, positionMs);
    if (bar === this.currentBar) return;
    this.currentBar = bar;

    const bounds = this.api.renderer.boundsLookup?.findMasterBarByIndex(bar);
    if (!bounds) return;
    const b = bounds.visualBounds;
    const scale = 1; // bounds are already in CSS pixels relative to the host
    Object.assign(this.highlight.style, {
      left: `${b.x * scale}px`,
      top: `${b.y * scale}px`,
      width: `${b.w * scale}px`,
      height: `${b.h * scale}px`,
    });
    this.highlight.hidden = false;

    // Keep the current line in the upper third of the viewport.
    const lineTop = bounds.realBounds.y + this.host.offsetTop;
    const target = lineTop - this.scroller.clientHeight / 3;
    if (Math.abs(this.scroller.scrollTop - target) > 40) {
      this.scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
  }

  hideHighlight(): void {
    this.highlight.hidden = true;
    this.currentBar = -1;
  }
}
