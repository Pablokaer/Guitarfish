import { escapeHtml as esc } from "./html";
import { icon } from "./icons";
import { formatSize, type OfflineStore, type SavedPage } from "./offline";

/**
 * The Offline pages: the list of saved Songsterr pages and the viewer of one,
 * with zoom and auto-scroll (to play along hands-free). They render into the
 * stage's page layer; main.ts saves the pages and decides when to show them.
 */

export interface OfflineViewDeps {
  root: HTMLElement;
  store(): Promise<OfflineStore>;
  /** The live page, when there is a connection. */
  openOnline(page: SavedPage): void;
  /** What else works offline, for the list's footer. */
  elsewhere(): { tabs: Promise<number>; songs: number };
  openMyTabs(): void;
  openMusic(): void;
  /** Called after a saved page is deleted. */
  changed?(): void;
  storage?: Pick<Storage, "getItem" | "setItem">;
}

const ZOOM_KEY = "tabsync.offline.zoom";
const SPEED_KEY = "tabsync.offline.speed";
export const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export class OfflineView {
  /** The page shown in the viewer, if any. */
  current: SavedPage | null = null;
  private urls: string[] = [];
  private zoom = 1;
  /** Auto-scroll speed, CSS px per second. */
  private speed = 30;
  private scrolling = false;
  private frame = 0;
  private lastTime = 0;
  private carry = 0;

  constructor(private deps: OfflineViewDeps) {
    const read = (k: string) => {
      try {
        return Number(deps.storage?.getItem(k));
      } catch {
        return NaN;
      }
    };
    const z = read(ZOOM_KEY);
    if (ZOOM_STEPS.includes(z)) this.zoom = z;
    const s = read(SPEED_KEY);
    if (s >= 5 && s <= 200) this.speed = s;
  }

  private remember(k: string, v: number): void {
    try {
      this.deps.storage?.setItem(k, String(v));
    } catch {
      /* kept for this session */
    }
  }

  /** Lets go of the viewer: stops auto-scroll and frees the images. */
  leave(): void {
    this.stopScroll();
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
    this.current = null;
  }

  // ---- List --------------------------------------------------------------------------
  async showList(message?: { text: string; tone: "info" | "warn" }): Promise<void> {
    this.leave();
    const inner = document.createElement("div");
    inner.className = "page-inner offline";
    inner.innerHTML = `
      <div class="page-head"><h1>Offline</h1>${navigator.onLine ? "" : `<span class="offline-badge">${icon("cloudOff", 13)}You're offline</span>`}</div>
      ${message ? `<div class="notice${message.tone === "warn" ? " warn" : ""}">${esc(message.text)}</div>` : ""}
      <p class="muted offline-intro">Songsterr pages you saved with ${icon("download", 13)} <b>Save for offline</b> in the toolbar. They open without a connection, as you saw them when you saved them.</p>`;
    const list = document.createElement("ul");
    list.className = "rows";
    inner.appendChild(list);
    let pages: SavedPage[] = [];
    try {
      pages = await (await this.deps.store()).pages();
    } catch (e) {
      list.innerHTML = `<li class="empty-row">Couldn't read the saved pages: ${esc(String(e))}</li>`;
    }
    if (!pages.length && !list.childElementCount) {
      list.innerHTML = `<li class="empty-row">No pages saved yet. Open a tab on Songsterr and press <b>Save for offline</b> before you travel.</li>`;
    }
    for (const p of pages) list.appendChild(this.row(p));

    const { tabs, songs } = this.deps.elsewhere();
    const also = document.createElement("div");
    also.className = "offline-also";
    also.innerHTML = `<div class="list-title">Also available offline</div>`;
    const links = document.createElement("div");
    links.className = "offline-links";
    const link = (iconName: Parameters<typeof icon>[0], text: string, run: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn";
      b.innerHTML = `${icon(iconName, 14)}<span>${esc(text)}</span>`;
      b.onclick = run;
      links.appendChild(b);
      return b;
    };
    const tabsBtn = link("layers", "My tabs", () => this.deps.openMyTabs());
    link("disc", `Music · ${songs} ${songs === 1 ? "song" : "songs"}`, () => this.deps.openMusic());
    void tabs.then((n) => (tabsBtn.querySelector("span")!.textContent = `My tabs · ${n} ${n === 1 ? "song" : "songs"}`)).catch(() => {});
    also.appendChild(links);
    also.insertAdjacentHTML("beforeend", `<p class="hint">Imported tabs keep every practice tool offline: playback, speed, loop, transpose and following the song.</p>`);
    inner.appendChild(also);
    this.deps.root.replaceChildren(inner);
  }

  private row(p: SavedPage): HTMLElement {
    const li = document.createElement("li");
    li.className = "row-wrap";
    const size = p.parts.reduce((n, x) => n + x.size, 0);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "row";
    open.innerHTML = `${icon("guitar", 16)}<span class="row-main"><span class="row-title">${esc(p.title)}</span><span class="row-sub">${esc([p.artist, `saved ${when(p.savedAt)}`].filter(Boolean).join(" · "))}</span></span><span class="row-meta">${formatSize(size)}</span>`;
    open.onclick = () => void this.showPage(p.id);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn small offline-delete";
    del.innerHTML = `${icon("trash", 13)}<span>Delete</span>`;
    del.setAttribute("aria-label", `Delete the saved page of ${p.title}`);
    let armed = false;
    del.onclick = async () => {
      if (!armed) {
        armed = true;
        del.classList.add("danger");
        del.querySelector("span")!.textContent = "Confirm delete";
        setTimeout(() => {
          armed = false;
          del.classList.remove("danger");
          del.querySelector("span")!.textContent = "Delete";
        }, 4000);
        return;
      }
      del.disabled = true;
      try {
        await (await this.deps.store()).remove(p.id);
        this.deps.changed?.();
        await this.showList({ text: `Deleted the saved page of “${p.title}”.`, tone: "info" });
      } catch (e) {
        del.disabled = false;
        await this.showList({ text: `Couldn't delete it: ${String(e)}`, tone: "warn" });
      }
    };
    li.append(open, del);
    return li;
  }

  // ---- Viewer ------------------------------------------------------------------------
  async showPage(id: number): Promise<void> {
    this.leave();
    const store = await this.deps.store();
    const page = await store.page(id);
    if (!page) return this.showList({ text: "That saved page is gone.", tone: "warn" });
    let blobs: Blob[];
    try {
      blobs = await store.parts(page);
    } catch (e) {
      return this.showList({ text: `Couldn't open “${page.title}”: ${String(e)}`, tone: "warn" });
    }
    this.current = page;
    const wrap = document.createElement("div");
    wrap.className = "offline-viewer";
    wrap.innerHTML = `
      <div class="offline-bar">
        <button class="icon-btn small" type="button" data-act="back" title="All saved pages" aria-label="All saved pages">${icon("collapse", 16)}</button>
        <div class="offline-title"><b>${esc(page.title)}</b><span class="muted">${esc(page.artist)} · saved ${esc(when(page.savedAt))}</span></div>
        <div class="offline-tools">
          <div class="speed-chip" role="group" aria-label="Zoom">
            <button type="button" data-act="zoom-out" aria-label="Zoom out">−</button>
            <button type="button" data-act="zoom-reset" title="Back to 100%" aria-label="Zoom, reset to 100%">${Math.round(this.zoom * 100)}%</button>
            <button type="button" data-act="zoom-in" aria-label="Zoom in">+</button>
          </div>
          <button class="btn small" type="button" data-act="scroll" aria-pressed="false">${icon("play", 12)}<span>Auto-scroll</span></button>
          <label class="offline-speed" title="Auto-scroll speed"><input type="range" min="5" max="200" step="5" value="${this.speed}" aria-label="Auto-scroll speed" /></label>
          <button class="btn small" type="button" data-act="online" ${navigator.onLine ? "" : "disabled"} title="${navigator.onLine ? "Open the live page" : "Needs a connection"}">${icon("external", 13)}<span>Live page</span></button>
        </div>
      </div>
      <div class="offline-sheet"></div>`;
    const sheet = wrap.querySelector<HTMLElement>(".offline-sheet")!;
    for (const [i, blob] of blobs.entries()) {
      const url = URL.createObjectURL(blob);
      this.urls.push(url);
      if (blob.type === "application/pdf") {
        const frame = document.createElement("iframe");
        frame.className = "offline-pdf";
        frame.title = `${page.title} (saved page)`;
        frame.src = url;
        sheet.appendChild(frame);
      } else {
        const img = new Image();
        img.alt = i === 0 ? `${page.title}, saved page` : "";
        img.decoding = "async";
        img.src = url;
        sheet.appendChild(img);
      }
    }
    this.applyZoom(sheet);
    const act = (name: string) => wrap.querySelector<HTMLButtonElement>(`[data-act="${name}"]`)!;
    act("back").onclick = () => void this.showList();
    const zoomTo = (z: number) => {
      this.zoom = z;
      this.remember(ZOOM_KEY, z);
      act("zoom-reset").textContent = `${Math.round(z * 100)}%`;
      this.applyZoom(sheet);
    };
    const step = (dir: number) => {
      const i = ZOOM_STEPS.indexOf(this.zoom);
      zoomTo(ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + dir))]);
    };
    act("zoom-out").onclick = () => step(-1);
    act("zoom-in").onclick = () => step(1);
    act("zoom-reset").onclick = () => zoomTo(1);
    const scrollBtn = act("scroll");
    scrollBtn.onclick = () => {
      if (this.scrolling) this.stopScroll();
      else this.startScroll();
      scrollBtn.setAttribute("aria-pressed", String(this.scrolling));
      scrollBtn.innerHTML = `${icon(this.scrolling ? "pause" : "play", 12)}<span>Auto-scroll</span>`;
    };
    const speed = wrap.querySelector<HTMLInputElement>(".offline-speed input")!;
    speed.oninput = () => {
      this.speed = Number(speed.value);
      this.remember(SPEED_KEY, this.speed);
    };
    act("online").onclick = () => this.deps.openOnline(page);
    this.deps.root.replaceChildren(wrap);
    this.deps.root.scrollTop = 0;
  }

  private applyZoom(sheet: HTMLElement): void {
    sheet.style.setProperty("--zoom", String(this.zoom));
  }

  private startScroll(): void {
    this.scrolling = true;
    this.lastTime = performance.now();
    this.carry = 0;
    const tick = (t: number) => {
      if (!this.scrolling) return;
      const root = this.deps.root;
      this.carry += ((t - this.lastTime) / 1000) * this.speed;
      this.lastTime = t;
      // Whole pixels only: fractional scrollTop is rounded away by some webviews.
      const px = Math.floor(this.carry);
      if (px > 0) {
        this.carry -= px;
        root.scrollTop += px;
      }
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 1) {
        this.stopScroll();
        const b = root.querySelector<HTMLButtonElement>('[data-act="scroll"]');
        if (b) {
          b.setAttribute("aria-pressed", "false");
          b.innerHTML = `${icon("play", 12)}<span>Auto-scroll</span>`;
        }
        return;
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private stopScroll(): void {
    this.scrolling = false;
    cancelAnimationFrame(this.frame);
  }
}
