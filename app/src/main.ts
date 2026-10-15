import { getVersion } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { clearCachedLookup, TabApi } from "./api";
import { Detector } from "./detector";
import { EmbeddedPage } from "./embed";
import { hydrateIcons, icon } from "./icons";
import {
  applyLayoutCommand,
  BREAKPOINTS,
  effectiveLayout,
  loadLayout,
  saveLayout,
  type LayoutCommand,
  type LayoutState,
} from "./layout";
import { EntryStore, isSongPage, PickStore, toEntry, toResult, type TabEntry } from "./library";
import { LibrarySync, syncHint } from "./librarysync";
import { isConfidentMatch, songsterrQuery, songsterrSearchPage } from "./match";
import { loadSettings, saveSettings } from "./settings";
import { syncStatus, type SyncStatus } from "./status";
import "./styles.css";
import { pollIntervalFor, SyncController } from "./sync";
import type { PlaybackCapabilities, Song, SongsterrResult, TabInfo, Track } from "./types";
import { checkForUpdate, type UpdateInfo } from "./update";
import { TabViewer } from "./viewer";

/** How often a running app looks for a new release (also checked at startup). */
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
/** A little longer than the CSS panel transitions (--t). */
const LAYOUT_ANIM_MS = 260;

hydrateIcons();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  app: $("app"),
  center: document.querySelector<HTMLElement>(".center")!,
  // player
  player: $("player"),
  art: $("np-art"),
  title: $("np-title"),
  artist: $("np-artist"),
  pos: $("np-pos"),
  dur: $("np-dur"),
  progress: $("np-progress"),
  progressFill: $("np-progress-fill"),
  transport: $("transport-buttons"),
  prev: $<HTMLButtonElement>("btn-prev"),
  play: $<HTMLButtonElement>("btn-play"),
  next: $<HTMLButtonElement>("btn-next"),
  volume: $("volume"),
  volumeRange: $<HTMLInputElement>("volume-range"),
  mute: $<HTMLButtonElement>("btn-mute"),
  statusPill: $("status-pill"),
  playerCollapse: $<HTMLButtonElement>("btn-player-collapse"),
  playerExpand: $<HTMLButtonElement>("btn-player-expand"),
  playerShow: $<HTMLButtonElement>("btn-player-show"),
  stripDot: $("strip-dot"),
  stripTitle: $("strip-title"),
  stripArtist: $("strip-artist"),
  stripStatus: $("strip-status"),
  titlebarText: $("titlebar-text"),
  exitFocus: $<HTMLButtonElement>("btn-exit-focus"),
  // nav
  nav: $("nav"),
  navItems: [...document.querySelectorAll<HTMLButtonElement>(".nav-item")],
  recent: $("recent"),
  navCompact: $<HTMLButtonElement>("btn-nav-compact"),
  navHide: $<HTMLButtonElement>("btn-nav-hide"),
  // toolbar
  toolbar: $("toolbar"),
  tbTitle: $("tb-title"),
  sourceSwitch: $("source-switch"),
  tbSearch: $<HTMLFormElement>("tb-search"),
  tbSearchInput: $<HTMLInputElement>("tb-search-input"),
  fav: $<HTMLButtonElement>("btn-fav"),
  refresh: $<HTMLButtonElement>("btn-refresh"),
  external: $<HTMLButtonElement>("btn-external"),
  toggleNav: $<HTMLButtonElement>("btn-toggle-nav"),
  toggleTools: $<HTMLButtonElement>("btn-toggle-tools"),
  focus: $<HTMLButtonElement>("btn-focus"),
  toolbarHide: $<HTMLButtonElement>("btn-toolbar-hide"),
  toolbarShow: $<HTMLButtonElement>("btn-toolbar-show"),
  banner: $("banner"),
  // stage
  embedArea: $("embed-area"),
  empty: $("stage-empty"),
  local: $("local"),
  panel: $("panel"),
  tab: $("tab"),
  page: $("page"),
  // tools
  tools: $("tools"),
  toolsClose: $<HTMLButtonElement>("btn-tools-close"),
  toolsStatus: $("tools-status"),
  toolsStatusDetail: $("tools-status-detail"),
  toolsSource: $("tools-source"),
  setFollowSpotify: $<HTMLInputElement>("set-follow-spotify"),
  setAutoSearch: $<HTMLInputElement>("set-auto-search"),
  setFallback: $<HTMLInputElement>("set-fallback"),
  spotifyStatus: $("spotify-status"),
  spotifyBtn: $<HTMLButtonElement>("btn-spotify"),
  matchInfo: $("match-info"),
  searchAgain: $<HTMLButtonElement>("btn-search-again"),
  wrong: $<HTMLButtonElement>("btn-wrong"),
  openSongsterr: $<HTMLButtonElement>("btn-open-songsterr"),
  fav2: $<HTMLButtonElement>("btn-fav-2"),
  localCard: $("local-card"),
  tabSelect: $<HTMLSelectElement>("tab-select"),
  setFollow: $<HTMLInputElement>("set-follow"),
  setOffset: $<HTMLInputElement>("set-offset"),
  setOffsetOut: $<HTMLOutputElement>("set-offset-out"),
  setZoom: $<HTMLInputElement>("set-zoom"),
  setZoomOut: $<HTMLOutputElement>("set-zoom-out"),
  setTheme: $<HTMLSelectElement>("set-theme"),
  layPlayer: $<HTMLInputElement>("lay-player"),
  layPlayerExpanded: $<HTMLInputElement>("lay-player-expanded"),
  layNav: $<HTMLInputElement>("lay-nav"),
  layNavCompact: $<HTMLInputElement>("lay-nav-compact"),
  layToolbar: $<HTMLInputElement>("lay-toolbar"),
  layFocus: $<HTMLInputElement>("lay-focus"),
  setServer: $<HTMLInputElement>("set-server"),
  setLibrarySync: $<HTMLInputElement>("set-library-sync"),
  librarySyncHint: $("library-sync-hint"),
  testBtn: $<HTMLButtonElement>("btn-test"),
};

