import { escapeHtml as esc } from "./html";
import { icon } from "./icons";
import type { QueueContext } from "./localplayer";
import type { LocalTrack, Playlist } from "./music";
import { dropIndex, filterTracks, formatTime, listSummary, parseSortKey, SORT_LABELS, sortTracks, type SortKey } from "./musicui";

/**
 * The Music pages: the library (import, search, sort, edit, remove, add to a
 * playlist) and a playlist (play, rename, delete, reorder by dragging). They render
 * into the stage's page layer; main.ts owns the data and the player.
 */

export type MusicPage = { kind: "library" } | { kind: "playlist"; id: number };

export interface MusicViewDeps {
  root: HTMLElement;
  tracks(): readonly LocalTrack[];
  playlists(): readonly Playlist[];
  /** The cover's URL if loaded; otherwise starts loading it and calls refreshArt() later. */
  artUrl(track: LocalTrack): string | null;
  playingId(): number | null;
  isPlaying(): boolean;
  /** Desktop opens the system picker (pickFiles); elsewhere a file input hands over Files. */
  picker: "dialog" | "input";
  pickFiles(): void;
  importFiles(files: File[]): void;
  play(ids: number[], start: number, context: QueueContext, opts?: { shuffle?: boolean }): void;
  togglePlay(): void;
  updateTrack(id: number, patch: Pick<LocalTrack, "title" | "artist" | "album">): Promise<void>;
  removeTrack(id: number): Promise<void>;
  /** Adds tracks to a playlist, or to a new one (null). */
  addToPlaylist(playlistId: number | null, trackIds: number[]): Promise<void>;
  renamePlaylist(id: number, name: string): Promise<void>;
  deletePlaylist(id: number): Promise<void>;
  removeFromPlaylist(id: number, trackId: number): Promise<void>;
  reorderPlaylist(id: number, from: number, to: number): Promise<void>;
  storage?: Pick<Storage, "getItem" | "setItem">;
}

export interface MusicMessage {
  text: string;
  tone: "info" | "warn";
}

const SORT_KEY = "tabsync.music.sort";

const subtitle = (t: LocalTrack) => [t.artist || "Unknown artist", t.album].filter(Boolean).join(" · ");

export class MusicView {
  page: MusicPage = { kind: "library" };
  private query = "";
  private sort: SortKey;
  private message: MusicMessage | null = null;
  private importing: { done: number; total: number } | null = null;
  private editing: number | null = null;
  private renaming = false;
  private menuFor: number | null = null;
  private dropping = false;
  private artObserver: IntersectionObserver | null = null;
  private closesMenus = false;
  /** The library's tracks by id, as of the last render (covers look their track up here). */
  private byId = new Map<number, LocalTrack>();
  private artFrame = 0;

  constructor(private deps: MusicViewDeps) {
    let stored: string | null = null;
    try {
      stored = deps.storage?.getItem(SORT_KEY) ?? null;
    } catch {
      /* no storage */
    }
    this.sort = parseSortKey(stored);
  }

  show(page: MusicPage, opts: { rename?: boolean } = {}): void {
    const changed = page.kind !== this.page.kind || (page.kind === "playlist" && this.page.kind === "playlist" && page.id !== this.page.id);
    this.page = page;
    if (changed) {
      this.editing = null;
      this.menuFor = null;
      if (page.kind === "library") this.message = this.importing ? this.message : null;
    }
    this.renaming = !!opts.rename;
    this.render();
  }

  setMessage(m: MusicMessage | null): void {
    this.message = m;
    this.render();
  }

  setImporting(p: { done: number; total: number } | null): void {
    this.importing = p;
    const bar = this.deps.root.querySelector<HTMLElement>(".music-progress");
    if (p && bar) {
      bar.querySelector("span")!.textContent = `Importing ${Math.min(p.done + 1, p.total)} of ${p.total}…`;
      bar.querySelector<HTMLElement>(".music-progress-fill")!.style.width = `${(p.done / Math.max(1, p.total)) * 100}%`;
    } else this.render();
  }

  /** Files are dragged over the window: show where they will go. */
  setDropping(on: boolean): void {
    if (on === this.dropping) return;
    this.dropping = on;
    this.deps.root.querySelector(".music-drop")?.classList.toggle("active", on);
  }

