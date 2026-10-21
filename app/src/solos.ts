import type { CamScene } from "./fretcam";
import { escapeHtml as esc } from "./html";
import type { KeyResult } from "./key";
import { LISTEN_MS } from "./listen";
import {
  defaultScaleFor,
  keyName,
  neckNotes,
  pitchName,
  positions,
  positionTab,
  relativeKey,
  SCALE_GROUPS,
  scaleById,
  scaleNotes,
  SCALES,
  stringLabels,
  usesFlats,
  type FretNote,
  type Key,
  type Mode,
} from "./scales";

/**
 * The Solos view: the song's key, a scale picker, and the scale drawn on the neck
 * (all notes, or one position at a time) with its tablature. Rendering only; main.ts
 * owns the key detection and passes the state in.
 */

export type KeySource = "online" | "tab" | "signature" | "mic" | "manual";

export interface SolosState {
  /** "Artist – Title" of what's playing, or null. */
  song: string | null;
  key: Key | null;
  keySource: KeySource | null;
  confidence: number | null;
  /** Beats per minute of the recording, when the online lookup knows it. */
  tempo: number | null;
  /** The key is being looked up online right now. */
  lookingUp: boolean;
  /** Online lookup is available (inside the app). */
  canLookUp: boolean;
  /** Other likely keys, best first (from the last detection). */
  alternatives: Key[];
  scaleId: string;
  /** 0 = whole neck, otherwise a position number. */
  position: number;
  labels: "notes" | "degrees";
  /** MIDI pitches, string 1 (highest) first. */
  tuning: readonly number[];
  tuningName: string;
  /** A local tab is open, so its notes can be analysed. */
  canAnalyseTab: boolean;
  /** Listening: 0…1, or null when not listening. */
  listening: number | null;
  /** The microphone is available in this webview. */
  canListen: boolean;
  /** Why the last listen failed, if it did. */
  error: string | null;
  /** A camera can be opened in this webview. */
  canUseCamera: boolean;
}

export interface SolosActions {
  setKey(key: Key): void;
  setScale(id: string): void;
  setPosition(n: number): void;
  setLabels(l: SolosState["labels"]): void;
  lookUp(): void;
  listen(): void;
  stopListening(): void;
  analyseTab(): void;
  openCamera(): void;
}

const SOURCE_LABEL: Record<KeySource, string> = {
  online: "Looked up online (Spotify's analysis of the recording)",
  tab: "Detected from the local tab's notes",
  signature: "From the tab's key signature",
  mic: "Detected by listening",
  manual: "Set by you",
};

const NOTE_OPTIONS = Array.from({ length: 12 }, (_, i) => i);