// ---- Platform ------------------------------------------------------------------
const isMac = /Mac/i.test(navigator.userAgent) && !/iPhone|iPad/i.test(navigator.userAgent);
const embed = EmbeddedPage.supported() ? new EmbeddedPage(el.embedArea) : null;
/** macOS desktop: overlay title bar, and a native Layout menu that owns the shortcuts. */
const nativeMac = isMac && embed !== null;
document.documentElement.classList.toggle("platform-mac", nativeMac);

// ---- Services ------------------------------------------------------------------
const settings = loadSettings();
saveSettings(settings); // persists the v2 migration
const api = new TabApi(settings.serverUrl);
api.setBaseUrl(settings.serverUrl);
const detector = new Detector(api, { fallbackEnabled: () => settings.spotifyFallback });
const viewer = new TabViewer(el.tab, el.local, settings.zoom);
const history = new EntryStore("tabsync.history");
const favorites = new EntryStore("tabsync.favorites");
const picks = new PickStore();
/** History and favorites synced with the tab server; the stores above are its offline cache. */
const library = new LibrarySync({
  api,
  history,
  favorites,
  enabled: () => settings.librarySync,
  onChange: () => renderLibrary(),
  onStatus: (s) => (el.librarySyncHint.textContent = syncHint(s)),
});
/** Detector polling and the tab lookup for each new track; the UI below renders it. */
const sync = new SyncController({
  detector,
  api,
  picks,
  settings,
  ui: {
    nowPlaying: () => renderNowPlaying(),
    trackChanged: () => {
      currentSong = null;
      localHow = "";
      viewer.hideHighlight();
      el.tabSelect.hidden = true;
      showPanel(null);
    },
    status: () => renderStatus(),
    openSongsterr: (r) => void openSongsterr(r, "auto"),
    serverUnreachable: (down) => {
      if (down) showBanner(`Can't reach the tab server at <code>${escapeHtml(settings.serverUrl)}</code>. Check it in the Tools sidebar. Retrying…`, "warn");
      else if (el.banner.textContent?.includes("Can't reach the tab server")) showBanner(null);
    },
    localMatch: (song, how) => openSong(song, how),
    localMiss: (track, candidates) => showLocalMiss(track, candidates),
    renderStage: () => renderStage(),
    renderAll: () => renderAll(),
  },
});

// ---- State ---------------------------------------------------------------------
type View = "tab" | "search" | "history" | "favorites";
type Source = "songsterr" | "local";

let layout: LayoutState = loadLayout();
/** The user expanded the nav although the window is narrow enough to compact it. */
let wideNav = false;
let view: View = "tab";
let shown: SongsterrResult | null = null; // the Songsterr page in the viewer
let currentSong: Song | null = null; // local catalogue match
let localHow = "";
let caps: PlaybackCapabilities = { transport: false, seek: false, volume: false, events: false };
let volumeHoldUntil = 0; // ignore polled volume while the user drags the slider
let lastVolume = 50;

