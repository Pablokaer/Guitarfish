import { getVersion } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Catalogue } from "./catalogue";
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
import { EntryStore, isSongPage, PickStore, pushHistory, toEntry, toggleFavorite, toResult, trackKey, type TabEntry } from "./library";
import { cleanTitle, isConfidentMatch, songsterrQuery, songsterrSearchPage } from "./match";
import { clampSpeed, clampTranspose, cursorSource, PracticeStore, SPEED_PRESETS } from "./practice";
import { dropLegacyStorage, loadSettings, saveSettings } from "./settings";
import { syncStatus, type SyncStatus } from "./status";
import "./styles.css";
import { searchSongsterr } from "./songsterr";
import { pollIntervalFor, SyncController } from "./sync";
import { ACCEPTED_EXTENSIONS, checkImport, MAX_TAB_BYTES, TOO_LARGE } from "./tabfile";
import type { PlaybackCapabilities, Song, SongsterrResult, TabInfo, Track } from "./types";
import { installUpdate, updateAction, updateNotice } from "./selfupdate";
import { checkForUpdate, checkNow, type UpdateInfo } from "./update";
import { TabViewer, type PlayerStatus } from "./viewer";

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
  navItems: [...document.querySelectorAll<HTMLButtonElement>(".nav-item[data-view]")],
  recent: $("recent"),
  navCompact: $<HTMLButtonElement>("btn-nav-compact"),
  navHide: $<HTMLButtonElement>("btn-nav-hide"),
  navActions: $("nav-actions"),
  checkUpdates: $<HTMLButtonElement>("btn-check-updates"),
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
  matchInfo: $("match-info"),
  searchAgain: $<HTMLButtonElement>("btn-search-again"),
  wrong: $<HTMLButtonElement>("btn-wrong"),
  openSongsterr: $<HTMLButtonElement>("btn-open-songsterr"),
  fav2: $<HTMLButtonElement>("btn-fav-2"),
  importTab: $<HTMLButtonElement>("btn-import"),
  myTabs: $<HTMLButtonElement>("btn-my-tabs"),
  localCard: $("local-card"),
  tabSelect: $<HTMLSelectElement>("tab-select"),
  setFollow: $<HTMLInputElement>("set-follow"),
  setOffset: $<HTMLInputElement>("set-offset"),
  setOffsetOut: $<HTMLOutputElement>("set-offset-out"),
  setZoom: $<HTMLInputElement>("set-zoom"),
  setZoomOut: $<HTMLOutputElement>("set-zoom-out"),
  prTuning: $("pr-tuning"),
  prTranspose: $<HTMLInputElement>("pr-transpose"),
  prTransposeOut: $<HTMLOutputElement>("pr-transpose-out"),
  prTransposeDown: $<HTMLButtonElement>("pr-transpose-down"),
  prTransposeUp: $<HTMLButtonElement>("pr-transpose-up"),
  prTransposeReset: $<HTMLButtonElement>("pr-transpose-reset"),
  prPlay: $<HTMLButtonElement>("pr-play"),
  prStop: $<HTMLButtonElement>("pr-stop"),
  prState: $("pr-state"),
  prSpeed: $<HTMLInputElement>("pr-speed"),
  prSpeedOut: $<HTMLOutputElement>("pr-speed-out"),
  prSpeedPresets: $("pr-speed-presets"),
  prLoop: $<HTMLInputElement>("pr-loop"),
  prClearSelection: $<HTMLButtonElement>("pr-clear-selection"),
  setTheme: $<HTMLSelectElement>("set-theme"),
  layPlayer: $<HTMLInputElement>("lay-player"),
  layPlayerExpanded: $<HTMLInputElement>("lay-player-expanded"),
  layNav: $<HTMLInputElement>("lay-nav"),
  layNavCompact: $<HTMLInputElement>("lay-nav-compact"),
  layToolbar: $<HTMLInputElement>("lay-toolbar"),
  layFocus: $<HTMLInputElement>("lay-focus"),
};

// ---- Platform ------------------------------------------------------------------
const isMac = /Mac/i.test(navigator.userAgent) && !/iPhone|iPad/i.test(navigator.userAgent);
const embed = EmbeddedPage.supported() ? new EmbeddedPage(el.embedArea) : null;
/** macOS desktop: overlay title bar, and a native Layout menu that owns the shortcuts. */
const nativeMac = isMac && embed !== null;
document.documentElement.classList.toggle("platform-mac", nativeMac);

