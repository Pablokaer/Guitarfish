package com.tabsync.nowplaying

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.SystemClock
import android.provider.Settings
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * The service behind a media session, as `sources::Service` on desktop: the
 * `service` field of a track, and its rank when several sessions play (YouTube first).
 */
private enum class Service(val id: String, val rank: Int) {
    YOUTUBE("youtube", 3),
    YOUTUBE_MUSIC("youtube-music", 3),
    BROWSER("browser", 2),
    SPOTIFY("spotify", 1),
}

private data class App(val service: Service, val name: String)

/** The apps whose sessions are followed, by package. */
private val APPS = mapOf(
    "com.google.android.youtube" to App(Service.YOUTUBE, "YouTube"),
    "app.revanced.android.youtube" to App(Service.YOUTUBE, "YouTube"),
    "com.vanced.android.youtube" to App(Service.YOUTUBE, "YouTube"),
    "org.schabi.newpipe" to App(Service.YOUTUBE, "NewPipe"),
    "com.google.android.apps.youtube.music" to App(Service.YOUTUBE_MUSIC, "YouTube Music"),
    "app.revanced.android.apps.youtube.music" to App(Service.YOUTUBE_MUSIC, "YouTube Music"),
    "com.spotify.music" to App(Service.SPOTIFY, "Spotify"),
    // Browsers: YouTube (or other media) in a tab. The session doesn't say which site.
    "com.android.chrome" to App(Service.BROWSER, "Chrome"),
    "com.chrome.beta" to App(Service.BROWSER, "Chrome"),
    "org.mozilla.firefox" to App(Service.BROWSER, "Firefox"),
    "com.brave.browser" to App(Service.BROWSER, "Brave"),
    "com.microsoft.emmx" to App(Service.BROWSER, "Edge"),
    "com.sec.android.app.sbrowser" to App(Service.BROWSER, "Samsung Internet"),
    "com.opera.browser" to App(Service.BROWSER, "Opera"),
    "com.vivaldi.browser" to App(Service.BROWSER, "Vivaldi"),
    "com.duckduckgo.mobile.android" to App(Service.BROWSER, "DuckDuckGo"),
)

/** Arguments of `control`, the same shape as on desktop: `{ action, value }`. */
@InvokeArg
class ControlArgs {
    /** "playpause" | "next" | "previous" | "seek" (value = position in ms). */
    var action: String = ""
    var value: Double? = null
}

@TauriPlugin
class NowPlayingPlugin(private val activity: Activity) : Plugin(activity) {

    /** True when the user has granted notification access to this app. */
    private fun hasAccess(): Boolean {
        val enabled = Settings.Secure.getString(
            activity.contentResolver, "enabled_notification_listeners"
        ) ?: return false
        val me = ComponentName(activity, NowPlayingListenerService::class.java)
        return enabled.split(":").any {
            ComponentName.unflattenFromString(it) == me || it.startsWith(activity.packageName + "/")
        }
    }

    @Command
    fun checkPermission(invoke: Invoke) {
        val ret = JSObject()
        ret.put("granted", hasAccess())
        invoke.resolve(ret)
    }

    /** Opens the system "Notification access" screen. The user toggles Guitarfish on. */
    @Command
    fun requestPermission(invoke: Invoke) {
        if (!hasAccess()) {
            val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
        }
        val ret = JSObject()
        ret.put("granted", hasAccess())
        invoke.resolve(ret)
    }

    /**
     * Returns { track: {...} } for the followed session to report (see `chosen`),
     * or {} when nothing is playing / access is missing. Called about once a second.
     */
    @Command
    fun getNowPlaying(invoke: Invoke) {
        val ret = JSObject()
        if (!hasAccess()) {
            invoke.resolve(ret)
            return
        }
        try {
            chosen()?.let { ret.put("track", it.second) }
        } catch (e: SecurityException) {
            // Access was revoked between the check and the call: report "nothing playing".
        }
        invoke.resolve(ret)
    }

    /**
     * Same shape as desktop: { transport, seek, volume, events }. Transport and
     * seek go through the session's MediaController, which needs notification
     * access. Volume is the system's media stream, not the player's, so it isn't offered.
     */
    @Command
    fun getCapabilities(invoke: Invoke) {
        val granted = hasAccess()
        val ret = JSObject()
        ret.put("transport", granted)
        ret.put("seek", granted)
        ret.put("volume", false)
        ret.put("events", false)
        invoke.resolve(ret)
    }