// ---- Helpers -------------------------------------------------------------------
function fmt(ms?: number | null): string {
  if (ms == null || ms < 0) return "–:––";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function label(r: Pick<SongsterrResult, "title" | "artist">): string {
  return r.artist ? `${r.artist} – ${r.title}` : r.title;
}

function ago(at: number): string {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : new Date(at).toLocaleDateString();
}

function showBanner(html: string | null, kind: "info" | "warn" = "info") {
  el.banner.hidden = !html;
  el.banner.className = `banner ${kind}`;
  el.banner.innerHTML = html ? `<span>${html}</span><button class="banner-close icon-btn tiny" type="button" aria-label="Dismiss">${icon("close", 13)}</button>` : "";
  el.banner.querySelector("button")?.addEventListener("click", () => showBanner(null));
  embed?.track(LAYOUT_ANIM_MS);
}

async function openExternal(url: string) {
  if (isTauri()) await openUrl(url);
  else window.open(url, "_blank");
}

function setFill(input: HTMLInputElement) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  input.style.setProperty("--fill", `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

// ---- Layout --------------------------------------------------------------------
function renderLayout() {
  const width = window.innerWidth;
  const eff = effectiveLayout(layout, width);
  if (wideNav && layout.nav === "expanded") eff.nav = "expanded";
  el.player.dataset.state = eff.player;
  el.player.classList.toggle("focus", layout.focus);
  el.center.classList.toggle("focus", layout.focus);
  el.nav.dataset.state = eff.nav;
  el.tools.dataset.visible = String(eff.tools);
  el.toolbar.dataset.visible = String(eff.toolbar);
  el.app.classList.toggle("narrow", eff.narrow);

  el.toggleNav.setAttribute("aria-pressed", String(eff.nav !== "hidden"));
  el.toggleTools.setAttribute("aria-pressed", String(eff.tools));
  el.focus.setAttribute("aria-pressed", String(layout.focus));
  const compact = eff.nav === "compact";
  el.navCompact.title = compact ? "Expand sidebar (⌘⇧1)" : "Compact sidebar (⌘⇧1)";
  el.navCompact.setAttribute("aria-label", compact ? "Expand sidebar" : "Compact sidebar");
  el.toolbarShow.hidden = layout.focus;
  el.layPlayer.checked = eff.player !== "hidden";
  el.layPlayerExpanded.checked = eff.player === "expanded";
  el.layNav.checked = eff.nav !== "hidden";
  el.layNavCompact.checked = eff.nav === "compact";
  el.layToolbar.checked = eff.toolbar;
  el.layFocus.checked = layout.focus;
  localizeShortcuts(el.navCompact);
  renderTitlebar();
  // Panels animate for ~200 ms; keep the native Songsterr view glued to its area.
  embed?.track(LAYOUT_ANIM_MS);
}

function dispatch(cmd: LayoutCommand) {
  // The nav can be auto-compacted by a narrow window; "expand" must still expand it.
  if (cmd === "nav-compact" && !layout.focus && layout.nav === "expanded" && window.innerWidth < BREAKPOINTS.compactNav) {
    wideNav = !wideNav;
    renderLayout();
    return;
  }
  layout = applyLayoutCommand(layout, cmd);
  if (cmd === "nav-compact" || cmd === "nav") wideNav = false;
  saveLayout(layout);
  renderLayout();
}

function handleCommand(cmd: string) {
  if (cmd === "search") return focusSearch();
  const known: LayoutCommand[] = ["focus", "exit-focus", "nav", "nav-compact", "player", "player-hide", "tools", "toolbar"];
  if ((known as string[]).includes(cmd)) dispatch(cmd as LayoutCommand);
}

function focusSearch() {
  if (layout.toolbar && !layout.focus) {
    el.tbSearchInput.focus();
    el.tbSearchInput.select();
  } else {
    void showSearch(el.tbSearchInput.value || (sync.current ? songsterrQuery(sync.current) : ""), null);
  }
}

/** "⌘⇧F" in titles and <kbd>s reads "Ctrl+Shift+F" outside macOS. */
function localizeShortcuts(root: ParentNode | HTMLElement = document) {
  if (isMac) return;
  const fix = (s: string) => s.replace(/⌘/g, "Ctrl+").replace(/⇧/g, "Shift+");
  const nodes = root instanceof HTMLElement ? [root, ...root.querySelectorAll<HTMLElement>("[title]")] : [...root.querySelectorAll<HTMLElement>("[title]")];
  for (const n of nodes) if (n.title) n.title = fix(n.title);
  root.querySelectorAll?.("kbd").forEach((k) => {
    if (k.textContent === "⌘") k.textContent = "Ctrl";
    if (k.textContent === "⇧") k.textContent = "Shift";
  });
}

// ---- Views (Now Playing / Search / History / Favorites) ------------------------
function source(): Source {
  return embed && settings.songsterrPanel ? "songsterr" : "local";
}

/** Shows one stage layer. Covered native views are hidden, never closed. */
function renderStage() {
  const src = source();
  const onTab = view === "tab";
  el.page.hidden = onTab;
  el.local.hidden = !(onTab && src === "local");
  if (embed) {
    // The native view draws above the DOM, so it must step aside for DOM layers.
    if (onTab) void embed.show("page");
    else void embed.hide("page");
    if (src === "local") void embed.hide("local");
    else void embed.show("local");
  }
  for (const b of el.navItems) {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  el.sourceSwitch.hidden = !(embed && currentSong);
  el.sourceSwitch.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.source === src)));
  el.localCard.hidden = src !== "local" || !currentSong;
  renderToolbar();
}

function setView(v: View) {
  view = v;
  if (v === "history") renderEntryPage("history");
  if (v === "favorites") renderEntryPage("favorites");
  renderStage();
}

function setSource(src: Source) {
  if (!embed) return;
  settings.songsterrPanel = src === "songsterr";
  saveSettings(settings);
  if (src === "songsterr" && !shown && sync.best) void openSongsterr(sync.best, "auto");
  setView("tab");
}

// ---- Songsterr viewer ------------------------------------------------------------
/**
 * Shows a Songsterr page in the viewer (desktop) or the browser (Android).
 * "auto" follows Spotify; "manual" is a user choice and brings the viewer forward.
 */
async function openSongsterr(r: SongsterrResult, how: "auto" | "manual") {
  if (!embed) {
    if (how === "manual") await openExternal(r.url);
    return;
  }
  if (how === "manual") {
    settings.songsterrPanel = true;
    saveSettings(settings);
    setView("tab");
  }
  if (isSongPage(r)) library.open(toEntry(r));
  // Same page already showing: nothing to load (keeps Songsterr's state).
  if (shown?.url === r.url && embed.isOpen) {
    renderAll();
    return;
  }
  shown = r;
  renderAll();
  // Visible for the moment between the old page closing and the new one appearing.
  el.empty.replaceChildren(emptyCard("busy", "guitar", "Opening Songsterr…", label(r)));
  try {
    await embed.open(r.url);
    renderToolbar(); // Reload needs the page to exist
  } catch (e) {
    shown = null;
    await embed.close();
    renderAll();
    showBanner(`Could not show Songsterr in the app, opening the browser instead. <small>${escapeHtml(String(e))}</small>`, "warn");
    await openExternal(r.url);
  }
}

function renderToolbar() {
  const local = source() === "local";
  if (local && currentSong) el.tbTitle.textContent = `Local tab · ${currentSong.artist} – ${currentSong.title}`;
  else el.tbTitle.textContent = shown ? `Songsterr · ${label(shown)}` : "Songsterr";
  el.tbTitle.title = el.tbTitle.textContent;
  const favable = !!shown && isSongPage(shown) && !local;
  const isFav = favable && favorites.has(shown!.songId);
  for (const b of [el.fav, el.fav2]) {
    b.disabled = !favable;
    b.setAttribute("aria-pressed", String(isFav));
  }
  el.fav.innerHTML = icon(isFav ? "starFilled" : "star", 17);
  el.fav.title = isFav ? "Remove from favorites" : "Save to favorites";
  el.fav2.innerHTML = `${icon(isFav ? "starFilled" : "star", 14)}<span>${isFav ? "Saved" : "Save"}</span>`;
  el.refresh.disabled = !embed?.isOpen || local;
  const ext = shown?.url ?? sync.best?.url ?? null;
  el.external.disabled = !ext;
  el.openSongsterr.disabled = !ext;
}

function renderRecent() {
  const items = history.all.slice(0, 8);
  el.recent.replaceChildren(
    ...(items.length
      ? items.map((e) => {
          const li = document.createElement("li");
          const b = document.createElement("button");
          b.type = "button";
          b.title = label(e);
          b.innerHTML = `<span class="r-title">${escapeHtml(e.title)}</span><span class="r-artist">${escapeHtml(e.artist)}</span>`;
          if (shown?.url === e.url) b.setAttribute("aria-current", "true");
          b.onclick = () => void openSongsterr(toResult(e), "manual");
          li.appendChild(b);
          return li;
        })
      : [Object.assign(document.createElement("li"), { className: "r-empty", textContent: "Tabs you open appear here." })]),
  );
}

function toggleFavoriteShown() {
  if (!shown || !isSongPage(shown)) return;
  library.toggleFavorite(toEntry(shown!));
  renderToolbar();
  if (view === "favorites") renderEntryPage("favorites");
}

/** The lists changed from a sync: refresh every view that shows them. */
function renderLibrary() {
  renderRecent();
  renderToolbar();
  if (view === "history" || view === "favorites") renderEntryPage(view);
}

// ---- Status --------------------------------------------------------------------
function currentStatus(): SyncStatus {
  return syncStatus({
    detectorError: detector.status.kind === "error" ? detector.status.message : null,
    hasTrack: !!sync.current,
    isPlaying: !!sync.current?.isPlaying,
    phase: sync.phase,
  });
}

function renderStatus() {
  const s = currentStatus();
  el.statusPill.dataset.tone = s.tone;
  el.statusPill.querySelector(".status-label")!.textContent = s.label;
  el.statusPill.title = s.detail ? `${s.label}: ${s.detail}` : s.label;
  el.stripDot.dataset.tone = s.tone;
  el.stripStatus.textContent = s.label;
  el.toolsStatus.dataset.tone = s.tone;
  el.toolsStatus.textContent = s.label;
  el.toolsStatusDetail.hidden = !s.detail;
  el.toolsStatusDetail.textContent = s.detail ?? "";
  renderMatchInfo();
  renderEmpty(s);
}

function renderMatchInfo() {
  const bits: string[] = [];
  if (shown) {
    const how = shown === sync.best ? { found: "matches title and artist", picked: "your pick for this song", uncertain: "closest result, not a confident match", none: "Songsterr search page" }[sync.phase as string] : "opened manually";
    bits.push(`<span class="m-title">${escapeHtml(label(shown))}</span><span class="m-sub">Songsterr${how ? ` · ${escapeHtml(how)}` : ""}</span>`);
  } else if (sync.best && sync.current) {
    bits.push(`<span class="m-title">${escapeHtml(label(sync.best))}</span><span class="m-sub">Ready on Songsterr, not opened</span>`);
  }
  if (currentSong) bits.push(`<span class="m-sub">Local catalogue: ${escapeHtml(`${currentSong.artist} – ${currentSong.title}`)}${localHow ? ` · ${escapeHtml(localHow)}` : ""}</span>`);
  el.matchInfo.innerHTML = bits.join("") || `<span class="muted">No tab open</span>`;
  el.searchAgain.disabled = !sync.current;
  el.wrong.disabled = !sync.current;
}

/** What the viewer area shows before (or instead of) a Songsterr page. */
function renderEmpty(s: SyncStatus) {
  if (embed?.isOpen) return;
  let iconName: Parameters<typeof icon>[0] = "music";
  let title = s.label;
  let text = s.detail ?? "";
  let action: { label: string; run: () => void } | null = null;
  if (!sync.current) {
    if (s.tone !== "error") {
      title = "Play something on Spotify";
      text = "Guitarfish detects the song and opens its tablature from Songsterr here.";
    }
  } else if (sync.phase === "searching") {
    iconName = "search";
    text = sync.current ? `Looking for “${sync.current.title}” by ${sync.current.artist}` : "";
  } else if (sync.phase === "paused" && sync.current) {
    title = "Automatic search is off";
    text = `Now playing “${sync.current.title}”.`;
    action = { label: "Find tab", run: () => void sync.searchCurrent() };
  } else if (sync.best && sync.current) {
    iconName = "guitar";
    title = sync.phase === "found" || sync.phase === "picked" ? "Tablature ready" : s.label;
    text = `${label(sync.best)} · Follow Spotify is off, so the current page was left alone.`;
    action = { label: "Open tab", run: () => void openSongsterr(sync.best!, "manual") };
  }
  const card = emptyCard(sync.phase === "searching" ? "busy" : s.tone, iconName, title, text);
  if (action) {
    const b = document.createElement("button");
    b.className = "btn primary";
    b.type = "button";
    b.textContent = action.label;
    b.onclick = action.run;
    card.appendChild(b);
  }
  el.empty.replaceChildren(card);
}

function emptyCard(tone: string, iconName: Parameters<typeof icon>[0], title: string, text: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "empty-card";
  card.dataset.tone = tone;
  card.innerHTML = `<div class="empty-icon">${icon(iconName, 26)}</div><h2>${escapeHtml(title)}</h2>${text ? `<p>${escapeHtml(text)}</p>` : ""}`;
  return card;
}

// ---- Player --------------------------------------------------------------------
let artUrl: string | null = null;

function renderArt(url: string | null) {
  if (url === artUrl) return;
  artUrl = url;
  if (!url) {
    el.art.innerHTML = icon("music", 22);
    return;
  }
  const img = new Image();
  img.alt = "";
  img.onerror = () => {
    if (artUrl === url) el.art.innerHTML = icon("music", 22);
  };
  img.src = url;
  el.art.replaceChildren(img);
}

function renderNowPlaying() {
  const t = sync.current;
  el.title.textContent = t ? t.title : "Waiting for Spotify…";
  el.artist.textContent = t ? t.artist + (t.album ? ` · ${t.album}` : "") : "Play a song in Spotify on this device";
  el.stripTitle.textContent = t ? t.title : "Waiting for Spotify…";
  el.stripArtist.textContent = t ? t.artist : "";
  el.toolsSource.textContent = t ? t.player : "—";
  el.player.dataset.playing = String(!!t?.isPlaying);
  renderArt(t?.artworkUrl ?? null);

  const onDevice = t?.source === "os";
  el.transport.hidden = !caps.transport;
  for (const b of [el.prev, el.play, el.next]) {
    b.disabled = !onDevice;
    if (!onDevice) b.title = t ? "Controls need Spotify on this device" : "Nothing playing";
  }
  if (onDevice) {
    el.prev.title = "Previous track";
    el.next.title = "Next track";
  }
  const playing = !!t?.isPlaying;
  el.play.innerHTML = icon(playing ? "pause" : "play", 18);
  if (onDevice) el.play.title = playing ? "Pause" : "Play";
  el.play.setAttribute("aria-label", playing ? "Pause" : "Play");

  const seekable = caps.seek && onDevice && !!t?.durationMs;
  el.progress.classList.toggle("seekable", seekable);
  el.progress.title = seekable ? "Seek" : "";

  el.volume.hidden = !(caps.volume && onDevice && t?.volume != null);
  if (t?.volume != null && performance.now() > volumeHoldUntil) {
    el.volumeRange.value = String(t.volume);
    if (t.volume > 0) lastVolume = t.volume;
    renderVolume();
  }
  renderTitlebar();
}

function renderVolume() {
  setFill(el.volumeRange);
  const muted = Number(el.volumeRange.value) === 0;
  el.mute.innerHTML = icon(muted ? "volumeMute" : "volume", 16);
  el.mute.title = muted ? "Unmute" : "Mute";
  el.mute.setAttribute("aria-label", el.mute.title);
}

function renderTitlebar() {
  el.titlebarText.textContent = layout.focus && sync.current ? `${sync.current.title} — ${sync.current.artist}` : "Guitarfish";
}

function tick() {
  const pos = sync.livePosition();
  const dur = sync.current?.durationMs ?? null;
  if (sync.current && pos != null) {
    const pct = dur ? Math.min(100, (pos / dur) * 100) : 0;
    el.pos.textContent = fmt(pos);
    el.dur.textContent = fmt(dur);
    el.progressFill.style.width = `${pct}%`;
    el.progress.setAttribute("aria-valuenow", String(Math.round(pct)));
    if (settings.follow && currentSong && sync.current.isPlaying && source() === "local") {
      viewer.follow(pos + settings.followOffsetSec * 1000);
    }
  } else {
    el.pos.textContent = "–:––";
    el.dur.textContent = fmt(dur);
    el.progressFill.style.width = "0%";
  }
  requestAnimationFrame(tick);
}

async function control(action: "playpause" | "next" | "previous" | "seek" | "volume", value?: number) {
  try {
    await invoke("plugin:nowplaying|control", { action, value: value ?? null });
  } catch (e) {
    showBanner(`Spotify didn't accept the command. <small>${escapeHtml(String(e))}</small>`, "warn");
  }
  void sync.poll();
}