// ---- Services ------------------------------------------------------------------
const settings = loadSettings();
saveSettings(settings); // persists the v2 migration and drops removed settings
dropLegacyStorage();
const detector = new Detector();
const viewer = new TabViewer(el.tab, el.local, settings.zoom);
const history = new EntryStore("tabsync.history");
const favorites = new EntryStore("tabsync.favorites");
const picks = new PickStore();
const practice = new PracticeStore();

let catalogueOpen: Promise<Catalogue> | null = null;
/** The on-device tab catalogue (IndexedDB), opened on first use; a failed open is retried next time. */
function catalogue(): Promise<Catalogue> {
  catalogueOpen ??= Catalogue.open().catch((e: unknown) => {
    catalogueOpen = null;
    throw e;
  });
  return catalogueOpen;
}

/** Detector polling and the tab lookup for each new track; the UI below renders it. */
const sync = new SyncController({
  detector,
  catalogue: { lookup: async (t) => (await catalogue()).lookup(t) },
  songsterr: searchSongsterr,
  picks,
  settings,
  ui: {
    nowPlaying: () => renderNowPlaying(),
    trackChanged: () => {
      currentSong = null;
      viewer.stop();
      localHow = "";
      viewer.hideHighlight();
      el.tabSelect.hidden = true;
      showPanel(null);
    },
    status: () => renderStatus(),
    openSongsterr: (r) => void openSongsterr(r, "auto"),
    localMatch: (song, how) => openSong(song, how),
    localMiss: (track, candidates) => showLocalMiss(track, candidates),
    renderStage: () => renderStage(),
    renderAll: () => renderAll(),
  },
});

// ---- State ---------------------------------------------------------------------
type View = "tab" | "search" | "history" | "favorites" | "catalogue" | "import";
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
  if (!el.local.hidden) viewer.whenShown();
  el.localCard.hidden = src !== "local" || !currentSong;
  if (el.localCard.hidden) viewer.stop();
  renderToolbar();
}

function setView(v: View) {
  view = v;
  if (v === "history") renderEntryPage("history");
  if (v === "favorites") renderEntryPage("favorites");
  if (v === "catalogue") void renderCataloguePage();
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
  if (isSongPage(r)) history.update((l) => pushHistory(l, toEntry(r)));
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
  favorites.update((l) => toggleFavorite(l, toEntry(shown!)));
  renderToolbar();
  if (view === "favorites") renderEntryPage("favorites");
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
    const cursor = cursorSource({ player: viewer.player.state, spotifyPlaying: sync.current.isPlaying, follow: settings.follow });
    if (cursor === "spotify" && currentSong && source() === "local") {
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
      o.textContent = t.name;
      o.selected = i === selected;
      return o;
    }),
  );
  el.tabSelect.hidden = tabs.length < 2;
}

async function openTab(tab: TabInfo) {
  const { format, data } = await (await catalogue()).tab(tab.id);
  currentTabId = tab.id;
  const p = practice.get(tab.id);
  viewer.setTranspose(p.transpose);
  viewer.setSpeed(p.speed);
  renderPractice();
  viewer.load(format, data);
}

// ---- Local tab practice (transpose, tuning, built-in player) ----------------------
/** The local tab shown in the viewer; practice settings are kept per tab. */
let currentTabId: number | null = null;

function renderPractice() {
  const p = currentTabId != null ? practice.get(currentTabId) : { transpose: 0, speed: 1 };
  el.prTranspose.value = String(p.transpose);
  el.prTransposeOut.textContent = p.transpose > 0 ? `+${p.transpose}` : String(p.transpose);
  el.prTransposeReset.disabled = p.transpose === 0;
  el.prSpeed.value = String(p.speed);
  el.prSpeedOut.textContent = `${Math.round(p.speed * 100)}%`;
  el.prSpeedPresets.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.speed) === p.speed)));
  [el.prTranspose, el.prSpeed].forEach(setFill);
}

function renderTuning() {
  const t = viewer.tuning();
  if (!t) {
    el.prTuning.textContent = "—";
    return;
  }
  const label = [t.name, t.capo ? `capo ${t.capo}` : ""].filter(Boolean).join(" · ");
  el.prTuning.innerHTML = `${escapeHtml(t.notes)}${label ? `<small>${escapeHtml(label)}</small>` : ""}`;
}