    /** Drives the session `getNowPlaying` reports. Rejects when there is none. */
    @Command
    fun control(invoke: Invoke) {
        val args = invoke.parseArgs(ControlArgs::class.java)
        if (!hasAccess()) {
            invoke.reject("Notification access is needed to control the player")
            return
        }
        val controller = try {
            chosen()?.first
        } catch (e: SecurityException) {
            null
        }
        if (controller == null) {
            invoke.reject("Nothing is playing")
            return
        }
        val controls = controller.transportControls
        when (args.action) {
            "playpause" ->
                if (controller.playbackState?.state == PlaybackState.STATE_PLAYING) controls.pause() else controls.play()
            "next" -> controls.skipToNext()
            "previous" -> controls.skipToPrevious()
            "seek" -> {
                val ms = args.value
                if (ms == null) {
                    invoke.reject("seek needs a value (position in ms)")
                    return
                }
                controls.seekTo(ms.toLong().coerceAtLeast(0))
            }
            else -> {
                invoke.reject("playback action \"${args.action}\" is not supported on this platform")
                return
            }
        }
        invoke.resolve()
    }

    /**
     * The session to report, with its track: among the followed apps' sessions
     * that have something to show, a playing one before a paused one, then
     * YouTube, then browsers, then Spotify; among equals the first (Android lists
     * the most recently active first). Throws SecurityException without access.
     */
    private fun chosen(): Pair<MediaController, JSObject>? {
        val msm = activity.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
        val listener = ComponentName(activity, NowPlayingListenerService::class.java)
        var best: Pair<MediaController, JSObject>? = null
        var bestScore = -1
        for (c in msm.getActiveSessions(listener)) {
            val app = APPS[c.packageName] ?: continue
            val track = toTrack(c, app) ?: continue
            val playing = c.playbackState?.state == PlaybackState.STATE_PLAYING
            val score = (if (playing) 10 else 0) + app.service.rank
            if (score > bestScore) {
                best = Pair(c, track)
                bestScore = score
            }
        }
        return best
    }

    private fun toTrack(c: MediaController, app: App): JSObject? {
        val m: MediaMetadata = c.metadata ?: return null
        val title = m.getString(MediaMetadata.METADATA_KEY_TITLE) ?: return null
        val artist = m.getString(MediaMetadata.METADATA_KEY_ARTIST)
            ?: m.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST)
            ?: ""
        val spotify = app.service == Service.SPOTIFY
        // Spotify ads have no artist; a YouTube video's artist (its channel) may be missing.
        if (title.isBlank() || (spotify && artist.isBlank())) return null

        val state: PlaybackState? = c.playbackState
        val isPlaying = state?.state == PlaybackState.STATE_PLAYING

        val t = JSObject()
        t.put("title", title)
        t.put("artist", artist)
        m.getString(MediaMetadata.METADATA_KEY_ALBUM)?.takeIf { it.isNotBlank() }?.let { t.put("album", it) }
        val duration = m.getLong(MediaMetadata.METADATA_KEY_DURATION)
        if (duration > 0) t.put("durationMs", duration)

        // PlaybackState.position is a snapshot; extrapolate to "now" while playing.
        if (state != null && state.position >= 0) {
            var pos = state.position
            if (isPlaying && state.lastPositionUpdateTime > 0) {
                val elapsed = SystemClock.elapsedRealtime() - state.lastPositionUpdateTime
                pos += (elapsed * state.playbackSpeed).toLong()
            }
            if (duration > 0) pos = pos.coerceAtMost(duration)
            t.put("positionMs", pos.coerceAtLeast(0))
        }
        t.put("isPlaying", isPlaying)

        // Spotify puts its URI in MEDIA_ID, e.g. "spotify:track:<id>".
        if (spotify) {
            m.getString(MediaMetadata.METADATA_KEY_MEDIA_ID)
                ?.takeIf { it.startsWith("spotify:track:") }
                ?.removePrefix("spotify:track:")
                ?.let { t.put("spotifyId", it) }
        }

        t.put("source", "os")
        t.put("player", "${app.name} (Android)")
        t.put("service", app.service.id)
        return t
    }
}