async function loadCapabilities() {
  if (!isTauri()) return;
  caps = await detector.capabilities();
}

function bindPlayer() {
  el.play.onclick = () => {
    if (sync.current) {
      // Optimistic, so the button reacts before the next poll.
      sync.patchCurrent({ positionMs: sync.livePosition(), isPlaying: !sync.current.isPlaying });
      renderNowPlaying();
    }
    void control("playpause");
  };
  el.prev.onclick = () => void control("previous");
  el.next.onclick = () => void control("next");
  el.progress.onclick = (ev) => {
    if (!el.progress.classList.contains("seekable") || !sync.current?.durationMs) return;
    const r = el.progress.getBoundingClientRect();
    const ms = Math.round(((ev.clientX - r.left) / r.width) * sync.current.durationMs);
    sync.patchCurrent({ positionMs: ms });
    void control("seek", ms);
  };
  let volTimer = 0;
  el.volumeRange.oninput = () => {
    volumeHoldUntil = performance.now() + 1500;
    renderVolume();
    clearTimeout(volTimer);
    volTimer = window.setTimeout(() => void control("volume", Number(el.volumeRange.value)), 120);
  };
  el.mute.onclick = () => {
    const v = Number(el.volumeRange.value);
    if (v > 0) lastVolume = v;
    el.volumeRange.value = String(v > 0 ? 0 : lastVolume || 50);
    volumeHoldUntil = performance.now() + 1500;
    renderVolume();
    void control("volume", Number(el.volumeRange.value));
  };
  el.playerCollapse.onclick = () => dispatch("player");
  el.playerExpand.onclick = () => dispatch("player");
  el.playerShow.onclick = () => dispatch("player-hide");
  el.exitFocus.onclick = () => dispatch("exit-focus");
}

