package com.harisdevlab.nxbeam

import android.content.Context
import android.hardware.usb.UsbManager
import android.os.Handler
import android.os.Looper
import android.view.Surface

/** where to get the picture from */
data class Target(val kind: String, val host: String = "", val port: Int = 0, val pin: String = "") {
    companion object {
        const val WIFI = "wifi"
        const val USB = "usb"
        const val HUB = "hub"
    }
}

/** what the player screen shows; every call arrives on the main thread */
interface SessionUi {
    fun onLink(state: Session.Link, detail: String)
    fun onVideoSize(w: Int, h: Int)
    fun onConsoleStatus(head: String, detail: String)
    fun onStats(s: Session.Stats)
}

/**
 * One viewing session: keeps the link to the console (reconnecting when it
 * drops) and passes what arrives to the decoder, the speaker and the recorder.
 */
class Session(private val context: Context, val target: Target, private val ui: SessionUi) : SourceListener {
    enum class Link { CONNECTING, WAITING, PLAYING, LOST, FAILED }
    data class Stats(
        val fps: Int, val mbps: Float, val width: Int, val height: Int,
        val decodeMs: Float, val dropped: Long, val audioUnderruns: Int, val recordingSec: Int,
        val takesInput: Boolean,
    )

    private val main = Handler(Looper.getMainLooper())
    private var source: Source? = null
    private var decoder: VideoDecoder? = null
    val audio = AudioOut()
    @Volatile private var recorder: Recorder? = null
    private var recordStart = 0L
    @Volatile private var running = false
    @Volatile private var gotVideo = false
    @Volatile private var width = 0
    @Volatile private var height = 0
    @Volatile var takesInput = false
        private set
    var smoothingMs = 0
        set(v) { field = v; decoder?.smoothingMs = v }

    private var lastBytes = 0L
    private var lastFrames = 0L
    private var padState: PadState? = null
    private var padSentAt = 0L

    fun start() {
        running = true
        connect()
        main.postDelayed(tick, 1000)
        main.postDelayed(padTick, 100)
    }

    fun stop() {
        running = false
        main.removeCallbacksAndMessages(null)
        stopRecording { }
        val s = source
        source = null
        Thread { s?.close() }.start()
        decoder?.release(); decoder = null
        audio.release()
    }

    /* the decoder follows the surface: it lives while the screen does */
    fun attachSurface(surface: Surface) {
        decoder?.release()
        decoder = VideoDecoder(surface, onNeedKey = { requestKeyframe() }, onFormat = { w, h -> main.post { ui.onVideoSize(w, h) } })
            .also { it.smoothingMs = smoothingMs }
        requestKeyframe()
    }

    fun detachSurface() { decoder?.release(); decoder = null }

    private fun connect() {
        if (!running) return
        gotVideo = false
        main.post { ui.onLink(Link.CONNECTING, target.host) }
        val s: Source = when (target.kind) {
            Target.USB -> {
                val um = context.getSystemService(Context.USB_SERVICE) as UsbManager
                val dev = UsbSource.find(um)
                if (dev == null || !um.hasPermission(dev)) {
                    onClosed("console not found on USB", if (dev == null) "absent" else "permission"); return
                }
                UsbSource(um, dev, this)
            }
            Target.HUB -> HubSource(target.host, target.port, target.pin, this).also { it.wantsAudio = audio.enabled }
            else -> TcpSource(target.host, target.port, this)
        }
        source = s
        s.start()
    }

    fun requestKeyframe() { source?.requestKeyframe(recorder != null) }

    /* ------------------------------------------------------------ SourceListener (source thread) */
    override fun onOpen() {
        main.post { ui.onLink(Link.WAITING, "") }
        requestKeyframe()
    }

    override fun onVideo(data: ByteArray, key: Boolean, width: Int, height: Int) {
        val t = System.nanoTime()
        if (!gotVideo) { gotVideo = true; main.post { ui.onLink(Link.PLAYING, "") } }
        this.width = width; this.height = height
        decoder?.feed(data, key, width, height, t)
        recorder?.video(data, key, width, height, t)
    }

    override fun onAudio(data: ByteArray, rate: Int, channels: Int) {
        audio.push(data, rate, channels)
        recorder?.audio(data, rate, channels, System.nanoTime())
    }

    override fun onStatus(head: String, detail: String) { main.post { ui.onConsoleStatus(head, detail) } }

    override fun onTakesInput(takes: Boolean) { takesInput = takes }

    override fun onClosed(reason: String, problem: String?) {
        if (!running) return
        val wasPlaying = gotVideo
        main.post {
            ui.onLink(if (problem != null) Link.FAILED else Link.LOST, problem ?: reason)
        }
        // try again: quickly after a drop, slower when the console was not there at all
        main.postDelayed({ if (running) connect() }, if (wasPlaying) 800L else 2500L)
    }

    /* ------------------------------------------------------------ audio */
    fun setAudio(on: Boolean) {
        audio.setOn(on)
        (source as? HubSource)?.setAudio(on)
    }

    /* ------------------------------------------------------------ recording */
    val recording get() = recorder != null

    fun startRecording(): Boolean {
        if (recorder != null) return true
        val f = MediaFile.create(context, true) ?: return false
        recorder = Recorder(f, withAudio = true)
        recordStart = System.nanoTime()
        requestKeyframe() // a keyframe now, and the picture size stays put while recording
        return true
    }

    fun stopRecording(done: (Boolean) -> Unit) {
        val r = recorder ?: return
        recorder = null
        requestKeyframe()
        r.stop { ok -> main.post { done(ok) } }
    }

    /* ------------------------------------------------------------ controller */
    fun setPad(state: PadState?) {
        if (state == padState) return
        padState = state
        source?.sendPad(state)
        padSentAt = System.currentTimeMillis()
    }

    /* the console forgets a pad that goes quiet: repeat the state every 100 ms */
    private val padTick = object : Runnable {
        override fun run() {
            val s = padState
            if (s != null && target.kind != Target.HUB && System.currentTimeMillis() - padSentAt >= 100) {
                source?.sendPad(s); padSentAt = System.currentTimeMillis()
            }
            if (running) main.postDelayed(this, 100)
        }
    }

    private val tick = object : Runnable {
        override fun run() {
            val src = source
            val d = decoder
            val bytes = src?.bytesIn ?: 0L
            val frames = d?.framesShown ?: 0L
            val db = if (bytes >= lastBytes) bytes - lastBytes else bytes
            val df = if (frames >= lastFrames) frames - lastFrames else frames
            lastBytes = bytes; lastFrames = frames
            val rec = recorder
            val st = Stats(
                fps = df.toInt(), mbps = db * 8f / 1_000_000f, width = width, height = height,
                decodeMs = d?.decodeMs ?: 0f, dropped = d?.dropped ?: 0, audioUnderruns = audio.underruns,
                recordingSec = if (rec != null) ((System.nanoTime() - recordStart) / 1_000_000_000L).toInt() else -1,
                takesInput = takesInput,
            )
            if (st.fps > 0 || st.mbps > 0f) android.util.Log.i("NXBeam", "stats $st")
            ui.onStats(st)
            if (running) main.postDelayed(this, 1000)
        }
    }
}