  /** The playing track or its state changed: only the row highlights change. */
  refreshPlaying(): void {
    const id = this.deps.playingId();
    const playing = this.deps.isPlaying();
    this.deps.root.querySelectorAll<HTMLElement>(".track-row").forEach((row) => {
      const on = Number(row.dataset.id) === id;
      row.classList.toggle("playing", on);
      row.classList.toggle("paused", on && !playing);
      const b = row.querySelector<HTMLButtonElement>(".track-art");
      if (b) b.setAttribute("aria-label", on && playing ? "Pause" : "Play");
    });
  }

  /**
   * A cover finished loading: fill the thumbnails that wait for it. Only those that
   * have been in view: the others load their cover when they scroll into view.
   */
  refreshArt(): void {
    // Covers arriving together are shown in one pass.
    if (this.artFrame) return;
    this.artFrame = requestAnimationFrame(() => {
      this.artFrame = 0;
      this.deps.root.querySelectorAll<HTMLElement>(".track-art[data-art][data-seen]").forEach((el) => this.fillArt(el));
    });
  }

  /** Shows a thumbnail's cover; asking for it starts loading it if needed. */
  private fillArt(el: HTMLElement): void {
    el.dataset.seen = "";
    const t = this.byId.get(Number(el.dataset.track));
    const url = t ? this.deps.artUrl(t) : null;
    if (!url) return;
    el.removeAttribute("data-art");
    const img = el.querySelector("img") ?? el.insertBefore(Object.assign(new Image(), { alt: "", decoding: "async" }), el.firstChild);
    img.onerror = () => img.remove(); // an image the webview can't decode: keep the note icon
    img.src = url;
  }

  render(): void {
    this.artObserver?.disconnect();
    this.artObserver = null;
    this.byId = new Map(this.deps.tracks().map((t) => [t.id, t]));
    if (this.page.kind === "playlist") {
      const id = this.page.id;
      const p = this.deps.playlists().find((x) => x.id === id);
      if (p) return this.renderPlaylist(p);
      this.page = { kind: "library" };
    }
    this.renderLibrary();
  }

  // ---- Library -----------------------------------------------------------------------
  private visible(): LocalTrack[] {
    return sortTracks(filterTracks(this.deps.tracks(), this.query), this.sort);
  }

  private renderLibrary(): void {
    const all = this.deps.tracks();
    const shown = this.visible();
    const inner = document.createElement("div");
    inner.className = "page-inner music";
    inner.innerHTML = `
      <div class="page-head"><h1>Music</h1><span class="muted music-count">${esc(listSummary(all))}</span></div>
      ${this.statusHtml()}
      ${
        all.length
          ? `<div class="music-tools">
              <label class="music-search"><span class="sr-only">Search your music</span>${icon("search", 14)}<input type="search" placeholder="Search title, artist, album" value="${esc(this.query)}" /></label>
              <label class="select-row music-sort">Sort<select aria-label="Sort by">${Object.entries(SORT_LABELS).map(([k, l]) => `<option value="${k}"${k === this.sort ? " selected" : ""}>${l}</option>`).join("")}</select></label>
              <button class="btn" type="button" data-act="play-all"${shown.length ? "" : " disabled"}>${icon("play", 13)}Play</button>
              <button class="btn" type="button" data-act="shuffle-all"${shown.length ? "" : " disabled"}>${icon("shuffle", 14)}Shuffle</button>
            </div>`
          : ""
      }
      <div class="music-drop${this.dropping ? " active" : ""}">${icon("upload", 16)}<span>Drop MP3 files here to add them</span></div>`;
    const head = inner.querySelector(".page-head")!;
    head.appendChild(this.importButton());

    if (!all.length) inner.appendChild(this.emptyCard("disc", "Your music library is empty", "Import MP3 files to play them here at any speed, loop the hard parts and follow their tabs. The files stay where they are; Guitarfish only remembers them.", true));
    else if (!shown.length) inner.insertAdjacentHTML("beforeend", `<ul class="rows"><li class="empty-row">No songs match “${esc(this.query)}”.</li></ul>`);
    else inner.appendChild(this.trackList(shown, { kind: "library" }));

    const search = inner.querySelector<HTMLInputElement>(".music-search input");
    if (search) {
      search.oninput = () => {
        this.query = search.value;
        const list = this.deps.root.querySelector(".track-list, .music .rows:not(.track-list)");
        const fresh = this.visible();
        const replacement = fresh.length ? this.trackList(fresh, { kind: "library" }) : Object.assign(document.createElement("ul"), { className: "rows", innerHTML: `<li class="empty-row">No songs match “${esc(this.query)}”.</li>` });
        list?.replaceWith(replacement);
        this.observeArt();
      };
    }
    const sort = inner.querySelector<HTMLSelectElement>(".music-sort select");
    if (sort)
      sort.onchange = () => {
        this.sort = parseSortKey(sort.value);
        try {
          this.deps.storage?.setItem(SORT_KEY, this.sort);
        } catch {
          /* kept for this session */
        }
        this.render();
      };
    inner.querySelector<HTMLButtonElement>('[data-act="play-all"]')?.addEventListener("click", () => this.deps.play(this.visible().map((t) => t.id), 0, { kind: "library" }));
    inner.querySelector<HTMLButtonElement>('[data-act="shuffle-all"]')?.addEventListener("click", () => {
      const ids = this.visible().map((t) => t.id);
      this.deps.play(ids, Math.floor(Math.random() * ids.length), { kind: "library" }, { shuffle: true });
    });
    this.bindStatus(inner);
    this.mount(inner);
  }