// ---- Local catalogue (alphaTab) -------------------------------------------------
function showPanel(content: HTMLElement | null) {
  el.panel.replaceChildren(...(content ? [content] : []));
  el.panel.hidden = !content;
}

function fillTabSelect(tabs: TabInfo[], selected: number) {
  el.tabSelect.replaceChildren(
    ...tabs.map((t, i) => {
      const o = document.createElement("option");
      o.value = String(t.id);
      o.textContent = `${t.instrument} v${t.version}${t.isPlaceholder ? " (placeholder)" : ""}`;
      o.selected = i === selected;
      return o;
    }),
  );
  el.tabSelect.hidden = tabs.length < 2;
}

async function openTab(tab: TabInfo) {
  const { format, data } = await api.tab(tab);
  viewer.load(format, data);
}

async function openSong(song: Song, how: string) {
  currentSong = song;
  localHow = how === "picked" ? "your pick" : how;
  showPanel(null);
  renderStage();
  renderMatchInfo();
  if (song.tabs.length === 0) {
    viewer.clear();
    showPanel(notice("This song has no tabs yet. Add one with <code>npm run import</code> on the server."));
    return;
  }
  const first = song.tabs[0];
  fillTabSelect(song.tabs, 0);
  if (first.isPlaceholder) {
    showPanel(notice("Showing a <b>placeholder exercise</b>, not the real tab. Switch to <b>Songsterr</b> for the real one, or import your own tab."));
  }
  try {
    await openTab(first);
  } catch (e) {
    showBanner(`Could not load tab: ${escapeHtml(String(e))}`, "warn");
  }
}

function notice(html: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "notice";
  d.innerHTML = html;
  return d;
}

/** Local catalogue songs to pick from; picking confirms the match for this track. */
function catalogueRows(track: Track | null, songs: Song[]): HTMLElement {
  const list = document.createElement("ul");
  list.className = "rows";
  if (songs.length === 0) {
    list.innerHTML = `<li class="empty-row">No songs found in the Guitarfish catalogue.</li>`;
    return list;
  }
  for (const s of songs) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "row";
    const meta = s.score != null ? `<span class="row-meta score">${Math.round(s.score * 100)}%</span>` : s.tabs.length === 0 ? `<span class="row-meta">no tabs yet</span>` : "";
    b.innerHTML = `${icon("layers", 16)}<span class="row-main"><span class="row-title">${escapeHtml(s.title)}</span><span class="row-sub">${escapeHtml(s.artist)}</span></span>${meta}`;
    b.onclick = async () => {
      if (track) {
        try {
          await api.confirm(track, s);
        } catch (e) {
          console.warn("confirm failed", e);
        }
      }
      settings.songsterrPanel = false;
      saveSettings(settings);
      setView("tab");
      await openSong(s, "picked");
    };
    li.appendChild(b);
    list.appendChild(li);
  }
  return list;
}

