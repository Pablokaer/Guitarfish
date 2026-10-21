## Downloads

| Platform | File |
|---|---|
| **macOS** (Apple Silicon and Intel) | `Guitarfish_<version>_universal.dmg` |
| **Windows** | `Guitarfish_<version>_x64-setup.exe` or `Guitarfish_<version>_x64_en-US.msi` |
| **Linux** (x86_64) | `Guitarfish_<version>_amd64.AppImage` or `Guitarfish_<version>_amd64.deb` (Debian, Ubuntu) |
| **Android** 7.0+ | `Guitarfish_<version>_android_universal.apk` |

Guitarfish runs entirely on your device, with no server to install. It searches Songsterr itself (that needs an internet connection), and the tabs you import (Guitar Pro, alphaTex or MusicXML: Tools sidebar → *Import tab…*) are stored on the device.

It also plays your own MP3 files (*Music* in the sidebar): playlists, a speed control from 0.25× to 1.5× that keeps the pitch, and an A–B loop to practise one passage. Their tabs are found the same way as for Spotify songs.

### First launch

- **macOS:** these builds are not notarized yet. If macOS says the app is damaged or can't be opened, move it to Applications and run `xattr -cr /Applications/Guitarfish.app`, then open it again. Allow Guitarfish to control Spotify when asked.
- **Windows:** SmartScreen may warn about an unknown publisher. Choose *More info → Run anyway*.
- **Linux:** install the `.deb` with `sudo apt install ./Guitarfish_<version>_amd64.deb`, or make the AppImage executable (`chmod +x Guitarfish_*.AppImage`) and run it. Guitarfish reads the Spotify desktop app over MPRIS (D-Bus), so it needs no setup; the Spotify web player isn't detected.
- **Android:** allow installing from your browser or file manager, then turn on *Notification access* for Guitarfish when the app asks.
