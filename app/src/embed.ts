import { isTauri } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { getAllWebviews, getCurrentWebview, Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Shows an external page (Songsterr) inside the main window.
 *
 * Songsterr refuses to be framed (X-Frame-Options: DENY), so an <iframe> stays
 * blank. Instead this creates a native child webview and keeps it positioned over
 * `area`. Needs Tauri's `unstable` feature; desktop only.
 *
 * A native webview always draws above the page's DOM, so anything that should
 * appear on top of it (dialogs, in-app pages) must call hide() first.
 *
 * Layout changes only move and resize the native view (sync); they never close or
 * recreate it, so the Songsterr page keeps its state, scroll and playback. Only
 * open() and reload() load a page.
 */
export class EmbeddedPage {
  private view: Webview | null = null;
  private seq = 0;
  /** Labels are unique per page load: a reloaded page must not reuse a label still taken. */
  private readonly prefix = `embed-${Date.now().toString(36)}-`;
  private leftoversClosed = false;
  /** Why the view is hidden; it is shown again once no reason is left. */
  private hideReasons = new Set<string>();
  private syncQueued = false;
  private trackUntil = 0;
  private _url: string | null = null;

  constructor(private area: HTMLElement) {
    new ResizeObserver(() => this.refresh()).observe(area);
    window.addEventListener("resize", () => this.refresh());
  }

  /** Child webviews exist on desktop Tauri only (not Android, not a plain browser). */
  static supported(): boolean {
    return isTauri() && !/android/i.test(navigator.userAgent);
  }

  get isOpen(): boolean {
    return this.view !== null;
  }

  /** The URL last opened (Songsterr may have navigated away from it since). */
  get url(): string | null {
    return this._url;
  }

  private bounds() {
    const r = this.area.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
  }

  /** Opens `url`, replacing any page already shown. The area must be visible. */
  async open(url: string): Promise<void> {
    await this.close();
    this._url = url;
    // Once a window hosts several webviews, the main one must be told to keep
    // following the window size.
    await getCurrentWebview().setAutoResize(true);

    await this.closeLeftovers();
    const view = new Webview(getCurrentWindow(), `${this.prefix}${++this.seq}`, { url, ...this.bounds() });
    await new Promise<void>((resolve, reject) => {
      void view.once("tauri://created", () => resolve());
      void view.once<string>("tauri://error", (e) => reject(new Error(String(e.payload))));
    });
    this.view = view;
    if (this.hideReasons.size) await view.hide();
    await this.sync();
  }

  /**
   * Closes embedded pages left by an earlier load of this page: a native webview
   * outlives a reload of the page that made it (a dev reload, or Ctrl+R), and would
   * sit there unreachable, over the app.
   */
  private async closeLeftovers(): Promise<void> {
    if (this.leftoversClosed) return;
    this.leftoversClosed = true;
    try {
      const old = (await getAllWebviews()).filter((w) => w.label.startsWith("embed-") && !w.label.startsWith(this.prefix));
      await Promise.all(old.map((w) => w.close().catch((e) => console.warn("closing a leftover embedded page failed", e))));
    } catch (e) {
      console.warn("listing webviews failed", e);
    }
  }

  /** Loads the current page again (explicit user action). */
  async reload(): Promise<void> {
    if (this._url) await this.open(this._url);
  }

  async close(): Promise<void> {
    const view = this.view;
    this.view = null;
    this._url = null;
    if (view) await view.close().catch((e) => console.warn("closing embedded page failed", e));
  }

  /** Hides the page without unloading it, e.g. while an in-app page covers it. */
  async hide(reason = "default"): Promise<void> {
    this.hideReasons.add(reason);
    if (this.view && this.hideReasons.size === 1) await this.view.hide();
  }

  async show(reason = "default"): Promise<void> {
    if (!this.hideReasons.delete(reason) || this.hideReasons.size) return;
    if (!this.view) return;
    await this.view.show();
    await this.sync();
  }

  /** Re-aligns the view with the area on the next frame (cheap; calls coalesce). */
  refresh(): void {
    if (this.syncQueued) return;
    this.syncQueued = true;
    requestAnimationFrame(() => {
      this.syncQueued = false;
      void this.sync();
      if (performance.now() < this.trackUntil) this.refresh();
    });
  }

  /**
   * Keeps the view aligned every frame for `ms`, while CSS animates the panels
   * around the area (a ResizeObserver misses pure position changes).
   */
  track(ms: number): void {
    this.trackUntil = Math.max(this.trackUntil, performance.now() + ms);
    this.refresh();
  }

  /** Moves the native webview to match the area's current position and size. */
  private async sync(): Promise<void> {
    if (!this.view) return;
    const b = this.bounds();
    await Promise.all([
      this.view.setPosition(new LogicalPosition(b.x, b.y)),
      this.view.setSize(new LogicalSize(b.width, b.height)),
    ]).catch((e) => console.warn("positioning embedded page failed", e));
  }
}