/** Not in the local catalogue: offer the candidates and a way back to Songsterr. */
function showLocalMiss(track: Track, candidates: Song[]) {
  viewer.clear();
  el.tabSelect.hidden = true;
  const wrap = document.createElement("div");
  wrap.className = "page-inner";
  wrap.innerHTML = `<div class="page-head"><h1>Not in the local catalogue</h1></div>`;
  const sw = document.createElement("button");
  sw.className = "btn";
  sw.type = "button";
  sw.textContent = "Show Songsterr instead";
  sw.hidden = !embed;
  sw.onclick = () => setSource("songsterr");
  wrap.querySelector(".page-head")!.appendChild(sw);
  wrap.insertAdjacentHTML("beforeend", `<div class="list-title">${candidates.length ? "Is it one of these?" : "No candidates"}</div>`);
  wrap.appendChild(catalogueRows(track, candidates));
  showPanel(wrap);
  renderStage();
}

// ---- Pages -----------------------------------------------------------------------
let searchSeq = 0;

function songsterrRows(results: SongsterrResult[], onPick: (r: SongsterrResult) => void): HTMLElement {
  const list = document.createElement("ul");
  list.className = "rows";
  if (!results.length) list.innerHTML = `<li class="empty-row">No results on Songsterr.</li>`;
  for (const r of results) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "row";
    const confident = sync.current && isConfidentMatch(sync.current, r) ? `<span class="row-meta score">match</span>` : "";
    b.innerHTML = `${icon("guitar", 16)}<span class="row-main"><span class="row-title">${escapeHtml(r.title)}</span><span class="row-sub">${escapeHtml([r.artist, r.instruments.slice(0, 4).join(" · ")].filter(Boolean).join("  ·  "))}</span></span>${confident}`;
    if (shown?.url === r.url) b.insertAdjacentHTML("beforeend", `<span class="row-meta">showing</span>`);
    b.onclick = () => onPick(r);
    li.appendChild(b);
    list.appendChild(li);
  }
  return list;
}

/**
 * The Search page. With `correction`, it is the "Wrong tab?" flow for that track:
 * the pick is remembered for it.
 */
async function showSearch(query: string, correction: Track | null) {
  const seq = ++searchSeq;
  view = "search";
  renderStage();
  const inner = document.createElement("div");
  inner.className = "page-inner";
  inner.innerHTML = `
    <div class="page-head"><h1>${correction ? "Pick the right tab" : "Search"}</h1></div>
    <form class="page-search" role="search">
      <input type="search" placeholder="Artist and song" aria-label="Search" value="${escapeHtml(query)}" />
      <button class="btn primary" type="submit">Search</button>
    </form>
    ${correction ? `<div class="notice">Choosing the tab for <b>${escapeHtml(correction.title)}</b> by ${escapeHtml(correction.artist)}. Guitarfish will remember your choice for this song.</div>` : ""}
    <div class="list-title">Songsterr</div><div data-slot="songsterr"><ul class="rows"><li class="empty-row">Searching…</li></ul></div>
    <div class="list-title">Guitarfish catalogue</div><div data-slot="local"><ul class="rows"><li class="empty-row">Searching…</li></ul></div>`;
  el.page.replaceChildren(inner);
  const form = inner.querySelector("form")!;
  const input = form.querySelector("input")!;
  form.onsubmit = (ev) => {
    ev.preventDefault();
    void showSearch(input.value.trim(), correction);
  };
  if (!query) {
    inner.querySelectorAll("[data-slot]").forEach((s) => (s.innerHTML = `<ul class="rows"><li class="empty-row">Type an artist or song.</li></ul>`));
    input.focus();
    return;
  }
  const slotS = inner.querySelector<HTMLElement>('[data-slot="songsterr"]')!;
  const slotL = inner.querySelector<HTMLElement>('[data-slot="local"]')!;

  const pickSongsterr = (r: SongsterrResult) => {
    if (correction) sync.pick(correction, r);
    void openSongsterr(r, "manual");
  };
  void api.songsterrSearch(query).then(
    (rs) => {
      if (seq !== searchSeq) return;
      const rows = songsterrRows(rs, pickSongsterr);
      const li = document.createElement("li");
      const page = songsterrSearchPage(query);
      li.innerHTML = `<button type="button" class="row">${icon("external", 16)}<span class="row-main"><span class="row-title">Open Songsterr's search page</span><span class="row-sub">${escapeHtml(query)}</span></span></button>`;
      li.querySelector("button")!.onclick = () => void openSongsterr(page, "manual");
      rows.querySelector(".empty-row")?.remove();
      rows.appendChild(li);
      slotS.replaceChildren(rows);
    },
    (e) => {
      if (seq !== searchSeq) return;
      slotS.innerHTML = `<ul class="rows"><li class="empty-row">Search failed: ${escapeHtml(String(e))}</li></ul>`;
    },
  );
  void api.search(query).then(
    (r) => {
      if (seq === searchSeq) slotL.replaceChildren(catalogueRows(correction, r.results));
    },
    () => {
      if (seq === searchSeq) slotL.innerHTML = `<ul class="rows"><li class="empty-row">Tab server unreachable.</li></ul>`;
    },
  );
}

function renderEntryPage(kind: "history" | "favorites") {
  const store = kind === "history" ? history : favorites;
  const inner = document.createElement("div");
  inner.className = "page-inner";
  inner.innerHTML = `<div class="page-head"><h1>${kind === "history" ? "History" : "Favorites"}</h1></div>`;
  if (kind === "history" && store.all.length) {
    const clear = document.createElement("button");
    clear.className = "btn small";
    clear.type = "button";
    clear.textContent = "Clear history";
    clear.onclick = () => {
      library.clearHistory();
      renderRecent();
      renderEntryPage("history");
    };
    inner.querySelector(".page-head")!.appendChild(clear);
  }
  const list = document.createElement("ul");
  list.className = "rows";
  if (!store.all.length) {
    list.innerHTML = `<li class="empty-row">${kind === "history" ? "Tabs you open appear here." : "Save tabs with the star in the toolbar."}</li>`;
  }
  for (const e of store.all) list.appendChild(entryRow(e, kind));
  inner.appendChild(list);
  el.page.replaceChildren(inner);
}