/** Builds the page; call again with a new state to re-render it. */
export function renderSolos(root: HTMLElement, s: SolosState, act: SolosActions): void {
  const inner = document.createElement("div");
  inner.className = "page-inner solos";
  const key = s.key ?? { tonic: 9, mode: "minor" as Mode };
  const flats = usesFlats(key);
  const scale = scaleById(s.scaleId) ?? scaleById(defaultScaleFor(key))!;
  const notes = scaleNotes(key.tonic, scale.id, flats);
  const pos = positions(s.tuning, key.tonic, scale.id);
  const current = s.position > 0 ? pos.find((p) => p.number === s.position) ?? null : null;

  inner.innerHTML = `
    <div class="page-head"><h1>Solos</h1>${s.song ? `<span class="muted solos-song">${esc(s.song)}</span>` : ""}</div>
    <section class="solos-key card">
      <div class="solos-key-main">
        <div>
          <div class="solos-key-name">${s.key ? esc(keyName(s.key)) : "Key not detected"}</div>
          <div class="muted solos-key-sub">${keySubtitle(s)}</div>
        </div>
        <div class="solos-key-actions">
          ${s.canLookUp && s.song ? `<button class="btn${s.key ? "" : " primary"}" data-act="lookup" type="button"${s.lookingUp ? " disabled" : ""}>${s.lookingUp ? "Looking up…" : "Look up online"}</button>` : ""}
          ${s.canListen ? (s.listening != null ? `<button class="btn" data-act="stop" type="button">Stop listening</button>` : `<button class="btn" data-act="listen" type="button">Listen for key</button>`) : ""}
          ${s.canAnalyseTab ? `<button class="btn" data-act="tab" type="button">Detect from tab</button>` : ""}
        </div>
      </div>
      ${s.listening != null ? `<div class="solos-meter" role="progressbar" aria-label="Listening" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(s.listening * 100)}"><div style="width:${s.listening * 100}%"></div></div><p class="hint">Listening through the microphone for ${LISTEN_MS / 1000} s. Play the song out loud (speakers, not headphones).</p>` : ""}
      ${s.error ? `<p class="hint solos-error">${esc(s.error)}</p>` : ""}
      ${s.alternatives.length ? `<div class="solos-alt"><span class="muted">Also possible:</span>${s.alternatives.map((k, i) => `<button class="chip" type="button" data-alt="${i}">${esc(keyName(k))}</button>`).join("")}</div>` : ""}
      <div class="solos-pickers">
        <label class="select-row">Key
          <span class="solos-keypick">
            <select data-pick="tonic" aria-label="Key note">${NOTE_OPTIONS.map((p) => `<option value="${p}"${p === key.tonic ? " selected" : ""}>${pitchName(p, usesFlats({ tonic: p, mode: key.mode }))}</option>`).join("")}</select>
            <select data-pick="mode" aria-label="Major or minor"><option value="major"${key.mode === "major" ? " selected" : ""}>major</option><option value="minor"${key.mode === "minor" ? " selected" : ""}>minor</option></select>
          </span>
        </label>
        <label class="select-row">Scale
          <select data-pick="scale" aria-label="Scale">${SCALE_GROUPS.map(
            (g) => `<optgroup label="${esc(g)}">${SCALES.filter((x) => x.group === g)
              .map((x) => `<option value="${x.id}"${x.id === scale.id ? " selected" : ""}>${esc(x.name)}</option>`)
              .join("")}</optgroup>`,
          ).join("")}</select>
        </label>
      </div>
    </section>

    <section class="solos-notes">
      <h2>${esc(pitchName(key.tonic, flats))} ${esc(scale.name)}</h2>
      <ul class="solos-chips">${notes.map((n, i) => `<li class="${i === 0 ? "root" : ""}"><b>${esc(n.name)}</b><small>${esc(n.degree)}</small></li>`).join("")}</ul>
    </section>

    <section class="solos-neck-head">
      <div class="segmented" role="group" aria-label="Position">
        <button type="button" data-pos="0" aria-pressed="${s.position === 0}">Whole neck</button>
        ${pos.map((p) => `<button type="button" data-pos="${p.number}" aria-pressed="${s.position === p.number}" title="Frets ${p.minFret}–${p.maxFret}">${p.number}</button>`).join("")}
      </div>
      <div class="solos-neck-tools">
        <div class="segmented" role="group" aria-label="Labels">
          <button type="button" data-labels="notes" aria-pressed="${s.labels === "notes"}">Notes</button>
          <button type="button" data-labels="degrees" aria-pressed="${s.labels === "degrees"}">Degrees</button>
        </div>
        ${s.canUseCamera ? `<button class="btn small" type="button" data-act="camera" title="Show the scale over the camera picture of your guitar">On my guitar</button>` : ""}
      </div>
    </section>
    <div class="solos-neck">${neckSvg(s, key, scale.id, flats, current?.notes ?? null)}</div>
    <p class="hint">Tuning: ${esc(s.tuningName)}. Root notes are highlighted.</p>
    ${current ? `<section class="solos-tab"><h3>Position ${current.number} · frets ${current.minFret}–${current.maxFret}</h3><pre>${esc(positionTab(s.tuning, current.notes, flats))}</pre></section>` : `<p class="hint">Pick a position to see it as tablature, played up and back down.</p>`}
  `;

  inner.querySelector<HTMLButtonElement>("[data-act=lookup]")?.addEventListener("click", act.lookUp);
  inner.querySelector<HTMLButtonElement>("[data-act=listen]")?.addEventListener("click", act.listen);
  inner.querySelector<HTMLButtonElement>("[data-act=stop]")?.addEventListener("click", act.stopListening);
  inner.querySelector<HTMLButtonElement>("[data-act=tab]")?.addEventListener("click", act.analyseTab);
  inner.querySelector<HTMLButtonElement>("[data-act=camera]")?.addEventListener("click", act.openCamera);
  inner.querySelectorAll<HTMLButtonElement>("[data-alt]").forEach((b) => (b.onclick = () => act.setKey(s.alternatives[Number(b.dataset.alt)])));
  const tonic = inner.querySelector<HTMLSelectElement>("[data-pick=tonic]")!;
  const mode = inner.querySelector<HTMLSelectElement>("[data-pick=mode]")!;
  const pickKey = () => act.setKey({ tonic: Number(tonic.value), mode: mode.value === "major" ? "major" : "minor" });
  tonic.onchange = pickKey;
  mode.onchange = pickKey;
  inner.querySelector<HTMLSelectElement>("[data-pick=scale]")!.onchange = (e) => act.setScale((e.target as HTMLSelectElement).value);
  inner.querySelectorAll<HTMLButtonElement>("[data-pos]").forEach((b) => (b.onclick = () => act.setPosition(Number(b.dataset.pos))));
  inner.querySelectorAll<HTMLButtonElement>("[data-labels]").forEach((b) => (b.onclick = () => act.setLabels(b.dataset.labels === "degrees" ? "degrees" : "notes")));
  root.replaceChildren(inner);
}

function keySubtitle(s: SolosState): string {
  if (!s.key) {
    if (s.lookingUp) return "Looking up the song's key…";
    if (s.listening != null) return "Listening…";
    return s.canListen || s.canAnalyseTab ? "Look it up, listen to the song or analyse its tab, or pick the key below." : "Pick the key below.";
  }
  const bits = [s.keySource ? SOURCE_LABEL[s.keySource] : ""];
  if (s.confidence != null && s.keySource !== "manual" && s.keySource !== "signature" && s.keySource !== "online") bits.push(`${Math.round(s.confidence * 100)}% sure`);
  if (s.tempo) bits.push(`${Math.round(s.tempo)} BPM`);
  bits.push(`relative ${keyName(relativeKey(s.key))}`);
  return esc(bits.filter(Boolean).join(" · "));
}

/** First fret drawn: the nut. Last: 15, or further if a position reaches higher. */
function lastFret(tuning: readonly number[], root: number, scaleId: string): number {
  const top = Math.max(0, ...positions(tuning, root, scaleId).flatMap((p) => p.notes.map((n) => n.fret)));
  return Math.min(24, Math.max(15, top));
}

const INLAYS = [3, 5, 7, 9, 15, 17, 19, 21];

/** The neck as SVG, highest string on top like a tab staff. */
function neckSvg(s: SolosState, key: Key, scaleId: string, flats: boolean, focus: FretNote[] | null): string {
  const frets = lastFret(s.tuning, key.tonic, scaleId);
  const strings = s.tuning.length;
  const fw = 52; // fret width
  const sh = 26; // string spacing
  const left = 62; // room for string names and open-string notes
  const top = 18;
  const w = left + frets * fw + 12;
  const h = top + (strings - 1) * sh + 30;
  const x = (fret: number) => (fret === 0 ? left - 20 : left + (fret - 0.5) * fw);
  const y = (string: number) => top + string * sh;
  const degree = new Map(scaleNotes(key.tonic, scaleId, flats).map((n) => [n.pitch, n]));
  const inFocus = new Set(focus?.map((n) => `${n.string}:${n.fret}`));
  const parts: string[] = [];

  for (const f of INLAYS) if (f <= frets) parts.push(`<circle class="inlay" cx="${left + (f - 0.5) * fw}" cy="${top + ((strings - 1) * sh) / 2}" r="5"/>`);
  if (frets >= 12) for (const dy of [-1, 1]) parts.push(`<circle class="inlay" cx="${left + 11.5 * fw}" cy="${top + ((strings - 1) * sh) / 2 + dy * sh}" r="5"/>`);
  if (frets >= 24) for (const dy of [-1, 1]) parts.push(`<circle class="inlay" cx="${left + 23.5 * fw}" cy="${top + ((strings - 1) * sh) / 2 + dy * sh}" r="5"/>`);
  parts.push(`<rect class="nut" x="${left - 3}" y="${top - 1}" width="5" height="${(strings - 1) * sh + 2}"/>`);
  for (let f = 1; f <= frets; f++) {
    parts.push(`<line class="fret" x1="${left + f * fw}" y1="${top}" x2="${left + f * fw}" y2="${y(strings - 1)}"/>`);
    parts.push(`<text class="fret-no" x="${left + (f - 0.5) * fw}" y="${h - 6}">${f}</text>`);
  }
  stringLabels(s.tuning, flats).forEach((name, i) => {
    parts.push(`<line class="string" x1="${left}" y1="${y(i)}" x2="${left + frets * fw}" y2="${y(i)}" stroke-width="${1 + (i / Math.max(1, strings - 1)) * 1.4}"/>`);
    parts.push(`<text class="string-name" x="6" y="${y(i) + 4}">${esc(name)}</text>`);
  });
  for (const n of neckNotes(s.tuning, key.tonic, scaleId, frets)) {
    const d = degree.get(n.pitch % 12);
    if (!d) continue;
    const root = d.degree === "1";
    const dim = focus && !inFocus.has(`${n.string}:${n.fret}`);
    const label = s.labels === "degrees" ? d.degree : d.name;
    parts.push(
      `<g class="dot${root ? " root" : ""}${dim ? " dim" : ""}"><circle cx="${x(n.fret)}" cy="${y(n.string)}" r="11"/><text x="${x(n.fret)}" y="${y(n.string) + 4}">${esc(label)}</text></g>`,
    );
  }
  return `<svg class="neck" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Scale on the fretboard">${parts.join("")}</svg>`;
}