function renderPlayer(s: PlayerStatus) {
  const playing = s.state === "playing";
  el.prPlay.innerHTML = icon(playing ? "pause" : "play", 16);
  el.prPlay.title = playing ? "Pause" : "Play the tab";
  el.prPlay.setAttribute("aria-label", el.prPlay.title);
  el.prStop.disabled = s.state === "stopped" && !s.loading;
  el.prState.textContent = s.loading ? "Loading sounds…" : playing ? "Playing · cursor follows the tab" : s.state === "paused" ? "Paused" : "Built-in player";
  el.prClearSelection.hidden = !viewer.hasSelection;
}

function setPractice(patch: { transpose?: number; speed?: number }) {
  if (currentTabId == null) return;
  const before = practice.get(currentTabId);
  const p = practice.set(currentTabId, patch);
  if (p.transpose !== before.transpose) viewer.setTranspose(p.transpose);
  if (p.speed !== before.speed) viewer.setSpeed(p.speed);
  renderPractice();
}

function bindPractice() {
  el.prSpeedPresets.replaceChildren(
    ...SPEED_PRESETS.map((v) => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.speed = String(v);
      b.textContent = `${Math.round(v * 100)}%`;
      b.onclick = () => setPractice({ speed: v });
      return b;
    }),
  );
  el.prTranspose.oninput = () => {
    el.prTransposeOut.textContent = el.prTranspose.value;
    setFill(el.prTranspose);
  };
  el.prTranspose.onchange = () => setPractice({ transpose: clampTranspose(el.prTranspose.value) });
  el.prTransposeDown.onclick = () => setPractice({ transpose: Number(el.prTranspose.value) - 1 });
  el.prTransposeUp.onclick = () => setPractice({ transpose: Number(el.prTranspose.value) + 1 });
  el.prTransposeReset.onclick = () => setPractice({ transpose: 0 });
  el.prSpeed.oninput = () => {
    el.prSpeedOut.textContent = `${Math.round(Number(el.prSpeed.value) * 100)}%`;
    setFill(el.prSpeed);
  };
  el.prSpeed.onchange = () => setPractice({ speed: clampSpeed(el.prSpeed.value) });
  el.prPlay.onclick = () => viewer.playPause();
  el.prStop.onclick = () => viewer.stop();
  el.prLoop.onchange = () => viewer.setLooping(el.prLoop.checked);
  el.prClearSelection.onclick = () => {
    viewer.clearSelection();
    el.prClearSelection.hidden = true;
  };
  // Dragging across bars selects them (alphaTab); offer to clear the selection.
  el.tab.addEventListener("pointerup", () => setTimeout(() => (el.prClearSelection.hidden = !viewer.hasSelection), 0));
  viewer.onPlayer = renderPlayer;
  viewer.onScore = renderTuning;
  renderPlayer(viewer.player);
  renderPractice();
}

async function openSong(song: Song, how: string) {
  currentSong = song;
  currentTabId = null;
  renderPractice();
  localHow = how === "picked" ? "your pick" : how;
  showPanel(null);
  renderStage();
  renderMatchInfo();
  if (song.tabs.length === 0) {
    viewer.clear();
    showPanel(notice("This song has no tabs left. Import one from the Tools sidebar."));
    return;
  }
  const first = song.tabs[0];
  fillTabSelect(song.tabs, 0);
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
    list.innerHTML = `<li class="empty-row">No matching songs in your tabs.</li>`;
    return list;
  }
  for (const s of songs) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "row";
    const meta = s.score != null ? `<span class="row-meta score">${Math.round(s.score * 100)}%</span>` : "";
    b.innerHTML = `${icon("layers", 16)}<span class="row-main"><span class="row-title">${escapeHtml(s.title)}</span><span class="row-sub">${escapeHtml(s.artist)}</span></span>${meta}`;
    b.onclick = async () => {
      if (track) {
        try {
          await (await catalogue()).confirm(track, s);
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
  const imp = document.createElement("button");
  imp.className = "btn";
  imp.type = "button";
  imp.innerHTML = `${icon("upload", 14)}Import a tab for it…`;
  imp.onclick = () => showImport(track);
  wrap.querySelector(".page-head")!.append(imp, sw);
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
    <div class="list-title">My tabs</div><div data-slot="local"><ul class="rows"><li class="empty-row">Searching…</li></ul></div>`;
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
  void searchSongsterr(query).then(
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
      const why = e instanceof Error ? e.message : String(e);
      slotS.innerHTML = `<ul class="rows"><li class="empty-row">Couldn't reach Songsterr. You may be offline. <small class="muted">${escapeHtml(why)}</small></li></ul>`;
    },
  );
  void catalogue()
    .then((c) => c.search(query))
    .then(
      (songs) => {
        if (seq === searchSeq) slotL.replaceChildren(catalogueRows(correction, songs));
      },
      (e) => {
        console.warn("catalogue search failed", e);
        if (seq === searchSeq) slotL.innerHTML = `<ul class="rows"><li class="empty-row">Couldn't read the local tab catalogue.</li></ul>`;
      },
    );
}

