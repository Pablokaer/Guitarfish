## Downloads

| Platform | File |
|---|---|
| **macOS** (Apple Silicon and Intel) | `Guitarfish_<version>_universal.dmg` |
| **Windows** | `Guitarfish_<version>_x64-setup.exe` or `Guitarfish_<version>_x64_en-US.msi` |
| **Android** 7.0+ | `Guitarfish_<version>_android_universal.apk` |

Guitarfish needs the **Guitarfish server** (`server/` in this repository) running on your computer or network: Songsterr search and the tab catalogue go through it. Set its address in the Tools sidebar (default `http://127.0.0.1:8787`).

### First launch

- **macOS:** these builds are not notarized yet. If macOS says the app is damaged or can't be opened, move it to Applications and run `xattr -cr /Applications/Guitarfish.app`, then open it again. Allow Guitarfish to control Spotify when asked.
- **Windows:** SmartScreen may warn about an unknown publisher. Choose *More info → Run anyway*.
- **Android:** allow installing from your browser or file manager, then turn on *Notification access* for Guitarfish when the app asks. Set the server address to your computer's LAN IP.
