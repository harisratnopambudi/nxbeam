package com.harisdevlab.nxbeam

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView

class PlayerActivity : Activity(), SessionUi {
    private lateinit var prefs: Prefs
    private lateinit var target: Target
    private var session: Session? = null
    private val main = Handler(Looper.getMainLooper())

    private lateinit var aspect: AspectLayout
    private lateinit var surface: SurfaceView
    private lateinit var message: LinearLayout
    private lateinit var spinner: ProgressBar
    private lateinit var messageHead: TextView
    private lateinit var messageDetail: TextView
    private lateinit var controls: LinearLayout
    private lateinit var statsText: TextView
    private lateinit var recBadge: TextView
    private lateinit var toast: TextView
    private lateinit var btnRecord: ImageButton
    private lateinit var btnSound: ImageButton

    private var surfaceReady = false
    private var playing = false
    private var gamepad: Gamepad? = null
    private var padAnnounced = false
    private var consoleHead = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_player)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        prefs = Prefs(this)
        LocalNet.start(this)
        target = Target(
            intent.getStringExtra("kind") ?: Target.WIFI,
            intent.getStringExtra("host") ?: "",
            intent.getIntExtra("port", Proto.NET_PORT),
            intent.getStringExtra("pin") ?: "",
        )

        aspect = findViewById(R.id.aspect)
        surface = findViewById(R.id.surface)
        message = findViewById(R.id.message)
        spinner = findViewById(R.id.spinner)
        messageHead = findViewById(R.id.messageHead)
        messageDetail = findViewById(R.id.messageDetail)
        controls = findViewById(R.id.controls)
        statsText = findViewById(R.id.statsText)
        recBadge = findViewById(R.id.recBadge)
        toast = findViewById(R.id.toast)
        btnRecord = findViewById(R.id.btnRecord)
        btnSound = findViewById(R.id.btnSound)

        findViewById<ImageButton>(R.id.btnBack).setOnClickListener { finish() }
        btnRecord.setOnClickListener { toggleRecord() }
        findViewById<ImageButton>(R.id.btnShot).setOnClickListener { screenshot() }
        btnSound.setOnClickListener { toggleSound() }
        findViewById<ImageButton>(R.id.btnStats).setOnClickListener {
            prefs.showStats = !prefs.showStats
            statsText.visibility = if (prefs.showStats) View.VISIBLE else View.GONE
            poke()
        }
        findViewById<View>(R.id.root).setOnClickListener { if (controls.visibility == View.VISIBLE) hideControls() else poke() }
        statsText.visibility = if (prefs.showStats) View.VISIBLE else View.GONE
        showSoundIcon()

        surface.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(h: SurfaceHolder) { surfaceReady = true; session?.attachSurface(h.surface) }
            override fun surfaceChanged(h: SurfaceHolder, f: Int, w: Int, ht: Int) { }
            override fun surfaceDestroyed(h: SurfaceHolder) { surfaceReady = false; session?.detachSurface() }
        })

        if (prefs.gamepad) gamepad = Gamepad { s -> onPad(s) }
        poke()
    }

    override fun onStart() {
        super.onStart()
        immersive()
        val s = Session(this, target, this)
        s.smoothingMs = Prefs.smoothingMs(prefs.pictureMode)
        s.audio.targetMs = Prefs.audioMs(prefs.pictureMode)
        s.audio.setOn(prefs.audio)
        session = s
        playing = false
        s.start()
        if (surfaceReady) s.attachSurface(surface.holder.surface)
    }

    override fun onStop() {
        super.onStop()
        session?.let { s ->
            if (s.recording) s.stopRecording { ok -> if (ok) showToast(getString(R.string.saved_recording)) }
            s.setPad(null)
            s.stop()
        }
        session = null
        recBadge.visibility = View.GONE
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    private fun immersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
        }
    }

    /* ------------------------------------------------------------ SessionUi */
    override fun onLink(state: Session.Link, detail: String) {
        when (state) {
            Session.Link.CONNECTING -> if (!playing) showMessage(
                if (target.kind == Target.USB) getString(R.string.link_connecting_usb)
                else getString(R.string.link_connecting, target.host), "", true)
            Session.Link.WAITING -> if (!playing) showMessage(getString(R.string.link_waiting), consoleHead, true)
            Session.Link.PLAYING -> { playing = true; message.visibility = View.GONE }
            Session.Link.LOST -> { playing = false; showMessage(getString(R.string.link_lost), "", true) }
            Session.Link.FAILED -> {
                playing = false
                val kind = detail.substringBefore('\n')
                if (kind == "pin") { setResult(RESULT_PIN); finish(); return }
                val text = when (kind) {
                    "refused" -> R.string.fail_refused
                    "timeout" -> R.string.fail_timeout
                    "absent" -> R.string.fail_absent
                    "permission" -> R.string.fail_permission
                    "busy" -> R.string.fail_busy
                    else -> R.string.link_lost
                }
                val why = detail.substringAfter('\n', "")
                showMessage(getString(text), getString(R.string.retrying) + if (why.isNotEmpty()) "\n($why)" else "", false)
            }
        }
    }

    override fun onVideoSize(w: Int, h: Int) = aspect.setAspect(w, h)

    override fun onConsoleStatus(head: String, detail: String) {
        consoleHead = listOf(head, detail).filter { it.isNotBlank() }.joinToString("\n")
        if (!playing && message.visibility == View.VISIBLE && consoleHead.isNotEmpty()) messageDetail.text = consoleHead
    }

    override fun onStats(s: Session.Stats) {
        // while waiting on USB, show what the link is doing: it tells a cable problem from a console one
        if (!playing && message.visibility == View.VISIBLE && s.diag != null) {
            messageDetail.visibility = View.VISIBLE
            messageDetail.text = listOf(consoleHead, s.diag).filter { it.isNotBlank() }.joinToString("\n")
        }
        if (statsText.visibility == View.VISIBLE) {
            statsText.text = getString(R.string.stats_line, s.fps, s.mbps, s.width, s.height, s.decodeMs, s.dropped, s.audioUnderruns)
        }
        if (s.recordingSec >= 0) {
            recBadge.visibility = View.VISIBLE
            recBadge.text = "%d:%02d".format(s.recordingSec / 60, s.recordingSec % 60)
        } else recBadge.visibility = View.GONE
    }

    private fun showMessage(head: String, detail: String, busy: Boolean) {
        message.visibility = View.VISIBLE
        spinner.visibility = if (busy) View.VISIBLE else View.GONE
        messageHead.text = head
        messageDetail.text = detail
        messageDetail.visibility = if (detail.isEmpty()) View.GONE else View.VISIBLE
    }

    /* ------------------------------------------------------------ controls */
    private val hideRunnable = Runnable { hideControls() }

    private fun poke() {
        if (controls.visibility != View.VISIBLE) {
            controls.visibility = View.VISIBLE
            controls.alpha = 0f
            controls.animate().alpha(1f).setDuration(150).start()
            controls.getChildAt(0).requestFocus()
        }
        main.removeCallbacks(hideRunnable)
        main.postDelayed(hideRunnable, 4000)
    }

    private fun hideControls() {
        main.removeCallbacks(hideRunnable)
        if (controls.visibility != View.VISIBLE) return
        controls.animate().alpha(0f).setDuration(200).withEndAction { controls.visibility = View.GONE }.start()
    }

    private fun showToast(text: String) {
        toast.text = text
        toast.visibility = View.VISIBLE
        main.removeCallbacks(hideToast)
        main.postDelayed(hideToast, 2800)
    }
    private val hideToast = Runnable { toast.visibility = View.GONE }

    private fun toggleSound() {
        prefs.audio = !prefs.audio
        session?.setAudio(prefs.audio)
        showSoundIcon()
        poke()
    }

    private fun showSoundIcon() {
        btnSound.setImageResource(if (prefs.audio) R.drawable.ic_volume else R.drawable.ic_volume_off)
    }

    private fun toggleRecord() {
        val s = session ?: return
        poke()
        if (s.recording) {
            s.stopRecording { ok -> showToast(getString(if (ok) R.string.saved_recording else R.string.save_failed)) }
            btnRecord.setImageResource(R.drawable.ic_record)
            btnRecord.contentDescription = getString(R.string.record)
            return
        }
        if (MediaFile.needsPermission() && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQ_STORAGE_REC)
            return
        }
        if (s.startRecording()) {
            btnRecord.setImageResource(R.drawable.ic_stop)
            btnRecord.contentDescription = getString(R.string.stop_record)
        } else showToast(getString(R.string.save_failed))
    }

    private fun screenshot() {
        poke()
        if (MediaFile.needsPermission() && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQ_STORAGE_SHOT)
            return
        }
        if (!playing || surface.width == 0) return
        val bmp = Bitmap.createBitmap(surface.width, surface.height, Bitmap.Config.ARGB_8888)
        val worker = HandlerThread("nxbeam-shot").apply { start() }
        PixelCopy.request(surface, bmp, { result ->
            val name = if (result == PixelCopy.SUCCESS) MediaFile.saveImage(this, bmp) else null
            worker.quitSafely()
            runOnUiThread { showToast(getString(if (name != null) R.string.saved_screenshot else R.string.save_failed)) }
        }, Handler(worker.looper))
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (grantResults.firstOrNull() != PackageManager.PERMISSION_GRANTED) { showToast(getString(R.string.storage_needed)); return }
        if (requestCode == REQ_STORAGE_REC) toggleRecord() else if (requestCode == REQ_STORAGE_SHOT) screenshot()
    }

    /* ------------------------------------------------------------ input */
    private fun onPad(s: PadState) {
        val sess = session ?: return
        sess.setPad(s)
        if (!padAnnounced) {
            padAnnounced = true
            showToast(getString(if (sess.takesInput || target.kind == Target.HUB) R.string.pad_active else R.string.pad_not_taken))
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val g = gamepad
        // with controller forwarding on, the controller plays the Switch; its Back/B never leaves the player
        if (g != null && g.key(event)) return true
        if (event.action == KeyEvent.ACTION_DOWN && controls.visibility != View.VISIBLE) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_MENU,
                KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
                KeyEvent.KEYCODE_BUTTON_SELECT -> { poke(); return true }
            }
        }
        if (event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_MEDIA_RECORD -> { toggleRecord(); return true }
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> { toggleSound(); return true }
            }
            if (controls.visibility == View.VISIBLE) poke()
        }
        return super.dispatchKeyEvent(event)
    }

    override fun dispatchGenericMotionEvent(ev: MotionEvent): Boolean {
        val g = gamepad
        if (g != null && g.motion(ev)) return true
        return super.dispatchGenericMotionEvent(ev)
    }

    companion object {
        const val RESULT_PIN = Activity.RESULT_FIRST_USER + 1
        private const val REQ_STORAGE_REC = 11
        private const val REQ_STORAGE_SHOT = 12
    }
}