/** The scale as the camera view draws it on the user's guitar: same notes, position and labels as the neck. */
export function cameraScene(s: SolosState): CamScene {
  const key = s.key ?? { tonic: 9, mode: "minor" as Mode };
  const flats = usesFlats(key);
  const scale = scaleById(s.scaleId) ?? scaleById(defaultScaleFor(key))!;
  const pos = positions(s.tuning, key.tonic, scale.id);
  const current = s.position > 0 ? pos.find((p) => p.number === s.position) ?? null : null;
  const inFocus = new Set(current?.notes.map((n) => `${n.string}:${n.fret}`));
  const degree = new Map(scaleNotes(key.tonic, scale.id, flats).map((n) => [n.pitch, n]));
  const frets = lastFret(s.tuning, key.tonic, scale.id);
  return {
    title: `${pitchName(key.tonic, flats)} ${scale.name}`,
    strings: s.tuning.length,
    frets,
    dots: neckNotes(s.tuning, key.tonic, scale.id, frets).flatMap((n) => {
      const d = degree.get(n.pitch % 12);
      if (!d) return [];
      return [{ string: n.string, fret: n.fret, label: s.labels === "degrees" ? d.degree : d.name, root: d.degree === "1", dim: !!current && !inFocus.has(`${n.string}:${n.fret}`) }];
    }),
    positions: pos.map(({ number, minFret, maxFret }) => ({ number, minFret, maxFret })),
    position: current ? current.number : 0,
  };
}