  private importButton(): HTMLElement {
    const wrap = document.createElement("span");
    const b = document.createElement("button");
    b.className = "btn primary";
    b.type = "button";
    b.innerHTML = `${icon("upload", 14)}Import MP3s…`;
    b.disabled = !!this.importing;
    if (this.deps.picker === "dialog") b.onclick = () => this.deps.pickFiles();
    else {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = ".mp3,audio/mpeg";
      input.hidden = true;
      input.dataset.import = "";
      input.onchange = () => {
        const files = [...(input.files ?? [])];
        input.value = "";
        if (files.length) this.deps.importFiles(files);
      };
      b.onclick = () => input.click();
      wrap.appendChild(input);
    }
    wrap.appendChild(b);
    return wrap;
  }

  private statusHtml(): string {
    if (this.importing)
      return `<div class="music-progress notice" role="status"><span>Importing ${Math.min(this.importing.done + 1, this.importing.total)} of ${this.importing.total}…</span><div class="music-progress-bar"><div class="music-progress-fill" style="width:${(this.importing.done / Math.max(1, this.importing.total)) * 100}%"></div></div></div>`;
    if (this.message) return `<div class="notice music-message${this.message.tone === "warn" ? " warn" : ""}" role="status"><span>${esc(this.message.text)}</span><button class="icon-btn tiny" type="button" data-act="dismiss" aria-label="Dismiss">${icon("close", 12)}</button></div>`;
    return "";
  }

  private bindStatus(root: HTMLElement): void {
    root.querySelector<HTMLButtonElement>('[data-act="dismiss"]')?.addEventListener("click", () => this.setMessage(null));
  }

  private emptyCard(iconName: Parameters<typeof icon>[0], title: string, text: string, withImport: boolean): HTMLElement {
    const card = document.createElement("div");
    card.className = "empty-card music-empty";
    card.innerHTML = `<div class="empty-icon">${icon(iconName, 26)}</div><h2>${esc(title)}</h2><p>${esc(text)}</p>`;
    if (withImport) card.appendChild(this.importButton());
    return card;
  }

  private mount(inner: HTMLElement): void {
    this.deps.root.replaceChildren(inner);
    this.observeArt();
    this.refreshPlaying();
  }

