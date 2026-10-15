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

private const val SPOTIFY_PACKAGE = "com.spotify.music"

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
     * Returns { track: {...} } for Spotify's active media session, or {} when
     * nothing is playing / access is missing. Called by the app about once a second.
     */
    @Command
    fun getNowPlaying(invoke: Invoke) {
        val ret = JSObject()
        if (!hasAccess()) {
            invoke.resolve(ret)
            return
        }
        try {
            spotifyController()?.let { toTrack(it) }?.let { ret.put("track", it) }
        } catch (e: SecurityException) {
            // Access was revoked between the check and the call: report "nothing playing".
        }
        invoke.resolve(ret)
    }

    /**
     * Same shape as desktop: { transport, seek, volume, events }. Transport and
     * seek go through Spotify's MediaController, which needs notification access.
     * Volume is the system's media stream, not Spotify's, so it isn't offered.
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

    /** Drives Spotify through its media session. Rejects when Spotify has no session. */
    @Command
    fun control(invoke: Invoke) {
        val args = invoke.parseArgs(ControlArgs::class.java)
        if (!hasAccess()) {
            invoke.reject("Notification access is needed to control Spotify")
            return
        }
        val controller = try {
            spotifyController()
        } catch (e: SecurityException) {
            null
        }
        if (controller == null) {
            invoke.reject("Spotify is not playing")
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

    /** Spotify's active media session, or null. Throws SecurityException without access. */
    private fun spotifyController(): MediaController? {
        val msm = activity.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
        val listener = ComponentName(activity, NowPlayingListenerService::class.java)
        return msm.getActiveSessions(listener).firstOrNull { it.packageName == SPOTIFY_PACKAGE }
    }

    private fun toTrack(c: MediaController): JSObject? {
        val m: MediaMetadata = c.metadata ?: return null
        val title = m.getString(MediaMetadata.METADATA_KEY_TITLE) ?: return null
        val artist = m.getString(MediaMetadata.METADATA_KEY_ARTIST)
            ?: m.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST)
            ?: ""
        if (title.isBlank() || artist.isBlank()) return null // ads / unknown

        val state: PlaybackState? = c.playbackState
        val isPlaying = state?.state == PlaybackState.STATE_PLAYING

        val t = JSObject()
        t.put("title", title)
        t.put("artist", artist)
        m.getString(MediaMetadata.METADATA_KEY_ALBUM)?.let { t.put("album", it) }
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
        m.getString(MediaMetadata.METADATA_KEY_MEDIA_ID)
            ?.takeIf { it.startsWith("spotify:track:") }
            ?.removePrefix("spotify:track:")
            ?.let { t.put("spotifyId", it) }

        t.put("source", "os")
        t.put("player", "Spotify (Android)")
        return t
    }
}