/** Up to three other keys worth offering, from a detection's ranking. */
export function alternativesOf(r: KeyResult): Key[] {
  return r.ranking.slice(1, 4).map(({ tonic, mode }) => ({ tonic, mode }));
}

// ---- Persistence ----------------------------------------------------------------

export interface StoredKey extends Key {
  source: KeySource;
  /** BPM, kept with keys looked up online. */
  tempo?: number;
}

/** Validates stored keys: `{ [trackKey]: { tonic, mode, source, tempo? } }`. */
export function parseKeys(raw: unknown): Record<string, StoredKey> {
  const out: Record<string, StoredKey> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const k = v as Record<string, unknown>;
    const tonic = k.tonic;
    if (typeof tonic !== "number" || !Number.isInteger(tonic) || tonic < 0 || tonic > 11) continue;
    if (k.mode !== "major" && k.mode !== "minor") continue;
    const source = k.source === "mic" || k.source === "manual" || k.source === "online" ? k.source : null;
    if (!source) continue;
    const tempo = typeof k.tempo === "number" && Number.isFinite(k.tempo) && k.tempo > 0 ? k.tempo : undefined;
    out[id] = { tonic, mode: k.mode, source, ...(tempo ? { tempo } : {}) };
  }
  return out;
}

/**
 * Keys looked up online, heard or picked by hand, per song (library.ts trackKey),
 * so a song comes back in its key at once, even offline. Keys read from a tab are
 * not stored: the tab is analysed again when it opens.
 */
export class KeyStore {
  private items: Record<string, StoredKey>;

  constructor(
    private key = "tabsync.keys",
    private storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  ) {
    try {
      this.items = parseKeys(JSON.parse(this.storage.getItem(this.key) ?? "{}"));
    } catch {
      this.items = {};
    }
  }

  get(song: string): StoredKey | null {
    return this.items[song] ? { ...this.items[song] } : null;
  }

  set(song: string, k: StoredKey): void {
    this.items[song] = { tonic: k.tonic, mode: k.mode, source: k.source, ...(k.tempo ? { tempo: k.tempo } : {}) };
    this.save();
  }

  /** Drops a song's key, so its tab is analysed again. */
  forget(song: string): void {
    if (!(song in this.items)) return;
    delete this.items[song];
    this.save();
  }

  private save(): void {
    try {
      this.storage.setItem(this.key, JSON.stringify(this.items));
    } catch {
      /* storage unavailable: kept for this session only */
    }
  }
}