function entryRow(e: TabEntry, kind: "history" | "favorites"): HTMLElement {
  const li = document.createElement("li");
  li.className = "row-wrap";
  const b = document.createElement("button");
  b.type = "button";
  b.className = "row";
  b.innerHTML = `${icon(kind === "history" ? "history" : "starFilled", 16)}<span class="row-main"><span class="row-title">${escapeHtml(e.title)}</span><span class="row-sub">${escapeHtml(e.artist)}</span></span><span class="row-meta">${escapeHtml(ago(e.at))}</span>`;
  b.onclick = () => void openSongsterr(toResult(e), "manual");
  const fav = favorites.has(e.songId);
  const star = document.createElement("button");
  star.type = "button";
  star.className = "icon-btn small";
  star.title = fav ? "Remove from favorites" : "Save to favorites";
  star.setAttribute("aria-label", star.title);
  star.setAttribute("aria-pressed", String(fav));
  star.innerHTML = icon(fav ? "starFilled" : "star", 16);
  star.onclick = () => {
    library.toggleFavorite(e);
    renderEntryPage(kind);
    renderToolbar();
  };
  li.append(b, star);
  return li;
}

// ---- Tools sidebar -------------------------------------------------------------
async function refreshSpotifyStatus() {
  try {
    const s = await api.spotifyStatus();
    el.spotifyStatus.textContent = !s.configured ? "Web API: not configured on server" : s.connected ? "Web API: connected" : "Web API: not connected";
    el.spotifyBtn.disabled = !s.configured;
    el.spotifyBtn.textContent = s.connected ? "Reconnect" : "Connect";
  } catch {
    el.spotifyStatus.textContent = "Web API: server unreachable";
    el.spotifyBtn.disabled = true;
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
}

function bindTools() {
  el.setFollowSpotify.checked = settings.followSpotify;
  el.setAutoSearch.checked = settings.autoSearch;
  el.setFallback.checked = settings.spotifyFallback;
  el.setFollow.checked = settings.follow;
  el.setServer.value = settings.serverUrl;
  el.setOffset.value = String(settings.followOffsetSec);
  el.setOffsetOut.textContent = `${settings.followOffsetSec.toFixed(1)} s`;
  el.setZoom.value = String(settings.zoom);
  el.setZoomOut.textContent = `${Math.round(settings.zoom * 100)}%`;
  el.setTheme.value = settings.theme;
  [el.setOffset, el.setZoom].forEach(setFill);

  el.setFollowSpotify.onchange = () => {
    settings.followSpotify = el.setFollowSpotify.checked;
    saveSettings(settings);
    // Turning it on catches up with the song that's playing now.
    if (settings.followSpotify && sync.best && sync.current) void openSongsterr(sync.best, "auto");
  };
  el.setAutoSearch.onchange = () => {
    settings.autoSearch = el.setAutoSearch.checked;
    saveSettings(settings);
    if (settings.autoSearch && sync.current && sync.phase === "paused") void sync.searchCurrent();
  };
  el.setFallback.onchange = () => {
    settings.spotifyFallback = el.setFallback.checked;
    saveSettings(settings);
  };
  el.spotifyBtn.onclick = () => void openExternal(api.spotifyLoginUrl());
  el.setServer.onchange = () => {
    settings.serverUrl = el.setServer.value.trim().replace(/\/+$/, "");
    api.setBaseUrl(settings.serverUrl);
    saveSettings(settings);
    sync.relookup(); // look the current song up again on the new server
    void refreshSpotifyStatus();
    library.resetSeed(); // a new server starts with this device's full lists
    void library.syncNow();
  };
  el.setLibrarySync.checked = settings.librarySync;
  el.setLibrarySync.onchange = () => {
    settings.librarySync = el.setLibrarySync.checked;
    saveSettings(settings);
    void library.syncNow(); // syncs, or shows "Sync off"
  };
  el.testBtn.onclick = async () => {
    try {
      await api.health();
      el.testBtn.textContent = "OK ✓";
    } catch {
      el.testBtn.textContent = "Unreachable";
    }
    setTimeout(() => (el.testBtn.textContent = "Test"), 2500);
  };
  el.setTheme.onchange = () => {
    settings.theme = el.setTheme.value === "midnight" ? "midnight" : "graphite";
    saveSettings(settings);
    applyTheme();
  };
  el.setFollow.onchange = () => {
    settings.follow = el.setFollow.checked;
    if (!settings.follow) viewer.hideHighlight();
    saveSettings(settings);
  };
  el.setOffset.oninput = () => {
    settings.followOffsetSec = Number(el.setOffset.value);
    el.setOffsetOut.textContent = `${settings.followOffsetSec.toFixed(1)} s`;
    setFill(el.setOffset);
    saveSettings(settings);
  };
  el.setZoom.oninput = () => setFill(el.setZoom);
  el.setZoom.onchange = () => {
    settings.zoom = Number(el.setZoom.value);
    el.setZoomOut.textContent = `${Math.round(settings.zoom * 100)}%`;
    saveSettings(settings);
    viewer.setZoom(settings.zoom);
  };
  el.tabSelect.onchange = async () => {
    const tab = currentSong?.tabs.find((t) => String(t.id) === el.tabSelect.value);
    if (tab) await openTab(tab);
  };

  el.searchAgain.onclick = () => void sync.searchAgain();
  el.wrong.onclick = () => {
    if (!sync.current) return;
    clearCachedLookup(sync.current);
    void showSearch(songsterrQuery(sync.current), sync.current);
  };
  el.openSongsterr.onclick = () => {
    const url = shown?.url ?? sync.best?.url;
    if (url) void openExternal(url);
  };
  el.fav2.onclick = toggleFavoriteShown;
  el.toolsClose.onclick = () => dispatch("tools");
  // Each switch issues the command that flips it; renderLayout re-syncs all of them.
  const layoutSwitches: [HTMLInputElement, LayoutCommand][] = [
    [el.layPlayer, "player-hide"],
    [el.layPlayerExpanded, "player"],
    [el.layNav, "nav"],
    [el.layNavCompact, "nav-compact"],
    [el.layToolbar, "toolbar"],
    [el.layFocus, "focus"],
  ];
  for (const [input, cmd] of layoutSwitches) input.onchange = () => dispatch(cmd);
}

// ---- Toolbar & nav -----------------------------------------------------------------
function bindChrome() {
  el.toggleNav.onclick = () => dispatch("nav");
  el.toggleTools.onclick = () => dispatch("tools");
  el.focus.onclick = () => dispatch("focus");
  el.toolbarHide.onclick = () => dispatch("toolbar");
  el.toolbarShow.onclick = () => dispatch("toolbar");
  el.navCompact.onclick = () => dispatch("nav-compact");
  el.navHide.onclick = () => dispatch("nav");
  el.fav.onclick = toggleFavoriteShown;
  el.refresh.onclick = () => void embed?.reload();
  el.external.onclick = () => {
    const url = shown?.url ?? sync.best?.url;
    if (url) void openExternal(url);
  };
  el.tbSearch.onsubmit = (ev) => {
    ev.preventDefault();
    const q = el.tbSearchInput.value.trim();
    void showSearch(q, null);
  };
  el.sourceSwitch.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    b.onclick = () => setSource(b.dataset.source === "local" ? "local" : "songsterr");
  });
  for (const b of el.navItems) {
    b.onclick = () => {
      const v = b.dataset.view as View;
      if (v === "search") return void showSearch(el.tbSearchInput.value.trim() || (sync.current ? songsterrQuery(sync.current) : ""), null);
      if (v === "tab" && sync.best && sync.current && settings.followSpotify && source() === "songsterr" && shown?.url !== sync.best.url) {
        // Back from a history tab to the song that is playing.
        return void openSongsterr(sync.best, "manual");
      }
      setView(v);
    };
  }

  // Keyboard: Esc leaves Focus Mode. Other shortcuts come from the native menu on
  // macOS (so they also work while the Songsterr page has focus); elsewhere from here.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && layout.focus) {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement && t.value) return; // let Esc clear the field first
      e.preventDefault();
      dispatch("exit-focus");
      return;
    }
    if (nativeMac || !(e.metaKey || e.ctrlKey) || e.altKey) return;
    const shift = e.shiftKey;
    let cmd: string | null = null;
    if (shift && e.code === "KeyF") cmd = "focus";
    else if (e.code === "Digit1") cmd = shift ? "nav-compact" : "nav";
    else if (e.code === "Digit2") cmd = shift ? "player-hide" : "player";
    else if (e.code === "Digit3" && !shift) cmd = "tools";
    else if (e.code === "Digit4" && !shift) cmd = "toolbar";
    else if (e.code === "KeyK" && !shift) cmd = "search";
    if (cmd) {
      e.preventDefault();
      handleCommand(cmd);
    }
  });
  if (nativeMac) void listen<string>("layout-command", (e) => handleCommand(e.payload));

  let wasNarrow = window.innerWidth < BREAKPOINTS.compactNav;
  window.addEventListener("resize", () => {
    const narrow = window.innerWidth < BREAKPOINTS.compactNav;
    if (narrow !== wasNarrow) {
      wasNarrow = narrow;
      wideNav = false;
    }
    renderLayout();
  });
}