  /** Thumbnails load as they scroll into view. */
  private observeArt(): void {
    const thumbs = [...this.deps.root.querySelectorAll<HTMLElement>(".track-art[data-art]:not([data-seen])")];
    if (!thumbs.length) return;
    if (typeof IntersectionObserver === "undefined") {
      thumbs.forEach((el) => this.fillArt(el));
      return;
    }
    this.artObserver ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          this.artObserver?.unobserve(e.target);
          this.fillArt(e.target as HTMLElement);
        }
      },
      { root: this.deps.root, rootMargin: "200px" },
    );
    thumbs.forEach((el) => this.artObserver!.observe(el));
  }

  /** Song rows; in a playlist they can be dragged into a new order. */
  private trackList(tracks: LocalTrack[], context: QueueContext): HTMLElement {
    const list = document.createElement("ul");
    list.className = "rows track-list";
    const ids = tracks.map((t) => t.id);
    tracks.forEach((t, i) => list.appendChild(this.trackRow(t, i, ids, context)));
    if (context.kind === "playlist") this.enableReorder(list, context.id);
    return list;
  }

  private trackRow(t: LocalTrack, index: number, ids: number[], context: QueueContext): HTMLElement {
    const li = document.createElement("li");
    li.className = "track-row";
    li.dataset.id = String(t.id);
    li.dataset.index = String(index);
    const inPlaylist = context.kind === "playlist";
    li.innerHTML = `
      ${inPlaylist ? `<button class="track-grip" type="button" title="Drag to reorder (or Alt+↑/↓)" aria-label="Move ${esc(t.title)}">${icon("grip", 14)}</button>` : ""}
      <button class="track-art" type="button" data-art data-track="${t.id}" aria-label="Play">${icon("music", 16)}<span class="track-art-play">${icon("play", 14)}</span><span class="track-art-bars">${icon("bars", 14)}</span></button>
      <div class="row-main"><span class="row-title">${esc(t.title)}</span><span class="row-sub">${esc(subtitle(t))}</span></div>
      <span class="row-meta">${formatTime(t.durationMs)}</span>
      <div class="track-actions">
        <button class="icon-btn small" type="button" data-act="add" title="Add to playlist" aria-label="Add ${esc(t.title)} to a playlist" aria-haspopup="menu">${icon("plus", 15)}</button>
        ${inPlaylist ? "" : `<button class="icon-btn small" type="button" data-act="edit" title="Edit title and artist" aria-label="Edit ${esc(t.title)}">${icon("edit", 15)}</button>`}
        <button class="icon-btn small" type="button" data-act="remove" title="${inPlaylist ? "Remove from playlist" : "Remove from library"}" aria-label="${inPlaylist ? "Remove from playlist" : "Remove from library"}: ${esc(t.title)}">${icon(inPlaylist ? "close" : "trash", 15)}</button>
      </div>`;
    const play = () => {
      if (this.deps.playingId() === t.id) this.deps.togglePlay();
      else this.deps.play(ids, index, context);
    };
    li.querySelector<HTMLButtonElement>(".track-art")!.onclick = play;
    li.ondblclick = (e) => {
      if (!(e.target as HTMLElement).closest("button, input, form")) play();
    };
    li.querySelector<HTMLButtonElement>('[data-act="add"]')!.onclick = (e) => {
      e.stopPropagation();
      this.menuFor = this.menuFor === t.id ? null : t.id;
      this.renderMenus();
    };
    li.querySelector<HTMLButtonElement>('[data-act="edit"]')?.addEventListener("click", () => {
      this.editing = this.editing === t.id ? null : t.id;
      this.render();
    });
    const remove = li.querySelector<HTMLButtonElement>('[data-act="remove"]')!;
    if (inPlaylist) remove.onclick = () => void this.deps.removeFromPlaylist(context.id, t.id);
    else this.twoStep(remove, "Remove", () => this.deps.removeTrack(t.id));
    if (this.editing === t.id && !inPlaylist) li.appendChild(this.editForm(t));
    if (this.menuFor === t.id) li.appendChild(this.playlistMenu(t));
    return li;
  }

  /** A destructive button that needs a second click within 4 s. */
  private twoStep(b: HTMLButtonElement, what: string, run: () => Promise<void>): void {
    let armed = false;
    let timer = 0;
    const original = b.innerHTML;
    b.onclick = async () => {
      if (!armed) {
        armed = true;
        b.classList.add("armed");
        b.innerHTML = `<span>${what}?</span>`;
        timer = window.setTimeout(() => {
          armed = false;
          b.classList.remove("armed");
          b.innerHTML = original;
        }, 4000);
        return;
      }
      clearTimeout(timer);
      b.disabled = true;
      await run();
    };
  }

  private editForm(t: LocalTrack): HTMLElement {
    const form = document.createElement("form");
    form.className = "track-edit";
    form.innerHTML = `
      <label class="field">Title<input name="title" type="text" autocomplete="off" value="${esc(t.title)}" /></label>
      <label class="field">Artist<input name="artist" type="text" autocomplete="off" value="${esc(t.artist)}" /></label>
      <label class="field">Album<input name="album" type="text" autocomplete="off" value="${esc(t.album)}" /></label>
      <p class="hint">Guitarfish finds tabs by title and artist. Only the library changes, never the file.</p>
      <div class="form-actions"><button class="btn primary small" type="submit">Save</button><button class="btn small" type="button" data-cancel>Cancel</button></div>`;
    const field = (n: string) => form.querySelector<HTMLInputElement>(`[name="${n}"]`)!;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const title = field("title").value.trim();
      if (!title) {
        field("title").focus();
        return;
      }
      this.editing = null;
      await this.deps.updateTrack(t.id, { title, artist: field("artist").value.trim(), album: field("album").value.trim() });
    };
    form.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = () => {
      this.editing = null;
      this.render();
    };
    form.onkeydown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.editing = null;
        this.render();
      }
    };
    queueMicrotask(() => field("title").focus());
    return form;
  }

  /** The "Add to playlist" menu under a row. */
  private playlistMenu(t: LocalTrack): HTMLElement {
    const menu = document.createElement("div");
    menu.className = "track-menu";
    menu.setAttribute("role", "menu");
    const lists = this.deps.playlists();
    const here = this.page.kind === "playlist" ? this.page.id : null;
    menu.innerHTML = `<div class="track-menu-title">Add to playlist</div>`;
    const item = (label: string, run: () => void, disabled = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.textContent = label;
      b.disabled = disabled;
      b.onclick = () => {
        this.menuFor = null;
        run();
      };
      menu.appendChild(b);
      return b;
    };
    for (const p of lists) item(p.trackIds.includes(t.id) ? `${p.name} ✓` : p.name, () => void this.deps.addToPlaylist(p.id, [t.id]), p.id === here || p.trackIds.includes(t.id));
    item("New playlist…", () => void this.deps.addToPlaylist(null, [t.id])).classList.add("track-menu-new");
    menu.onkeydown = (e) => {
      if (e.key === "Escape") {
        this.menuFor = null;
        this.renderMenus();
      }
    };
    queueMicrotask(() => menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
    return menu;
  }

  private renderMenus(): void {
    this.deps.root.querySelectorAll(".track-menu").forEach((m) => m.remove());
    if (this.menuFor == null) return;
    const row = this.deps.root.querySelector<HTMLElement>(`.track-row[data-id="${this.menuFor}"]`);
    const t = this.deps.tracks().find((x) => x.id === this.menuFor);
    if (!row || !t) return;
    row.appendChild(this.playlistMenu(t));
    if (this.closesMenus) return;
    // One listener for the page's lifetime: a click outside the open menu closes it.
    this.closesMenus = true;
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (this.menuFor != null && !(e.target as HTMLElement).closest(".track-menu, [data-act='add']")) {
          this.menuFor = null;
          this.renderMenus();
        }
      },
      true,
    );
  }

  // ---- Playlist ----------------------------------------------------------------------
  private renderPlaylist(p: Playlist): void {
    const byId = new Map(this.deps.tracks().map((t) => [t.id, t]));
    const tracks = p.trackIds.map((id) => byId.get(id)).filter((t): t is LocalTrack => !!t);
    const inner = document.createElement("div");
    inner.className = "page-inner music";
    inner.innerHTML = `
      <div class="page-head playlist-head">
        <span class="playlist-mark">${icon("playlist", 20)}</span>
        ${
          this.renaming
            ? `<form class="playlist-rename"><input type="text" aria-label="Playlist name" maxlength="80" value="${esc(p.name)}" /><button class="btn primary small" type="submit">Save</button></form>`
            : `<h1>${esc(p.name)}</h1>`
        }
        <span class="muted music-count">${esc(listSummary(tracks))}</span>
      </div>
      ${this.statusHtml()}
      <div class="music-tools">
        <button class="btn primary" type="button" data-act="play"${tracks.length ? "" : " disabled"}>${icon("play", 13)}Play</button>
        <button class="btn" type="button" data-act="shuffle"${tracks.length ? "" : " disabled"}>${icon("shuffle", 14)}Shuffle</button>
        <span class="music-tools-gap"></span>
        <button class="btn" type="button" data-act="rename">${icon("edit", 14)}Rename</button>
        <button class="btn" type="button" data-act="delete">${icon("trash", 14)}<span>Delete playlist</span></button>
      </div>`;
    if (!tracks.length) inner.appendChild(this.emptyCard("playlist", "This playlist is empty", "Add songs from Music with the + button on each song. Drag them here into the order you practise them.", false));
    else inner.appendChild(this.trackList(tracks, { kind: "playlist", id: p.id }));
    const ids = tracks.map((t) => t.id);
    inner.querySelector<HTMLButtonElement>('[data-act="play"]')!.onclick = () => this.deps.play(ids, 0, { kind: "playlist", id: p.id });
    inner.querySelector<HTMLButtonElement>('[data-act="shuffle"]')!.onclick = () => this.deps.play(ids, Math.floor(Math.random() * ids.length), { kind: "playlist", id: p.id }, { shuffle: true });
    inner.querySelector<HTMLButtonElement>('[data-act="rename"]')!.onclick = () => this.show(this.page, { rename: true });
    const del = inner.querySelector<HTMLButtonElement>('[data-act="delete"]')!;
    let armed = false;
    del.onclick = async () => {
      if (!armed) {
        armed = true;
        del.classList.add("danger");
        del.querySelector("span")!.textContent = "Confirm delete";
        setTimeout(() => {
          armed = false;
          del.classList.remove("danger");
          del.querySelector("span")!.textContent = "Delete playlist";
        }, 4000);
        return;
      }
      del.disabled = true;
      await this.deps.deletePlaylist(p.id);
    };
    const form = inner.querySelector<HTMLFormElement>(".playlist-rename");
    if (form) {
      const input = form.querySelector("input")!;
      form.onsubmit = async (e) => {
        e.preventDefault();
        this.renaming = false;
        if (input.value.trim() && input.value.trim() !== p.name) await this.deps.renamePlaylist(p.id, input.value);
        else this.render();
      };
      input.onkeydown = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          this.renaming = false;
          this.render();
        }
      };
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
    }
    this.bindStatus(inner);
    this.mount(inner);
  }

  /**
   * Drag the grip to reorder (pointer events, so it works with a mouse, a pen or a
   * finger, and inside Tauri, where HTML5 drag and drop is taken by file drops), or
   * Alt+↑/↓ on the grip.
   */
  private enableReorder(list: HTMLElement, playlistId: number): void {
    list.addEventListener("keydown", (e) => {
      const grip = (e.target as HTMLElement).closest(".track-grip");
      if (!grip || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      const from = Number(grip.closest<HTMLElement>(".track-row")!.dataset.index);
      const to = e.key === "ArrowUp" ? from - 1 : from + 1;
      if (to < 0 || to >= list.children.length) return;
      const id = list.children[from].getAttribute("data-id");
      void this.deps.reorderPlaylist(playlistId, from, to).then(() => this.deps.root.querySelector<HTMLElement>(`.track-row[data-id="${id}"] .track-grip`)?.focus());
    });

    list.addEventListener("pointerdown", (e) => {
      const grip = (e.target as HTMLElement).closest<HTMLElement>(".track-grip");
      if (!grip || e.button !== 0) return;
      e.preventDefault();
      const row = grip.closest<HTMLElement>(".track-row")!;
      const rows = [...list.querySelectorAll<HTMLElement>(":scope > .track-row")];
      const from = rows.indexOf(row);
      const rects = rows.map((r) => r.getBoundingClientRect());
      const mids = rects.map((r) => r.top + r.height / 2);
      const height = rects[from].height;
      const startY = e.clientY;
      let to = from;
      grip.setPointerCapture(e.pointerId);
      list.classList.add("reordering");
      row.classList.add("dragging");
      const onMove = (ev: PointerEvent) => {
        const dy = ev.clientY - startY;
        row.style.transform = `translateY(${dy}px)`;
        to = dropIndex(mids, from, mids[from] + dy);
        rows.forEach((r, i) => {
          if (i === from) return;
          const shift = from < to && i > from && i <= to ? -height : from > to && i < from && i >= to ? height : 0;
          r.style.transform = shift ? `translateY(${shift}px)` : "";
        });
      };
      const onUp = () => {
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
        list.classList.remove("reordering");
        row.classList.remove("dragging");
        rows.forEach((r) => (r.style.transform = ""));
        if (to !== from) void this.deps.reorderPlaylist(playlistId, from, to);
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
    });
  }
}
