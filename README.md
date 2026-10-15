<p align="center"><img src="assets/logo.png" alt="Guitarfish logo" width="160" /></p>

# Guitarfish

Guitarfish runs alongside Spotify. When the song changes, it detects the new track, finds a guitar tab for it and shows it: either the song's page on [Songsterr](https://www.songsterr.com) (desktop) or a tab from your own catalogue, rendered locally and scrolled in time with the song.

| Platform | How it detects the song | Status |
|---|---|---|
| macOS | AppleScript query to the Spotify app (`osascript`) | ✅ |
| Windows | Windows media controls API (SMTC), the API behind the media overlay | ✅ |
| Linux | MPRIS over D-Bus, the interface the Spotify desktop app publishes | ✅ |
| Android | `MediaSessionManager`, after the user grants Notification access | ✅ |
| Any platform (fallback) | Spotify Web API, called through the server | ✅ optional |
| iOS | — (iOS can't read other apps' playback) | ❌ |

## Contents

- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [How it works, end to end](#how-it-works-end-to-end)
- [Repository layout](#repository-layout)
- [1. Run the server](#1-run-the-server)
- [2. Desktop app (macOS, Windows, Linux)](#2-desktop-app-macos-windows-linux)
- [3. Android app](#3-android-app)
- [4. Spotify Web API fallback (optional)](#4-spotify-web-api-fallback-optional)
- [5. Songsterr](#5-songsterr)
- [6. Tests, CI and releases](#6-tests-ci-and-releases)
- [Known MVP limitations / next steps](#known-mvp-limitations--next-steps)

## Tech stack

| Layer | Technology | Role |
|---|---|---|
| App shell | [Tauri 2](https://v2.tauri.app) (Rust) | Native window, menus, IPC between the UI and native code, installers for macOS / Windows / Linux / Android. The `unstable` feature enables the child webviews used for Songsterr. |
| App UI | TypeScript + [Vite 7](https://vite.dev), no UI framework | Plain DOM code: detector loop, layout, sidebars, Spotify player, settings. |
| Tab rendering | [alphaTab](https://alphatab.net) (`@coderline/alphatab` + its Vite plugin) | Renders alphaTex, Guitar Pro 3–7 and MusicXML, and plays them with its built-in synthesizer (practice tools). Guitarfish adds bar-follow on top, using alphaTab's play order. |
| Song detection | Custom Tauri plugin `tauri-plugin-nowplaying` | Rust on desktop (AppleScript and an `objc2` notification observer on macOS, the `windows` crate's WinRT SMTC bindings on Windows, `zbus` MPRIS on Linux), Kotlin on Android. |
| External links | `@tauri-apps/plugin-opener` | Opens pages in the system browser (Songsterr on Android, fallbacks). |
| Notifications | `@tauri-apps/plugin-notification` | System notification when a new release is out. |
| In-app updates | `tauri-plugin-updater` + `tauri-plugin-process` (desktop only) | Downloads the signed update named in the release's `latest.json`, installs it and relaunches the app. |
| Server | Node 20+, TypeScript run by `tsx`, [Fastify 5](https://fastify.dev) + `@fastify/cors` | HTTP API: song matching, tab storage, Songsterr search proxy, Spotify OAuth. |
| Database | SQLite via `better-sqlite3` (WAL mode) | Songs, tabs (stored as BLOBs), confirmed Spotify IDs, Spotify tokens. File at `server/data/tabsync.db`. |
| External services | Spotify Web API (OAuth Authorization Code + PKCE), Songsterr public search | Optional now-playing fallback; finding Songsterr pages. |
| Tests | [Vitest](https://vitest.dev) (server + app), `cargo test` (plugin) | Unit tests for matching, normalization, API routes, layout, settings, library, status, follow timeline and practice logic. |
| E2E tests | [Playwright](https://playwright.dev) (Chromium) | Drives the built UI in a browser against a faked server and Spotify: song changes, local tabs, search, history, favorites, layout, settings, server outages. |
| CI / CD | GitHub Actions, `tauri-apps/tauri-action` | Typecheck + tests on every push; release builds of `.dmg`, `.msi`/`.exe`, `.AppImage`/`.deb` and `.apk`. |

## Architecture

```
┌───────────────────────── Guitarfish app (Tauri 2) ─────────────────────────┐
│                                                                          │
│  Webview (TypeScript UI)                     Rust core                   │
│  ┌───────────────────────────┐   invoke()   ┌──────────────────────────┐ │
│  │ main.ts    poll loop, UI  │ ───────────▶ │ tauri-plugin-nowplaying  │ │
│  │ detector.ts device+fallback│ ◀─────────── │  macOS:   osascript      │ │
│  │ api.ts     server client  │   Track JSON │  Windows: SMTC (WinRT)   │ │
│  │                           │              │  Linux:   MPRIS (D-Bus)  │ │
│  │ match.ts   Songsterr match│              │  Android: Kotlin plugin ─┼─┼─▶ MediaSessionManager
│  │ viewer.ts  alphaTab       │              └──────────────────────────┘ │
│  │ embed.ts   Songsterr view ├──▶ native child webview (songsterr.com)    │
│  └─────────────┬─────────────┘                                           │
└────────────────┼─────────────────────────────────────────────────────────┘
                 │ HTTP (fetch)
                 ▼
┌──────────────── Guitarfish server (Node + Fastify) ────────────────┐
│ app.ts       routes            matching.ts  ID → exact → fuzzy  │──▶ songsterr.com/api/songs
│ db.ts        SQLite            normalize.ts title/artist rules  │──▶ api.spotify.com (fallback)
└─────────────────────────────────────────────────────────────────┘
```

The app and the server are separate programs. The server can run on the same computer or on another machine on your network, so a phone can reach it over Wi-Fi.

### The app

- **Rust shell** (`app/src-tauri/src/lib.rs`) registers the two plugins (`opener`, `nowplaying`). On macOS it also adds a *Layout* menu. The menu's keyboard shortcuts keep working while the Songsterr page has focus; the shell forwards each one to the UI as a `layout-command` event.
- **Now-playing plugin** (`app/plugins/tauri-plugin-nowplaying`) has the same commands on every platform:
  - `get_now_playing` returns `{ track }`, a `Track` with title, artist, album, duration, position, play state, Spotify ID, volume, artwork URL and player name.
  - `control` takes `{ action, value }`: play/pause, next, previous, seek (`value` in ms) and volume (`value` 0–100).
  - `get_capabilities` returns `{ transport, seek, volume, events }`: which of those controls work on this platform, and whether the plugin emits change events.
  - `check_permission` / `request_permission` matter on Android only.
  - Desktop reads run on a blocking thread so a slow `osascript`, WinRT or D-Bus call never stalls the async runtime.
  - On macOS the plugin observes Spotify's `com.spotify.client.PlaybackStateChanged` distributed notification, and on Linux the MPRIS `PropertiesChanged` signal. Each one emits the app event `nowplaying://changed` (no payload), and `get_capabilities` then reports `events: true`. A listener can call `get_now_playing` at once instead of waiting for the next poll.
  - On Android, a `NotificationListenerService` gives the app the right to list other apps' media sessions; the plugin then reads Spotify's (`com.spotify.music`) metadata and playback state.
- **UI** (`app/src`), plain TypeScript modules:
  - `main.ts` wires the modules below to the DOM: the views and all rendering.
  - `sync.ts` (`SyncController`) runs the poll loop and the tab lookup for each new track.
  - `librarysync.ts` (`LibrarySync`) syncs history and favorites with the server through a queue of pending changes.
  - `update.ts` checks GitHub for a newer release; `selfupdate.ts` installs it on desktop.
  - `detector.ts` combines the device reading with the Web API fallback, and reads the plugin's capabilities.
  - `api.ts` is the HTTP client. It caches confident lookups in `localStorage` for 7 days.
  - `match.ts` cleans Spotify titles and decides whether a Songsterr result is really the same song.
  - `viewer.ts` wraps alphaTab: rendering, bar-follow and the built-in player used by the practice tools.
  - `score.ts` reads a loaded score without the DOM: its play order (through alphaTab's MIDI generator), and each track's tuning and capo.
  - `timeline.ts` turns the play order and tempo changes into bar times and finds the bar at a song position.
  - `practice.ts` holds the practice-tool logic: transpose and speed limits, tuning names, which cursor drives the view, and the per-tab settings store.
  - `embed.ts` positions the native Songsterr webview.
  - `layout.ts`, `settings.ts`, `library.ts` (history and favorites), `status.ts`, `timeline.ts` and `practice.ts` are pure modules, each with unit tests.
  - Per-device state lives in the webview's `localStorage`: settings, layout, history, favorites, pending library changes, "Wrong tab?" picks and practice settings per local tab (`tabsync.practice`). History and favorites are also synced through the server (see *Sync*, below); `localStorage` is their offline copy.

### The server

- `index.ts` reads `PORT` (default `8787`), `HOST` (default `0.0.0.0`), `DB_FILE`, `SPOTIFY_CLIENT_ID` and `SPOTIFY_REDIRECT_URI`, opens the database and starts Fastify.
- `app.ts` defines the routes. CORS is open because the Tauri webview has its own origin. Raw request bodies are accepted for uploading tab files, including binary Guitar Pro files.
- `db.ts` creates five tables (with `CREATE TABLE IF NOT EXISTS`, so an existing database gains new tables on the next start):

  | Table | Contents |
  |---|---|
  | `songs` | title, artist, their normalized forms, duration, ISRC |
  | `song_external_ids` | Spotify track ID → song, filled when a user confirms a match |
  | `tabs` | file content as a BLOB, format (`alphatex`, `gp`, `musicxml`), instrument, tuning, rating, placeholder flag |
  | `settings` | key/value store, used for the Spotify tokens |
  | `library_entries` | history and favorites shared by all devices: one row per list and Songsterr song, either an entry (`at`) or a removal tombstone (`deleted_at`) |

- `normalize.ts` and `matching.ts` do the song lookup (see below).
- `songsterr.ts` calls Songsterr's public search and returns links only. No tab content is copied.
- `library.ts` merges history and favorites pushed by devices: for each song the newest timestamp wins, and a removal beats an add with the same timestamp. History keeps the 50 most recent entries; favorites are not capped. Removals are kept (the 500 most recent per list) so a device that was offline can't bring a removed favorite back.
- `spotify.ts` runs the OAuth PKCE flow, refreshes tokens and reads `me/player/currently-playing`.

## How it works, end to end

1. **Detect.** The UI calls `plugin:nowplaying|get_now_playing` every second.
   - When `get_capabilities` reports `events: true`, the plugin emits a `nowplaying://changed` Tauri event whenever the player reports a change (on macOS, Spotify's distributed notification). The UI then reads at once on each event and polls only every 5 seconds, moving the position forward locally between reads. Plugins without the field count as `events: false` and keep the 1-second polling.
   - If the device reports nothing and the fallback is on, it asks the server for `/v1/spotify/now-playing`, at most every 3 seconds.
   - Between those calls it moves the last known position forward locally.
2. **Identify.** The track's identity is its Spotify ID when available (macOS, Linux, Web API), otherwise artist + title (Windows, Android). Nothing else happens until that identity changes.
3. **Find the Songsterr page** (desktop):
   1. If you previously corrected this song with *Wrong tab?*, your pick is used.
   2. Otherwise the app cleans the title (drops "- Remastered", "(feat. X)", etc.) and searches through `/v1/songsterr/search`.
   3. A result counts as **found** only when its title and one of the track's artists match after normalization. Otherwise the closest result is shown as *No confident match*.
   4. If the server is unreachable, the app opens Songsterr's own search page and keeps retrying.
4. **Look up the local catalogue.** At the same time, the app calls `GET /v1/tabs/lookup?title&artist&durationMs&spotifyId`. The server tries three steps in order:
   1. a Spotify ID the user has already confirmed (confidence 1.0);
   2. an exact match on the normalized title and artist, trying each artist separately (0.97). Normalization drops "- Remastered 2011", "(feat. X)", "[Live]", accents, punctuation and a leading "The";
   3. a fuzzy trigram match: 65% title similarity + 35% artist similarity, then +0.05 if the song length is within 3 s, or −0.10 if it is more than 30 s off.

   A score of 0.82 or higher opens the tab automatically. Below that, the app lists candidates (score ≥ 0.35) and a search box. When the user picks a song, the Spotify ID is saved, so the next lookup is an exact hit.
5. **Show.**
   - **Songsterr view** (desktop default): Songsterr refuses iframes, so the page opens in a native child webview laid over the viewer area. Moving or resizing panels only repositions that webview; it never reloads the page.
   - **Local view:** alphaTab renders the tab. **Follow** works out which bar is playing:
     1. When a tab loads, `score.ts` runs alphaTab's MIDI generator (no audio, no DOM) and reads its tick lookup. That gives the bars in the order they are played, with repeats, alternate endings and D.C. / D.S. / Coda / Fine jumps expanded, plus every tempo change at its exact tick, including changes in the middle of a bar.
     2. `timeline.ts` turns this into a tempo map and the start and end time of each played bar.
     3. Every frame, the bar at the current song position (plus your offset) is highlighted and scrolled into the upper third of the view. A repeated chorus maps back to the same bars on each pass.
   - **Practice tools** (Tools sidebar → *Local tab* → *Practice*, desktop and Android):
     - **Tuning:** the shown track's open strings, low to high (e.g. `D A D G B E`), with its name when it is a known one (*Standard*, *Drop D*, *Half step down*, *Open G*, *DADGAD*…) and the capo, if any.
     - **Transpose** −12…+12 semitones, with *Reset*. It shifts the standard notation and the built-in player; tab fret numbers stay as written.
     - **Built-in player:** play/pause and stop, speed 25–200% (slider or presets), and *Loop*, which repeats the whole tab or only the bars you select by dragging across them. The sound font (`soundfont/sonivox.sf3`, copied by alphaTab's Vite plugin) is fetched on the first *Play*.
     - While the built-in player plays, its own cursor moves through the tab and Spotify follow pauses. When you pause or stop it, the view follows Spotify again.
     - Transpose and speed are saved for each local tab (by tab ID) in `tabsync.practice`.
6. **Control** (desktop): the Spotify player strip shows artwork, progress and volume. It drives Spotify through `plugin:nowplaying|control`: AppleScript on macOS (transport, seek, volume), SMTC on Windows (transport and seek; SMTC has no volume control) and MPRIS on Linux (transport, seek, volume). On Android the plugin drives Spotify's `MediaController` (transport and seek) once Notification access is granted.
7. **Sync.** History and favorites are shared by every device that uses the same server (Tools → *Sync history & favorites*, on by default).
   - Each local change updates the `localStorage` lists at once and is queued in `tabsync.library.pending`: opening a tab queues the entry with the current time, saving a favorite queues the entry, unsaving it or clearing history queues a `{ songId, deletedAt }` removal. The queue keeps one change per song (the newest), so it survives restarts and offline use without growing.
   - The first sync on a device (and after changing the server) also queues the full local lists (`tabsync.library.seeded` records that it happened). Repeating it is harmless: the server keeps the newest change per song.
   - A sync posts the queue to `POST /v1/library/sync` in batches of at most 500 changes per list, then replaces the local lists with the merged lists the server returns, re-applying any change made while the request was out. With nothing queued it just reads `GET /v1/library`.
   - It runs at startup, 2 seconds after local changes, every minute and when the window regains focus. If the server can't be reached the queue is kept for the next attempt (the Tools sidebar shows *Offline, will sync*); a batch the server rejects as malformed (400) is dropped so it can't block the rest.
8. **Updates.** At startup and every 6 hours, the app fetches the latest published release from the GitHub API (`releases/latest`) and compares it with its own version.
   - When the release is newer, it shows a system notification and a banner.
   - Each version is announced once (`tabsync.update.announced` in `localStorage`).
   - Drafts and pre-releases are ignored. Network errors are silent.
   - **Desktop:** the banner button is *Install and restart*. The Tauri updater reads `latest.json` from the latest release, downloads the update for this platform, checks its signature against the public key in `tauri.conf.json`, installs it (on Windows the installer runs in passive mode) and relaunches the app. The banner shows the download progress.
   - If that fails, for example because the release has no `latest.json` (releases made before in-app updates) or the signature doesn't match, the release page opens in the browser instead.
   - **Android:** the banner button is *Download*, which opens the release page with the `.apk`. The updater plugin doesn't support Android.
   - The rules (which button, progress text, fallback) are in `selfupdate.ts`; `main.ts` only connects them to the plugins.

## Repository layout

```
guitarfish/
├── server/                         Tab lookup API (Node + TypeScript + Fastify + SQLite)
│   ├── src/index.ts                entry point, environment variables
│   ├── src/app.ts                  HTTP routes
│   ├── src/db.ts                   SQLite schema and queries
│   ├── src/normalize.ts            title/artist normalization + trigram similarity
│   ├── src/matching.ts             lookup: external ID → exact → fuzzy; free-text search
│   ├── src/songsterr.ts            Songsterr search (links only)
│   ├── src/spotify.ts              optional Spotify Web API fallback (PKCE, tokens stored server-side)
│   ├── scripts/seed.ts             demo songs with PLACEHOLDER exercise tabs
│   ├── scripts/import.ts           import your own .gp / .alphatex / .musicxml tabs
│   └── test/                       vitest tests
├── app/                            Tauri 2 app (desktop + Android)
│   ├── index.html, src/            UI (TypeScript + Vite), see "The app" above
│   ├── test/                       vitest tests for the pure UI modules
│   ├── e2e/                        Playwright end-to-end tests (fake server in fixtures.ts)
│   ├── public/logo.png             logo (favicon and sidebar brand mark)
│   ├── src-tauri/                  Rust shell, tauri.conf.json, capabilities, icons
│   └── plugins/tauri-plugin-nowplaying/
│       ├── src/desktop.rs          macOS (AppleScript + change observer) + Windows (SMTC) detectors and controls
│       ├── src/desktop/linux.rs    Linux detector and controls (MPRIS over D-Bus, zbus)
│       ├── src/mpris.rs            MPRIS metadata → Track mapping (pure, tested on every OS)
│       ├── src/mobile.rs           bridge to the Kotlin plugin
│       └── android/                Kotlin plugin + NotificationListenerService
├── assets/                         logo.png (project logo), logo-1024.png (desktop icon source),
│                                   android-icon.png (Android icon source)
├── scripts/bump-version.sh         sets the version in every manifest and lockfile
└── .github/workflows/              ci.yml, code-review.yml, ai-review.yml, release.yml
```

### Icons

- **Desktop** (`app/src-tauri/icons/`, everything except `android/`): generated from `assets/logo-1024.png` with `cd app && npx tauri icon ../assets/logo-1024.png`. The favicon and sidebar logo are `app/public/logo.png`.
- **Android** (`app/src-tauri/icons/android/`): generated from `assets/android-icon.png` with `npx tauri icon ... -o <tmp>`, copying only its `android/` folder.
  - The adaptive-icon foregrounds were then redrawn so the pick fits inside the launcher's safe zone (58% of the canvas).
  - The background color is `#051426`, set in `values/ic_launcher_background.xml`.
  - Running `tauri icon` with the desktop logo overwrites `android/`, so keep or restore that folder.

## 1. Run the server

Requires Node 20 or later.

```bash
cd server
npm install
npm run seed      # 10 demo songs, each with a PLACEHOLDER exercise tab
npm run dev       # http://0.0.0.0:8787 (restarts on change)
npm test
```

> The seeded tabs are **generic practice exercises** (open chords and a C major scale). They are *not* the real tabs of those songs; they only let you test the whole flow by playing one of the demo songs on Spotify. Replace them with tabs you have the rights to use.

Import your own tab:

```bash
npm run import -- --artist "Artist" --title "Song" --file ./song.gp
npm run import -- --artist "Artist" --title "Song" --file ./song.alphatex --spotify-id <trackId>
```

Environment variables: `PORT` (8787), `HOST` (0.0.0.0), `DB_FILE` (`server/data/tabsync.db`), `SPOTIFY_CLIENT_ID`, `SPOTIFY_REDIRECT_URI`.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check |
| GET | `/v1/tabs/lookup?title&artist&durationMs&spotifyId` | Match a track → `{ match, confidence, method, candidates }` |
| GET | `/v1/tabs/:id/content` | Raw tab file (`X-Tab-Format` header) |
| GET | `/v1/songs?q=` | Free-text search |
| GET | `/v1/songs/:id` | One song with its tabs |
| POST | `/v1/songs` | Create a song `{ title, artist, durationMs? }` |
| POST | `/v1/songs/:id/tabs?format=gp\|alphatex\|musicxml` | Upload a tab (raw body) |
| POST | `/v1/songs/:id/external-ids` | Confirm a match `{ provider: "spotify", externalId }` |
| GET | `/v1/songsterr/search?q=` | Songsterr search results (links only) |
| GET | `/v1/library` | Synced history and favorites → `{ history: TabEntry[], favorites: TabEntry[] }`, newest first |
| POST | `/v1/library/sync` | Push changes `{ history?, favorites? }`, each a list of entries `{ url, songId, title, artist, at }` or removals `{ songId, deletedAt }` (at most 500 per list); returns the merged lists |
| GET | `/auth/spotify/login` · `/auth/spotify/callback` · `/auth/spotify/status` | Spotify fallback: sign-in and status |
| POST | `/auth/spotify/logout` | Forget the stored Spotify tokens |
| GET | `/v1/spotify/now-playing` | Current track from the Spotify Web API |

## 2. Desktop app (macOS, Windows, Linux)

Prerequisites: [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/). That means Rust, plus Xcode Command Line Tools on macOS, the MSVC Build Tools and WebView2 on Windows, or the WebKitGTK and D-Bus development packages on Linux. On Debian or Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev \
  libssl-dev libdbus-1-dev patchelf build-essential file
```

```bash
cd app
npm install
npm run tauri dev          # development (Vite on :1420 + the Rust shell)
npm run tauri build        # installer: .dmg/.app (macOS), .msi/.exe (Windows), .AppImage/.deb/.rpm (Linux)
```

`tauri build` also signs the updater bundles, so it needs `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the environment (see [Updater signing](#6-tests-ci-and-releases)). `tauri dev` doesn't.

- **macOS:** the first time Guitarfish reads Spotify, macOS asks permission to control Spotify. If you click "Don't Allow" by mistake, re-enable it in System Settings → Privacy & Security → Automation. In `tauri dev` the prompt names your terminal app instead of Guitarfish.
- **Windows:** no setup needed. Works with the Spotify desktop installer and the Microsoft Store version. SMTC doesn't expose the Spotify track ID, so Windows matches by artist and title only.
- **Linux:** no setup needed. Guitarfish reads the Spotify desktop app (`.deb`, Snap or Flatpak) through MPRIS on the D-Bus session bus, including the Spotify track ID. The Spotify web player isn't detected; use the Web API fallback for it.
- In the **Tools** sidebar, the server URL defaults to `http://127.0.0.1:8787`.

## 3. Android app

Prerequisites: Android Studio, an SDK and an NDK, plus the Rust Android targets. See the [Tauri Android setup](https://v2.tauri.app/start/prerequisites/#android).

```bash
cd app
npx tauri android init     # generates src-tauri/gen/android (once)
npm run tauri android dev  # device or emulator
npm run tauri android build
```

- On first launch, the app opens **Notification access**. Turn on *Guitarfish*, then go back to the app. Android only shares other apps' media sessions with apps that have this access.
- In Settings, set the server URL to your computer's LAN IP (e.g. `http://192.168.1.20:8787`). The emulator uses `http://10.0.2.2:8787`, which is the default there.
- Release builds block plain HTTP by default. Either serve the API over HTTPS, or allow cleartext traffic for your server in the generated Android manifest. The release workflow already does the latter.
- To use it alongside Spotify, run Guitarfish in split-screen or as the foreground app. Spotify keeps playing in the background.
- Play/pause, next, previous and seek go through Spotify's media session, so they need Notification access too. Volume isn't offered (that is the phone's media volume, not Spotify's).
- Songsterr opens in the browser because child webviews are desktop-only.

## 4. Spotify Web API fallback (optional)

Only used when the device sees nothing, e.g. when you're controlling playback on another device via Spotify Connect, or listening in the web player.

1. Create an app at <https://developer.spotify.com/dashboard> and select the *Web API*.
2. Add this exact redirect URI: `http://127.0.0.1:8787/auth/spotify/callback`. Spotify requires `127.0.0.1` here; `localhost` won't work.
3. Start the server with your Client ID (no client secret is needed, thanks to PKCE):
   ```bash
   SPOTIFY_CLIENT_ID=xxxx npm run dev
   ```
4. Open `http://127.0.0.1:8787/auth/spotify/login` in a browser **on the server machine** (or use Settings → *Connect Spotify* from the desktop app). The server stores the tokens in SQLite, refreshes them itself, and every client uses them.

The server requests the scopes `user-read-currently-playing` and `user-read-playback-state`. Development Mode requires the app owner to have Spotify Premium and allows up to 5 users. This MVP supports one Spotify account per server.

## 5. Songsterr

- On desktop, Songsterr is the main viewer. Each new Spotify song opens its Songsterr page; turn off *Follow Spotify* in the Tools sidebar to keep the current page.
  - "Tablature found" is shown only when Songsterr's title and artist match the song. Otherwise the closest result is shown as *No confident match*.
  - *Wrong tab?* lets you pick another result, and that choice is remembered for the song.
  - On Android, Songsterr opens in the browser.
- Around the viewer are the Spotify player (expand, collapse to a strip, or hide), the navigation sidebar (History, Favorites, Recent Tabs; expanded, compact or hidden), the Tools sidebar and the toolbar.
  - Each sidebar has its own hide button, and the layout is saved.
  - **Focus Mode** (⌘⇧F, Esc to leave) hides everything but the tab.
  - Shortcuts are listed in the Tools sidebar and in the macOS *Layout* menu.
  - Hiding or resizing panels only moves the native Songsterr view; it never reloads the page.
- Songsterr blocks iframes, so the panel is a native child webview laid over the window. That needs Tauri's `unstable` feature (enabled in `src-tauri/Cargo.toml`) and the webview permissions in `src-tauri/capabilities/default.json`.
- The server only uses Songsterr's public search; it never downloads or stores their tabs, and the app doesn't modify their page.

## 6. Tests, CI and releases

- **Tests:** `npm test` in `server/` and in `app/` runs Vitest. `cargo test` in `app/plugins/tauri-plugin-nowplaying` covers the macOS output parser and control commands, and the MPRIS metadata mapping and control calls (those run on every OS).
- **E2E tests:** `app/e2e/` holds Playwright tests of the UI running in a plain browser (Chromium), where the app uses the Spotify Web API fallback and the local catalogue view. Each test fakes the Guitarfish server and Spotify with `page.route` (`e2e/fixtures.ts`), so no server, Spotify account or network is needed. Run them with `npx playwright install chromium` once, then `npm run build && npm run e2e` in `app/` (they serve `dist/` with `vite preview` on port 4317, or `E2E_PORT`).
- **CI** (`.github/workflows/ci.yml`) runs on every push and pull request:
  - server typecheck and tests;
  - app typecheck, tests and build;
  - app E2E tests in Chromium; on failure the Playwright report is uploaded as a run artifact;
  - plugin tests and `cargo clippy -D warnings` on macOS, Windows and Linux (each OS compiles different detector code);
  - `cargo clippy` for the Android target, so the `#[cfg(mobile)]` code is checked before a release.
- **Code review** (`.github/workflows/code-review.yml`) also runs on every push and pull request:
  - `cargo fmt --check`. The rules are in `rustfmt.toml`; run `cargo fmt` before pushing.
  - `npm audit` of the server's and the app's runtime dependencies. It fails on high or critical advisories.
- **AI review** (`.github/workflows/ai-review.yml`): [Claude Code](https://github.com/anthropics/claude-code-action) reviews a pull request when it is opened, reopened or marked ready. It posts inline comments and one summary comment.
  - To review new pushes, add the `ai-review` label. The summary comment is updated in place, not posted again.
  - It's advisory: it never fails the PR. A failed review shows a warning on the workflow run.
  - It only runs when the repository secret `ANTHROPIC_API_KEY` is set, and the [Claude GitHub App](https://github.com/apps/claude) must be installed on the repository.
  - It's the only workflow with write access to pull requests.
- **Release** (`.github/workflows/release.yml`) first runs CI and Code review on the tagged commit with read-only tokens, and stops if either fails. Then it builds the installable apps and attaches them to a GitHub release: a universal `.dmg` for macOS, `.msi` and `.exe` installers for Windows, an `.AppImage` and a `.deb` for Linux (x86_64), and a universal `.apk` for Android.
  - It also attaches the signed updater bundles (`Guitarfish_universal.app.tar.gz`, the Windows installers and the Linux packages, each with a `.sig`) and generates `latest.json`, which installed desktop apps read to update themselves. Each desktop job merges its platforms into that file.
  1. Set the new version with `scripts/bump-version.sh 0.3.0`. It updates `tauri.conf.json`, both `Cargo.toml` files, both `package.json` files and all four lockfiles. Commit the result.
  2. Push a matching tag: `git tag v0.3.0 && git push origin v0.3.0`. Every build runs, and the release is published when all succeed.

  You can also run *Release* by hand from the Actions tab:
  - By default it builds into a **draft** release, and publishes it only if you tick *publish*.
  - Tick *build_only* to keep the installers as run artifacts without creating or changing any release.
- **Android signing:** add these repository secrets:
  - `ANDROID_KEYSTORE_BASE64` (from `base64 -i release.jks`)
  - `ANDROID_KEYSTORE_PASSWORD`
  - `ANDROID_KEY_ALIAS`
  - `ANDROID_KEY_PASSWORD`

  Without them, each release is signed with a one-off key, so updating needs an uninstall first. Create a keystore once with `keytool -genkeypair -v -keystore release.jks -alias guitarfish -keyalg RSA -keysize 2048 -validity 10000` and keep it safe: losing it means users must reinstall.
- **Updater signing:** desktop builds sign their updater bundles with these repository secrets:
  - `TAURI_SIGNING_PRIVATE_KEY` (the contents of the key file made by `npx tauri signer generate -w ~/.tauri/guitarfish-updater.key`)
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

  The matching public key is `plugins.updater.pubkey` in `tauri.conf.json`. Keep the private key safe: if it is lost, installed apps can't verify any new update and users have to download the next release by hand (and get an app with a new public key). A local `npm run tauri build` needs the same two variables set, or it stops with a missing private key error.
- **macOS signing (optional):** the builds are not notarized, so the first launch needs `xattr -cr /Applications/Guitarfish.app`. To sign and notarize, add the `APPLE_*` secrets listed in the workflow and pass them to the Tauri step.

## Known MVP limitations / next steps

- Follow mode assumes Spotify plays the song as written in the tab. Live versions, edits or a different tempo drift; use the offset slider to compensate. *Next: alphaTab's sync points to align the tab with a recording.*
- Fuzzy matching scans every song in memory, which is fine up to a few tens of thousands of songs. *Next: Postgres + `pg_trgm`, which uses the same similarity metric.*
- Platforms without playback events (Windows, Android) poll the detector every second.
- Windows, Linux and Android support only Spotify. Removing the package, app-ID or bus-name filter would allow other players.
- No authentication on the API. Add it before exposing the server outside your network.
- Tabs are copyrighted works. Only serve tabs you created, tabs licensed to you, or tabs from a licensed provider.