// ---- My tabs: import and manage the on-device catalogue ---------------------------
/**
 * The file picker's filter. Android's picker filters by MIME type, which these
 * formats don't have, so it would grey every tab file out: there the importer
 * checks the extension after the choice instead.
 */
const tabFileFilter = /android/i.test(navigator.userAgent) ? "" : ACCEPTED_EXTENSIONS.join(",");

/** The import form. `forTrack`: the song playing now, used to prefill it and offered as the link. */
function showImport(forTrack: Track | null) {
  view = "import";
  renderStage();
  const inner = document.createElement("div");
  inner.className = "page-inner";
  inner.innerHTML = `
    <div class="page-head"><h1>Import a tab</h1></div>
    <form class="import-form" novalidate>
      <label class="field">Tab file<input name="file" type="file"${tabFileFilter ? ` accept="${tabFileFilter}"` : ""} /></label>
      <label class="field">Artist<input name="artist" type="text" autocomplete="off" /></label>
      <label class="field">Title<input name="title" type="text" autocomplete="off" /></label>
      ${forTrack ? `<label class="switch-row"><span>Use it for the song playing now<small>${escapeHtml(label(forTrack))}</small></span><input name="link" type="checkbox" class="switch" checked /></label>` : ""}
      <p class="form-error" role="alert" hidden></p>
      <div class="form-actions"><button class="btn primary" type="submit">Import</button><button class="btn" type="button" data-cancel>Cancel</button></div>
    </form>
    <p class="hint">Guitar Pro (.gp, .gp3–.gp7, .gpx), alphaTex (.alphatex, .atex) or MusicXML (.musicxml, .xml, .mxl), up to 20 MB.
    The file is stored on this device only. Import only tabs you have the right to use.</p>`;
  el.page.replaceChildren(inner);
  const form = inner.querySelector("form")!;
  const field = (name: string) => form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  const [file, artist, title] = [field("file"), field("artist"), field("title")];
  const link = form.querySelector<HTMLInputElement>('[name="link"]');
  const error = form.querySelector<HTMLElement>(".form-error")!;
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  if (forTrack) {
    artist.value = forTrack.artist;
    title.value = cleanTitle(forTrack.title);
  }
  const fail = (msg: string) => {
    error.textContent = msg;
    error.hidden = false;
  };
  form.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = () => setView("catalogue");
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    error.hidden = true;
    const f = file.files?.[0];
    if (!f) return fail("Choose a tab file.");
    if (f.size > MAX_TAB_BYTES) return fail(TOO_LARGE);
    submit.disabled = true;
    try {
      const data = await f.arrayBuffer();
      const checked = checkImport({ fileName: f.name, data, title: title.value, artist: artist.value });
      if (!checked.ok) return fail(checked.error);
      const forNow = forTrack && link?.checked ? forTrack : null;
      const c = await catalogue();
      const { song } = await c.addTab({ ...checked.value, data, durationMs: forNow?.durationMs ?? null });
      if (forNow) await c.confirm(forNow, song);
      if (forNow && sync.current && trackKey(sync.current) === trackKey(forNow)) {
        // Show it at once in the local viewer.
        settings.songsterrPanel = false;
        saveSettings(settings);
        setView("tab");
        await sync.refreshLocal();
      } else {
        view = "catalogue";
        renderStage();
        await renderCataloguePage(`Imported ${checked.value.name} for “${song.title}” by ${song.artist}.`);
        if (sync.current) void sync.refreshLocal();
      }
    } catch (e) {
      console.warn("import failed", e);
      fail(`Couldn't save the tab on this device: ${String(e)}`);
    } finally {
      submit.disabled = false;
    }
  };
  file.focus();
}