function renderAll() {
  renderStage();
  renderRecent();
  renderStatus();
}

// ---- Permission (Android) ----------------------------------------------------
async function ensurePermission(): Promise<void> {
  const waited = await detector.waitForPermission(() => {
    const box = document.createElement("div");
    box.className = "page-inner";
    box.innerHTML = `<div class="page-head"><h1>Allow Guitarfish to see what's playing</h1></div>
    <p class="muted">Android only shares the current song with apps that have <b>Notification access</b>.
    Tap the button, enable <b>Guitarfish</b>, then come back.</p>`;
    const btn = document.createElement("button");
    btn.className = "btn primary";
    btn.textContent = "Open settings";
    btn.onclick = () => detector.requestPermission();
    box.appendChild(btn);
    showPanel(box);
  });
  if (!waited) return;
  showPanel(null);
  // The playback controls depend on the access: read them again now it's granted.
  await loadCapabilities();
  renderNowPlaying();
}

// ---- Updates ---------------------------------------------------------------------
/** System notification plus a banner with a link to the release page. */
async function announceUpdate(u: UpdateInfo) {
  showBanner(`<b>${escapeHtml(u.name)}</b> is available. <button class="btn" type="button" data-update>Download</button>`);
  el.banner.querySelector<HTMLButtonElement>("[data-update]")?.addEventListener("click", () => {
    showBanner(null);
    void openExternal(u.url);
  });
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title: "Guitarfish update available", body: `Version ${u.version} is ready to download.` });
  } catch (e) {
    console.warn("update notification failed", e);
  }
}

async function checkUpdates() {
  if (!isTauri()) return;
  const u = await checkForUpdate({ currentVersion: await getVersion() });
  if (u) await announceUpdate(u);
}

// ---- Boot ------------------------------------------------------------------------
async function main() {
  applyTheme();
  localizeShortcuts();
  bindPlayer();
  bindTools();
  bindChrome();
  renderLayout();
  renderAll();
  renderNowPlaying();
  requestAnimationFrame(tick);
  void refreshSpotifyStatus();
  if (!isTauri()) {
    showBanner("Running in a browser: device detection is off, only the Spotify Web API fallback works.");
  }
  void library.start(window);
  await loadCapabilities();
  renderNowPlaying();
  await ensurePermission();
  // With change events from the plugin, read on each event and poll only now and then.
  let events = caps.events;
  if (events) {
    try {
      await listen("nowplaying://changed", () => void sync.wake());
    } catch (e) {
      console.warn("nowplaying events unavailable, polling instead", e);
      events = false;
    }
  }
  await sync.start(pollIntervalFor({ events }));
  void checkUpdates();
  setInterval(() => void checkUpdates(), UPDATE_CHECK_MS);
}

void main();
