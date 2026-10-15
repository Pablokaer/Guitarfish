<p align="center">
  <img src="assets/logo.png" alt="Guitarfish logo: a manta ray inside a guitar pick" width="280" />
</p>

<h1 align="center">Guitarfish</h1>

<p align="center">
  <b>The guitar tab of the song you're playing on Spotify, in time with the music.</b><br />
  macOS · Windows · Linux · Android · <a href="https://github.com/Pablokaer/Guitarfish/releases/latest">Download the latest release</a>
</p>

Guitarfish runs alongside Spotify. When the song changes, it detects the new track, finds a guitar tab for it and shows it: either the song's page on [Songsterr](https://www.songsterr.com) (desktop) or a tab you imported, rendered locally and scrolled in time with the song.

Everything runs on your device. There is no server to install: the app searches Songsterr itself, and your imported tabs are stored on the device.

| Platform | How it detects the song | Status |
|---|---|---|
| macOS | AppleScript query to the Spotify app (`osascript`) | ✅ |
| Windows | Windows media controls API (SMTC), the API behind the media overlay | ✅ |
| Linux | MPRIS over D-Bus, the interface the Spotify desktop app publishes | ✅ |
| Android | `MediaSessionManager`, after the user grants Notification access | ✅ |
| iOS | — (iOS can't read other apps' playback) | ❌ |

## Contents

- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [How it works, end to end](#how-it-works-end-to-end)
- [Repository layout](#repository-layout)
- [1. Desktop app (macOS, Windows, Linux)](#1-desktop-app-macos-windows-linux)
- [2. Android app](#2-android-app)
- [3. Your own tabs](#3-your-own-tabs)
- [4. Songsterr](#4-songsterr)
- [5. Tests, CI and releases](#5-tests-ci-and-releases)
- [Known limitations / next steps](#known-limitations--next-steps)

## Tech stack

| Layer | Technology | Role |
|---|---|---|
| App shell | [Tauri 2](https://v2.tauri.app) (Rust) | Native window, menus, IPC between the UI and native code, installers for macOS / Windows / Linux / Android. The `unstable` feature enables the child webviews used for Songsterr. |
| App UI | TypeScript + [Vite 7](https://vite.dev), no UI framework | Plain DOM code: detector loop, layout, sidebars, Spotify player, tab import, settings. |
| Tab rendering | [alphaTab](https://alphatab.net) (`@coderline/alphatab` + its Vite plugin) | Renders alphaTex, Guitar Pro 3–7 and MusicXML, and plays them with its built-in synthesizer (practice tools). Guitarfish adds bar-follow on top, using alphaTab's play order. |
| Song detection | Custom Tauri plugin `tauri-plugin-nowplaying` | Rust on desktop (AppleScript and an `objc2` notification observer on macOS, the `windows` crate's WinRT SMTC bindings on Windows, `zbus` MPRIS on Linux), Kotlin on Android. |
| Songsterr search | `songsterr_search` command in the Rust shell, [`ureq`](https://crates.io/crates/ureq) with rustls (ring) and bundled webpki roots | Calls Songsterr's public search; the webview can't (no CORS). Same code on desktop and Android, no platform TLS needed. |
| Tab catalogue | IndexedDB in the webview | Your imported songs, tab files and confirmed Spotify tracks, on the device. Matching (normalization + trigram similarity) runs in TypeScript. |
| External links | `@tauri-apps/plugin-opener` | Opens pages in the system browser (Songsterr on Android, fallbacks). |
| Notifications | `@tauri-apps/plugin-notification` | System notification when a new release is out. |
| In-app updates | `tauri-plugin-updater` + `tauri-plugin-process` (desktop only) | Downloads the signed update named in the release's `latest.json`, installs it and relaunches the app. |
| Tests | [Vitest](https://vitest.dev) (with `fake-indexeddb`), `cargo test` (plugin and app shell) | Unit tests for matching, normalization, the catalogue, import checks, the Songsterr command, layout, settings, library, status, follow timeline and practice logic. |
| E2E tests | [Playwright](https://playwright.dev) (Chromium) + Tauri's IPC mocks | Drives the built UI as inside Tauri, with the plugin and the Songsterr command scripted per test: song changes, local tabs, import, search, history, favorites, layout, Songsterr outages. |
| CI / CD | GitHub Actions, `tauri-apps/tauri-action` | Typecheck + tests on every push; release builds of `.dmg`, `.msi`/`.exe`, `.AppImage`/`.deb` and `.apk`. |

## Architecture

```
┌──────────────────────────────── Guitarfish app (Tauri 2) ────────────────────────────────┐
│                                                                                          │
│  Webview (TypeScript UI)                        invoke()   Rust core                     │
│  ┌──────────────────────────────────────┐    ───────────▶ ┌────────────────────────────┐ │
│  │ main.ts      UI, import, My tabs     │                 │ tauri-plugin-nowplaying    │ │
│  │ sync.ts      poll loop, lookups      │ ◀─────────────  │  macOS:   osascript        │ │
│  │ detector.ts  now-playing plugin      │    Track JSON   │  Windows: SMTC (WinRT)     │ │
│  │ songsterr.ts songsterr_search ───────┼──────────┐      │  Linux:   MPRIS (D-Bus)    │ │
│  │ match.ts     Songsterr match         │          │      │  Android: Kotlin plugin ───┼─┼─▶ MediaSessionManager
│  │ catalogue.ts IndexedDB catalogue     │          │      └────────────────────────────┘ │
│  │ matching.ts  ID → exact → fuzzy      │          │      ┌────────────────────────────┐ │
│  │ normalize.ts title/artist rules      │          └────▶ │ songsterr.rs (ureq, TLS)   │─┼─▶ songsterr.com/api/songs
│  │ tabfile.ts   import checks           │                 └────────────────────────────┘ │
│  │ viewer.ts    alphaTab                │                                                │
│  │ embed.ts     Songsterr view ─────────┼──▶ native child webview (songsterr.com)        │
│  └──────────────────┬───────────────────┘                                                │
│                     ▼                                                                    │
│      IndexedDB "guitarfish" (songs, tabs, files, links) · localStorage (settings, …)     │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Guitarfish is one program. The only network traffic is the Songsterr search (and Songsterr's pages), the release check against the GitHub API, the Spotify artwork shown in the player, and the built-in player's sound font, which ships with the app.

### The app

- **Rust shell** (`app/src-tauri/src/lib.rs`) registers the plugins (`opener`, `notification`, `nowplaying`, and on desktop `updater` and `process`) and the `songsterr_search` command. On macOS it also adds a *Layout* menu. The menu's keyboard shortcuts keep working while the Songsterr page has focus; the shell forwards each one to the UI as a `layout-command` event.
- **Songsterr search** (`app/src-tauri/src/songsterr.rs`): `songsterr_search(query) -> Vec<SongsterrResult>` calls `https://www.songsterr.com/api/songs?pattern=…&size=5` with a 5-second timeout, HTTPS only, on a blocking thread. It drops results Songsterr flags as junk, lists each song's instruments once, and returns `{ songId, title, artist, instruments, url }` with the stable link `https://www.songsterr.com/a/wa/song?id=…`. No tab content is fetched. The command is declared in the app manifest (`build.rs`), so it needs the `allow-songsterr-search` permission, which only the main window has (`capabilities/default.json`): the Songsterr pages in child webviews can't call it.
- **Now-playing plugin** (`app/plugins/tauri-plugin-nowplaying`) has the same commands on every platform:
  - `get_now_playing` returns `{ track }`, a `Track` with title, artist, album, duration, position, play state, Spotify ID, volume, artwork URL and player name.
  - `control` takes `{ action, value }`: play/pause, next, previous, seek (`value` in ms) and volume (`value` 0–100).
  - `get_capabilities` returns `{ transport, seek, volume, events }`: which of those controls work on this platform, and whether the plugin emits change events.
  - `check_permission` / `request_permission` matter on Android only.
  - Desktop reads run on a blocking thread so a slow `osascript`, WinRT or D-Bus call never stalls the async runtime.
  - On macOS the plugin observes Spotify's `com.spotify.client.PlaybackStateChanged` distributed notification, and on Linux the MPRIS `PropertiesChanged` signal. Each one emits the app event `nowplaying://changed` (no payload), and `get_capabilities` then reports `events: true`. A listener can call `get_now_playing` at once instead of waiting for the next poll.
  - On Android, a `NotificationListenerService` gives the app the right to list other apps' media sessions; the plugin then reads Spotify's (`com.spotify.music`) metadata and playback state.
- **UI** (`app/src`), plain TypeScript modules:
  - `main.ts` wires the modules below to the DOM: the views and all rendering, the import form and the My tabs page.
  - `sync.ts` (`SyncController`) runs the poll loop, the Songsterr search and the catalogue lookup for each new track.
  - `detector.ts` reads the now-playing plugin and its capabilities. Outside the app (a plain browser) it sees nothing.
  - `songsterr.ts` calls the `songsterr_search` command.
  - `catalogue.ts` is the on-device tab catalogue (IndexedDB): import, list, delete, lookup, search and confirmed links.
  - `normalize.ts` and `matching.ts` decide which catalogue song a track is (see below).
  - `tabfile.ts` checks a file to import and detects its format.
  - `match.ts` cleans Spotify titles and decides whether a Songsterr result is really the same song.
  - `update.ts` checks GitHub for a newer release; `selfupdate.ts` installs it on desktop.
  - `viewer.ts` wraps alphaTab: rendering, bar-follow and the built-in player used by the practice tools.
  - `score.ts` reads a loaded score without the DOM: its play order (through alphaTab's MIDI generator), and each track's tuning and capo.
  - `timeline.ts` turns the play order and tempo changes into bar times and finds the bar at a song position.
  - `practice.ts` holds the practice-tool logic: transpose and speed limits, tuning names, which cursor drives the view, and the per-tab settings store.
  - `embed.ts` positions the native Songsterr webview.
  - Every module except `main.ts`, `icons.ts` and `types.ts` has unit tests.

### Data on the device

- **IndexedDB**, database `guitarfish` (version 1), the tab catalogue:

  | Object store | Key | Contents |
  |---|---|---|
  | `songs` | `id` (auto) | `title`, `artist`, `durationMs`, `addedAt` |
  | `tabs` | `id` (auto), index `songId` | `songId`, `format` (`alphatex`, `gp`, `musicxml`), `name` (the imported file's name), `addedAt` |
  | `files` | `id` (the tab's id) | `data`: the file's bytes (`ArrayBuffer`), kept apart so listing songs never loads them |
  | `links` | `[provider, externalId]`, index `songId` | A Spotify track the user confirmed for a song: `{ provider: "spotify", externalId, songId }` |

  Normalized titles and artists aren't stored: they are computed when matching, so a change to the normalization rules applies to existing songs.
- **localStorage**: settings (`tabsync.settings`), layout, history and favorites (local only), "Wrong tab?" picks (`tabsync.songsterr.picks`) and practice settings per local tab (`tabsync.practice`). Older versions also stored a 7-day lookup cache and a library sync queue for the server; they are removed at start, with the server URL, Web API fallback and library sync settings.

## How it works, end to end

1. **Detect.** The UI calls `plugin:nowplaying|get_now_playing` every second.
   - When `get_capabilities` reports `events: true`, the plugin emits a `nowplaying://changed` Tauri event whenever the player reports a change (on macOS, Spotify's distributed notification). The UI then reads at once on each event and polls only every 5 seconds, moving the position forward locally between reads. Plugins without the field count as `events: false` and keep the 1-second polling.
   - Between reads the UI moves the last known position forward locally.
2. **Identify.** The track's identity is its Spotify ID when available (macOS, Linux), otherwise artist + title (Windows, Android). Nothing else happens until that identity changes.
3. **Find the Songsterr page** (desktop):
   1. If you previously corrected this song with *Wrong tab?*, your pick is used.
   2. Otherwise the app cleans the title (drops "- Remastered", "(feat. X)", etc.) and searches through the `songsterr_search` command.
   3. A result counts as **found** only when its title and one of the track's artists match after normalization. Otherwise the closest result is shown as *No confident match*.
   4. If the search fails (no connection, Songsterr not answering within 5 s, an error status), the status shows **Songsterr unreachable**, the app opens Songsterr's own search page, and the search is retried every 5 seconds until it works or the song changes.
4. **Look up your tabs.** At the same time, the app looks the track up in the IndexedDB catalogue, in three steps:
   1. a Spotify ID you have already confirmed for a song (confidence 1.0);
   2. an exact match on the normalized title and artist, trying each artist separately (0.97). Normalization drops "- Remastered 2011", "(feat. X)", "[Live]", accents, punctuation and a leading "The";
   3. a fuzzy trigram match: 65% title similarity + 35% artist similarity, then +0.05 if the song length is within 3 s, or −0.10 if it is more than 30 s off.

   A score of 0.82 or higher opens the tab automatically. Below that, the app lists candidates (score ≥ 0.35) under *Is it one of these?*, with *Import a tab for it…*. When you pick a song, its Spotify ID is linked to it on the device, so the next lookup is an exact hit.
5. **Show.**
   - **Songsterr view** (desktop default): Songsterr refuses iframes, so the page opens in a native child webview laid over the viewer area. Moving or resizing panels only repositions that webview; it never reloads the page.
   - **Local view:** alphaTab renders the tab. **Follow** works out which bar is playing:
     1. When a tab loads, `score.ts` runs alphaTab's MIDI generator (no audio, no DOM) and reads its tick lookup. That gives the bars in the order they are played, with repeats, alternate endings and D.C. / D.S. / Coda / Fine jumps expanded, plus every tempo change at its exact tick, including changes in the middle of a bar.
     2. `timeline.ts` turns this into a tempo map and the start and end time of each played bar.
     3. Every frame, the bar at the current song position (plus your offset) is highlighted and scrolled into the upper third of the view. A repeated chorus maps back to the same bars on each pass.
   - **Practice tools** (Tools sidebar → *Local tab* → *Practice*, desktop and Android):
     - **Tuning:** the shown track's open strings, low to high (e.g. `D A D G B E`), with its name when it is a known one (*Standard*, *Drop D*, *Half step down*, *Open G*, *DADGAD*…) and the capo, if any.
     - **Transpose** −12…+12 semitones, with *Reset*. It shifts the standard notation and the built-in player; tab fret numbers stay as written.
     - **Built-in player:** play/pause and stop, speed 25–200% (slider or presets), and *Loop*, which repeats the whole tab or only the bars you select by dragging across them. The sound font (`soundfont/sonivox.sf3`, copied by alphaTab's Vite plugin) is loaded on the first *Play*.
     - While the built-in player plays, its own cursor moves through the tab and Spotify follow pauses. When you pause or stop it, the view follows Spotify again.
     - Transpose and speed are saved for each local tab (by tab ID) in `tabsync.practice`.
6. **Import.** *Import tab…* (Tools sidebar → *My tabs*, the My tabs page, or *Import a tab for it…* when a song isn't in your tabs) asks for a file, the artist and the title.
   - With a song playing, artist and title are prefilled from it, and *Use it for the song playing now* links the song to the track's Spotify ID and opens the tab at once.
   - `tabfile.ts` takes the format from the extension and checks the content against it, then the tab goes to the song with the same normalized title and artist, or to a new song.
   - The **My tabs** page lists every song and tab file. *Delete* (then *Confirm delete*) removes a file; a song goes with its last file, together with its confirmed tracks.
7. **Control** (desktop): the Spotify player strip shows artwork, progress and volume. It drives Spotify through `plugin:nowplaying|control`: AppleScript on macOS (transport, seek, volume), SMTC on Windows (transport and seek; SMTC has no volume control) and MPRIS on Linux (transport, seek, volume). On Android the plugin drives Spotify's `MediaController` (transport and seek) once Notification access is granted.
8. **History and favorites** are kept in `localStorage` on each device: opening a Songsterr page adds it to the history (50 most recent), and the star saves it to the favorites.
9. **Updates.** At startup and every 6 hours, the app fetches the latest published release from the GitHub API (`releases/latest`) and compares it with its own version.
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
├── app/                            Tauri 2 app (desktop + Android)
│   ├── index.html, src/            UI (TypeScript + Vite), see "The app" above
│   ├── test/                       vitest tests for the UI modules
│   ├── e2e/                        Playwright end-to-end tests (Tauri IPC mocks in fixtures.ts, tauri-mock.ts)
│   ├── public/logo.png             logo (favicon and sidebar brand mark)
│   ├── src-tauri/                  Rust shell, tauri.conf.json, capabilities, icons
│   │   ├── src/lib.rs              plugins, menu, command registration
│   │   ├── src/songsterr.rs        songsterr_search command (Songsterr's public search, links only)
│   │   ├── build.rs                app manifest: songsterr_search needs a permission
│   │   └── permissions/            generated allow/deny permissions for the command
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

## 1. Desktop app (macOS, Windows, Linux)

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

That's all: there is nothing else to run. `tauri build` also signs the updater bundles, so it needs `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the environment (see [Updater signing](#5-tests-ci-and-releases)). `tauri dev` doesn't.

- **macOS:** the first time Guitarfish reads Spotify, macOS asks permission to control Spotify. If you click "Don't Allow" by mistake, re-enable it in System Settings → Privacy & Security → Automation. In `tauri dev` the prompt names your terminal app instead of Guitarfish.
- **Windows:** no setup needed. Works with the Spotify desktop installer and the Microsoft Store version. SMTC doesn't expose the Spotify track ID, so Windows matches by artist and title only.
- **Linux:** no setup needed. Guitarfish reads the Spotify desktop app (`.deb`, Snap or Flatpak) through MPRIS on the D-Bus session bus, including the Spotify track ID. The Spotify web player isn't detected.
- `npm run dev` alone serves the UI in a plain browser, which is handy for layout work, but nothing is detected there and Songsterr can't be searched: both need the app shell.

## 2. Android app

Prerequisites: Android Studio, an SDK and an NDK, plus the Rust Android targets. See the [Tauri Android setup](https://v2.tauri.app/start/prerequisites/#android).

```bash
cd app
npx tauri android init     # generates src-tauri/gen/android (once)
npm run tauri android dev  # device or emulator
npm run tauri android build
```

- On first launch, the app opens **Notification access**. Turn on *Guitarfish*, then go back to the app. Android only shares other apps' media sessions with apps that have this access.
- Nothing else to configure: Songsterr is searched over HTTPS from the app itself, and your tabs are stored on the phone. The app makes no plain-HTTP requests, so release builds keep Tauri's default of no cleartext traffic.
- To use it alongside Spotify, run Guitarfish in split-screen or as the foreground app. Spotify keeps playing in the background.
- Play/pause, next, previous and seek go through Spotify's media session, so they need Notification access too. Volume isn't offered (that is the phone's media volume, not Spotify's).
- Songsterr opens in the browser because child webviews are desktop-only. Your imported tabs open in the local viewer.
- *Import tab…* uses the system file picker. It shows all files there (Android filters by MIME type, which tab formats don't have); the app checks the extension after you choose.
- `cargo clippy --target aarch64-linux-android` compiles ring's C code (the TLS behind the Songsterr search), so it needs the NDK's clang: set `CC_aarch64_linux_android=$NDK_HOME/toolchains/llvm/prebuilt/<host>/bin/aarch64-linux-android24-clang` and `AR_aarch64_linux_android=$NDK_HOME/toolchains/llvm/prebuilt/<host>/bin/llvm-ar`. `tauri android build` sets this up itself.

## 3. Your own tabs

- Guitarfish shows tabs you import in its local viewer (alphaTab), scrolled in time with Spotify, with the practice tools.
- Supported files: Guitar Pro (`.gp`, `.gp3`–`.gp7`, `.gpx`), alphaTex (`.alphatex`, `.atex`) and MusicXML (`.musicxml`, `.xml`, compressed `.mxl`), up to 20 MB each. The format comes from the extension, and the content must match it (Guitar Pro header, ZIP or GPX container, a MusicXML score element, plain-text alphaTex).
- Import from the Tools sidebar (*My tabs* → *Import tab…*), the **My tabs** page, or the *Import a tab for it…* button shown when the playing song isn't in your tabs. Several files of the same song (e.g. rhythm and lead) are grouped under it; the *Local tab* card lets you switch between them.
- Tabs live in this device's IndexedDB: they aren't synced between devices, and uninstalling the app or clearing its data deletes them. Keep your original files.
- Tabs are copyrighted works. Import only tabs you created, tabs licensed to you, or tabs from a licensed provider.

## 4. Songsterr

- On desktop, Songsterr is the main viewer. Each new Spotify song opens its Songsterr page; turn off *Follow Spotify* in the Tools sidebar to keep the current page.
  - "Tablature found" is shown only when Songsterr's title and artist match the song. Otherwise the closest result is shown as *No confident match*.
  - *Wrong tab?* lets you pick another result, and that choice is remembered for the song.
  - When Songsterr can't be searched (offline, or Songsterr isn't answering), the status says **Songsterr unreachable** and the search is retried every 5 seconds. Your local tabs keep working.
  - On Android, Songsterr opens in the browser.
- Around the viewer are the Spotify player (expand, collapse to a strip, or hide), the navigation sidebar (Now Playing, Search, History, Favorites, My tabs, Recent Tabs; expanded, compact or hidden), the Tools sidebar and the toolbar.
  - Each sidebar has its own hide button, and the layout is saved.
  - **Focus Mode** (⌘⇧F, Esc to leave) hides everything but the tab.
  - Shortcuts are listed in the Tools sidebar and in the macOS *Layout* menu.
  - Hiding or resizing panels only moves the native Songsterr view; it never reloads the page.
- Songsterr blocks iframes, so the panel is a native child webview laid over the window. That needs Tauri's `unstable` feature (enabled in `src-tauri/Cargo.toml`) and the webview permissions in `src-tauri/capabilities/default.json`.
- The app only uses Songsterr's public search API for links; it never downloads or stores their tabs, and it doesn't modify their page.

## 5. Tests, CI and releases

- **Tests:** `npm test` in `app/` runs Vitest (`npm run coverage` also checks the coverage thresholds in `vitest.config.ts`). The catalogue tests run against `fake-indexeddb`. `cargo test` in `app/src-tauri` covers the Songsterr result parsing and query cleaning (`cargo test -- --ignored live_search` also calls the real Songsterr). `cargo test` in `app/plugins/tauri-plugin-nowplaying` covers the macOS output parser and control commands, and the MPRIS metadata mapping and control calls (those run on every OS).
- **E2E tests:** `app/e2e/` holds Playwright tests of the built UI in Chromium, made to behave as inside Tauri. `e2e/tauri-mock.ts` (bundled with esbuild and injected before the app) installs `mockIPC` and `mockWindows` from `@tauri-apps/api/mocks`, and answers every `invoke()` through `FakeTauri` in `e2e/fixtures.ts`: tests script what `get_now_playing` reports, what `songsterr_search` returns or whether it fails, and check what the app asked for (player controls, the Songsterr webview's URL). The catalogue is the browser's real IndexedDB, seeded with the app's own `Catalogue` class. No Spotify, Songsterr or network is needed. Run them with `npx playwright install chromium` once, then `npm run build && npm run e2e` in `app/` (they serve `dist/` with `vite preview` on port 4317, or `E2E_PORT`).
- **CI** (`.github/workflows/ci.yml`) runs on every push and pull request:
  - app typecheck, tests (with coverage thresholds) and build;
  - app E2E tests in Chromium; on failure the Playwright report is uploaded as a run artifact;
  - plugin and app shell tests, and `cargo clippy -D warnings`, on macOS, Windows and Linux (each OS compiles different detector code);
  - `cargo clippy` for the Android target, so the `#[cfg(mobile)]` code is checked before a release. It uses the runner's preinstalled NDK for ring's C code.
- **Code review** (`.github/workflows/code-review.yml`) also runs on every push and pull request:
  - `cargo fmt --check`. The rules are in `rustfmt.toml`; run `cargo fmt` before pushing.
  - `npm audit` of the app's runtime dependencies. It fails on high or critical advisories.
- **AI review** (`.github/workflows/ai-review.yml`): [Claude Code](https://github.com/anthropics/claude-code-action) reviews a pull request when it is opened, reopened or marked ready. It posts inline comments and one summary comment.
  - To review new pushes, add the `ai-review` label. The summary comment is updated in place, not posted again.
  - It's advisory: it never fails the PR. A failed review shows a warning on the workflow run.
  - It only runs when the repository secret `ANTHROPIC_API_KEY` is set, and the [Claude GitHub App](https://github.com/apps/claude) must be installed on the repository.
  - It's the only workflow with write access to pull requests.
- **Release** (`.github/workflows/release.yml`) first runs CI and Code review on the tagged commit with read-only tokens, and stops if either fails. Then it builds the installable apps and attaches them to a GitHub release: a universal `.dmg` for macOS, `.msi` and `.exe` installers for Windows, an `.AppImage` and a `.deb` for Linux (x86_64), and a universal `.apk` for Android.
  - It also attaches the signed updater bundles (`Guitarfish_universal.app.tar.gz`, the Windows installers and the Linux packages, each with a `.sig`) and generates `latest.json`, which installed desktop apps read to update themselves. Each desktop job merges its platforms into that file.
  1. Set the new version with `scripts/bump-version.sh 0.3.0`. It updates and stages `tauri.conf.json`, both `Cargo.toml` files, `app/package.json` and the three lockfiles. Commit them with `git commit` (not `git commit -a` or `git add -A`).
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

## Known limitations / next steps

- Follow mode assumes Spotify plays the song as written in the tab. Live versions, edits or a different tempo drift; use the offset slider to compensate. *Next: alphaTab's sync points to align the tab with a recording.*
- Only Spotify playing on this device is detected: not Spotify Connect playback on another device, and not the web player.
- Your tabs, history and favorites stay on each device; there is no sync or backup, and clearing the app's data deletes them. *Next: export and import of the catalogue.*
- Songsterr search needs an internet connection. Songsterr has no official API, so a change on their side can break the search until the app is updated (the status then shows *Songsterr unreachable*).
- Fuzzy matching scans every song in the catalogue, which is fine for thousands of personal tabs.
- Platforms without playback events (Windows, Android) poll the detector every second.
- Windows, Linux and Android support only Spotify. Removing the package, app-ID or bus-name filter would allow other players.
- The file picker on Android shows every file; the app refuses files that aren't tabs after you pick them.
- Tabs are copyrighted works. Only import tabs you created, tabs licensed to you, or tabs from a licensed provider.