/** The My tabs page: every imported song and tab file, with delete. */
async function renderCataloguePage(message?: string) {
  const inner = document.createElement("div");
  inner.className = "page-inner";
  inner.innerHTML = `<div class="page-head"><h1>My tabs</h1></div>${message ? `<div class="notice">${escapeHtml(message)}</div>` : ""}`;
  const add = document.createElement("button");
  add.className = "btn primary";
  add.type = "button";
  add.innerHTML = `${icon("upload", 14)}Import tab…`;
  add.onclick = () => showImport(sync.current);
  inner.querySelector(".page-head")!.appendChild(add);
  const list = document.createElement("ul");
  list.className = "rows";
  inner.appendChild(list);
  let songs: Song[];
  try {
    songs = await (await catalogue()).songs();
  } catch (e) {
    console.warn("catalogue unavailable", e);
    songs = [];
    list.innerHTML = `<li class="empty-row">Couldn't read the local tab catalogue.</li>`;
  }
  if (view !== "catalogue") return; // the user moved on meanwhile
  if (!songs.length && !list.childElementCount) {
    list.innerHTML = `<li class="empty-row">No tabs yet. Import Guitar Pro, alphaTex or MusicXML files to see them in the local viewer, following Spotify.</li>`;
  }
  for (const s of songs) list.appendChild(catalogueSongRow(s));
  el.page.replaceChildren(inner);
}

function catalogueSongRow(s: Song): HTMLElement {
  const li = document.createElement("li");
  li.className = "song-group";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "row";
  open.innerHTML = `${icon("layers", 16)}<span class="row-main"><span class="row-title">${escapeHtml(s.title)}</span><span class="row-sub">${escapeHtml(s.artist)}</span></span><span class="row-meta">${s.tabs.length} ${s.tabs.length === 1 ? "tab" : "tabs"}</span>`;
  open.onclick = async () => {
    settings.songsterrPanel = false;
    saveSettings(settings);
    setView("tab");
    await openSong(s, "opened from My tabs");
  };
  const files = document.createElement("ul");
  files.className = "tab-files";
  for (const t of s.tabs) {
    const f = document.createElement("li");
    f.innerHTML = `<span class="tab-file-name">${escapeHtml(t.name)}</span><span class="row-meta">${t.format === "gp" ? "Guitar Pro" : t.format === "alphatex" ? "alphaTex" : "MusicXML"}</span>`;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn small";
    del.innerHTML = `${icon("trash", 13)}<span>Delete</span>`;
    del.setAttribute("aria-label", `Delete ${t.name}`);
    let armed = false;
    del.onclick = async () => {
      if (!armed) {
        // Two steps, so a stray click can't delete a file.
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
        await (await catalogue()).deleteTab(t.id);
        await afterTabDeleted(s.id);
        await renderCataloguePage(`Deleted ${t.name}.`);
      } catch (e) {
        console.warn("delete failed", e);
        del.disabled = false;
        showBanner(`Couldn't delete ${escapeHtml(t.name)}: ${escapeHtml(String(e))}`, "warn");
      }
    };
    f.appendChild(del);
    files.appendChild(f);
  }
  li.append(open, files);
  return li;
}

/** A tab of `songId` was deleted: update the local viewer if it shows that song. */
async function afterTabDeleted(songId: number) {
  if (currentSong?.id !== songId) return;
  const song = await (await catalogue()).song(songId);
  if (song) {
    currentSong = song;
    const keep = song.tabs.findIndex((t) => t.id === currentTabId);
    fillTabSelect(song.tabs, Math.max(0, keep));
    if (keep < 0) await openTab(song.tabs[0]);
    return;
  }
  currentSong = null;
  currentTabId = null;
  viewer.clear();
  el.tabSelect.hidden = true;
  renderStage();
  renderMatchInfo();
  if (sync.current) void sync.refreshLocal();
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
      history.update(() => []);
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
    favorites.update((l) => toggleFavorite(l, { ...e, at: Date.now() }));
    renderEntryPage(kind);
    renderToolbar();
  };
  li.append(b, star);
  return li;
}

// ---- Tools sidebar -------------------------------------------------------------
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
}

function bindTools() {
  el.setFollowSpotify.checked = settings.followSpotify;
  el.setAutoSearch.checked = settings.autoSearch;
  el.setFollow.checked = settings.follow;
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
    void showSearch(songsterrQuery(sync.current), sync.current);
  };
  el.openSongsterr.onclick = () => {
    const url = shown?.url ?? sync.best?.url;
    if (url) void openExternal(url);
  };
  el.fav2.onclick = toggleFavoriteShown;
  el.importTab.onclick = () => showImport(sync.current);
  el.myTabs.onclick = () => setView("catalogue");
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
  // The installed version comes from Tauri, so a plain browser has nothing to check.
  el.navActions.hidden = !isTauri();
  el.checkUpdates.onclick = () => void checkUpdatesNow();
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
/**
 * System notification plus a banner. On desktop its button installs the update
 * and restarts (falling back to the release page); elsewhere it opens the page.
 */
async function announceUpdate(u: UpdateInfo) {
  const action = updateAction({ tauri: isTauri(), userAgent: navigator.userAgent });
  const notice = updateNotice(u, action);
  showBanner(`<b>${escapeHtml(u.name)}</b> is available. <button class="btn" type="button" data-update>${notice.button}</button>`);
  el.banner.querySelector<HTMLButtonElement>("[data-update]")?.addEventListener("click", () => {
    showBanner(null);
    if (action === "install") void installInApp(u);
    else void openExternal(u.url);
  });
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title: notice.title, body: notice.body });
  } catch (e) {
    console.warn("update notification failed", e);
  }
}

/** Thin glue: the updater, relaunch and opener plugins behind selfupdate.installUpdate. */
async function installInApp(u: UpdateInfo) {
  setUpdateBusy(true);
  try {
    await runInstall(u);
  } finally {
    setUpdateBusy(false);
  }
}

async function runInstall(u: UpdateInfo) {
  const outcome = await installUpdate(u, {
    check: async () => (await import("@tauri-apps/plugin-updater")).check(),
    relaunch: async () => (await import("@tauri-apps/plugin-process")).relaunch(),
    openUrl: openExternal,
    onStatus: (text) => showBanner(escapeHtml(text)),
  });
  if (outcome === "fallback") showBanner(`Couldn't install ${escapeHtml(u.name)} here, so its release page opened in your browser.`, "warn");
  else if (outcome === "restart-needed") showBanner(`${escapeHtml(u.name)} is installed. Restart Guitarfish to use it.`);
}

async function checkUpdates() {
  if (!isTauri()) return;
  const u = await checkForUpdate({ currentVersion: await getVersion() });
  if (u) await announceUpdate(u);
}

/** While a check or an install runs, the sidebar button is disabled. */
let updateBusy = false;
function setUpdateBusy(busy: boolean) {
  updateBusy = busy;
  el.checkUpdates.disabled = busy;
  el.checkUpdates.setAttribute("aria-busy", String(busy));
}

/** The sidebar button: checks now and, when there is a newer release, installs it right away. */
async function checkUpdatesNow() {
  if (updateBusy) return;
  setUpdateBusy(true);
  try {
    showBanner("Checking for updates…");
    const currentVersion = await getVersion();
    const result = await checkNow({ currentVersion });
    if (result.status === "error") {
      showBanner("Couldn't check for updates. Check your internet connection and try again.", "warn");
    } else if (result.status === "current") {
      showBanner(`Guitarfish ${escapeHtml(currentVersion)} is the latest version.`);
    } else if (updateAction({ tauri: isTauri(), userAgent: navigator.userAgent }) === "install") {
      await runInstall(result.update);
    } else {
      await openExternal(result.update.url);
      showBanner(`<b>${escapeHtml(result.update.name)}</b> is available: its release page opened in your browser.`);
    }
  } catch (e) {
    console.warn("update check failed", e);
    showBanner("Couldn't check for updates. Check your internet connection and try again.", "warn");
  } finally {
    setUpdateBusy(false);
  }
}

// ---- Boot ------------------------------------------------------------------------
async function main() {
  applyTheme();
  localizeShortcuts();
  bindPlayer();
  bindTools();
  bindPractice();
  bindChrome();
  renderLayout();
  renderAll();
  renderNowPlaying();
  requestAnimationFrame(tick);
  if (!isTauri()) {
    showBanner("Running in a browser: Guitarfish can't see what Spotify plays here. Use the desktop or Android app.");
  }
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
