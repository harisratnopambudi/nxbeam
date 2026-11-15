package com.harisdevlab.nxbeam

import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.hardware.usb.UsbRequest
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** what a source hands to the session */
interface SourceListener {
    fun onOpen()
    fun onVideo(data: ByteArray, key: Boolean, width: Int, height: Int)
    fun onAudio(data: ByteArray, rate: Int, channels: Int)
    fun onStatus(head: String, detail: String)
    fun onTakesInput(takes: Boolean)
    fun onClosed(reason: String, problem: String?)
}

abstract class Source(protected val listener: SourceListener) {
    @Volatile var closed = false
        protected set
    var bytesIn = 0L
        protected set
    abstract val label: String

    /** runs on its own thread until the link ends */
    abstract fun run()
    abstract fun requestKeyframe(lockSize: Boolean)
    abstract fun sendPad(state: PadState?)
    abstract fun close()

    fun start(): Thread = Thread({
        try { run() } catch (e: Exception) {
            finish(e.message ?: e.javaClass.simpleName, null)
        }
    }, "nxbeam-source").apply { priority = Thread.MAX_PRIORITY; start() }

    private var finished = false
    protected fun finish(reason: String, problem: String?) {
        synchronized(this) { if (finished) return; finished = true }
        closed = true
        listener.onClosed(reason, problem)
    }

    /* packets straight from the console (TCP and USB) */
    private var takesInput: Boolean? = null
    protected fun dispatch(h: Header, payload: ByteArray) {
        if (!h.isAudio || h.isStatus) {
            if (takesInput != h.takesInput) { takesInput = h.takesInput; listener.onTakesInput(h.takesInput) }
        }
        if (h.isAudio) {
            if (h.isStatus) {
                if (payload.size >= 192) listener.onStatus(Proto.cstr(payload, 8, 64), Proto.cstr(payload, 72, 120))
                return
            }
            if (h.width > 0 && h.height > 0) listener.onAudio(payload, h.width, h.height)
            return
        }
        if (h.isH264) listener.onVideo(payload, h.isKey, h.width, h.height)
    }
}

/* ------------------------------------------------------------------ Wi-Fi */
class TcpSource(private val host: String, private val port: Int, l: SourceListener) : Source(l) {
    override val label = host
    private var sock: Socket? = null
    private val sendLock = Any()

    override fun run() {
        val s = Socket()
        sock = s
        try {
            s.connect(InetSocketAddress(host, port), 3000)
        } catch (e: IOException) {
            val refused = (e.message ?: "").contains("ECONNREFUSED", true) || e is java.net.ConnectException
            finish(e.message ?: "connect failed", if (refused) "refused" else "timeout")
            return
        }
        s.tcpNoDelay = true
        s.keepAlive = true
        s.receiveBufferSize = 1 shl 20
        listener.onOpen()
        val parser = StreamParser { h, p -> dispatch(h, p) }
        val input = s.getInputStream()
        val chunk = ByteArray(256 * 1024)
        try {
            while (!closed) {
                val n = input.read(chunk)
                if (n < 0) break
                bytesIn += n
                parser.push(chunk, 0, n)
            }
        } catch (_: IOException) { }
        finish("network connection closed", null)
    }

    private fun send(b: ByteArray) {
        val s = sock ?: return
        Thread {
            try { synchronized(sendLock) { s.getOutputStream().apply { write(b); flush() } } } catch (_: IOException) { }
        }.start()
    }

    override fun requestKeyframe(lockSize: Boolean) = send(Proto.startCommands(true, lockSize))
    override fun sendPad(state: PadState?) = send(Proto.padMessage(state))

    override fun close() {
        if (closed) return
        closed = true
        try { sock?.getOutputStream()?.write(Proto.BYE) } catch (_: Exception) { }
        try { sock?.close() } catch (_: Exception) { }
    }
}

/* ------------------------------------------------------------------ USB */
class UsbSource(
    private val manager: UsbManager,
    private val device: UsbDevice,
    l: SourceListener,
) : Source(l) {
    override val label = "USB"
    private var conn: UsbDeviceConnection? = null
    private var iface: UsbInterface? = null
    private var outEp: UsbEndpoint? = null
    private val tx = LinkedBlockingQueue<Pair<ByteArray, Boolean>>()
    private var writer: Thread? = null

    override fun run() {
        val c = manager.openDevice(device)
        if (c == null) { finish("cannot open the USB device", "permission"); return }
        val intf = device.getInterface(0)
        if (!c.claimInterface(intf, true)) { c.close(); finish("cannot claim the USB interface", "busy"); return }
        conn = c; iface = intf
        var inEp: UsbEndpoint? = null
        for (i in 0 until intf.endpointCount) {
            val ep = intf.getEndpoint(i)
            if (ep.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
            if (ep.direction == UsbConstants.USB_DIR_IN) inEp = ep else outEp = ep
        }
        if (inEp == null) { finish("no USB IN endpoint", "error"); release(); return }
        startWriter()
        listener.onOpen()

        /* four 256 KB reads queued at all times, so the console never waits between transfers */
        val parser = StreamParser { h, p -> dispatch(h, p) }
        val reqs = List(4) {
            UsbRequest().apply {
                initialize(c, inEp)
                clientData = ByteBuffer.allocateDirect(256 * 1024)
            }
        }
        for (r in reqs) r.queue(r.clientData as ByteBuffer)
        val chunk = ByteArray(256 * 1024)
        var reason = "the console left USB"
        try {
            while (!closed) {
                val r = c.requestWait() ?: break
                val bb = r.clientData as ByteBuffer
                val n = bb.position()
                if (n > 0) {
                    bb.flip()
                    bb.get(chunk, 0, n)
                    bytesIn += n
                    parser.push(chunk, 0, n)
                }
                bb.clear()
                if (closed || !r.queue(bb)) break
            }
        } catch (e: Exception) { reason = "USB read: ${e.message}" }
        for (r in reqs) try { r.cancel(); r.close() } catch (_: Exception) { }
        finish(reason, null)
        release()
    }

    /*
     * The console takes a request only while it has a buffer waiting for one,
     * so a command may time out: retry 150 ms apart. Pad states go once.
     */
    private fun startWriter() {
        writer = Thread({
            while (!closed) {
                val (b, isPad) = try { tx.poll(500, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) { null } ?: continue
                val c = conn ?: break
                val ep = outEp ?: break
                var tries = if (isPad) 1 else 14
                while (tries-- > 0 && !closed) {
                    if (c.bulkTransfer(ep, b, b.size, 40) >= 0) break
                    if (tries > 0) Thread.sleep(150)
                }
            }
        }, "nxbeam-usb-tx").apply { start() }
    }

    override fun requestKeyframe(lockSize: Boolean) { tx.offer(Proto.startCommands(true, lockSize) to false) }

    override fun sendPad(state: PadState?) {
        tx.removeIf { it.second }
        tx.offer(Proto.padMessage(state) to true)
    }

    private fun release() {
        try { iface?.let { conn?.releaseInterface(it) } } catch (_: Exception) { }
        try { conn?.close() } catch (_: Exception) { }
        conn = null
    }

    override fun close() {
        if (closed) return
        closed = true
        try { val c = conn; val ep = outEp; if (c != null && ep != null) c.bulkTransfer(ep, Proto.BYE, 4, 200) } catch (_: Exception) { }
        writer?.interrupt()
        // requestWait returns once the device connection closes
        Thread { Thread.sleep(250); release() }.start()
    }

    companion object {
        fun find(manager: UsbManager): UsbDevice? =
            manager.deviceList.values.firstOrNull { it.vendorId == Proto.USB_VID && it.productId == Proto.USB_PID }
    }
}

/* ------------------------------------------------------------------ PC hub */
class AuthRequired : IOException("PIN required")

/** watches NXBeam running on a PC: its WebSocket, the same frames the browser gets */
class HubSource(
    private val host: String,
    private val port: Int,
    private val pin: String?,
    l: SourceListener,
) : Source(l) {
    override val label = "$host:$port"
    private var ws: WebSocketClient? = null
    private var controlTaken = false
    @Volatile var wantsAudio = true

    override fun run() {
        var cookie: String? = null
        if (!pin.isNullOrEmpty()) cookie = login(pin)
        val c = WebSocketClient(host, port, "/ws", cookie)
        ws = c
        try {
            c.connect()
        } catch (e: AuthRequired) { finish("PIN required", "pin"); return }
        catch (e: IOException) {
            finish(e.message ?: "connect failed", if (e is java.net.ConnectException) "refused" else "timeout"); return
        }
        listener.onOpen()
        c.sendText(JSONObject().put("type", "hello").put("name", "Android " + android.os.Build.MODEL)
            .put("role", "viewer").put("video", true).put("audio", wantsAudio).toString())
        try {
            c.loop(onText = ::onText, onBinary = ::onBinary)
        } catch (_: IOException) { }
        finish("the PC hub closed the connection", null)
    }

    private fun onBinary(b: ByteArray) {
        bytesIn += b.size
        val bb = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN)
        when (b[0].toInt()) {
            1 -> if (b.size > 20) listener.onVideo(b.copyOfRange(20, b.size), b[1].toInt() == 1, bb.getInt(4), bb.getInt(8))
            2 -> if (b.size > 16) listener.onAudio(b.copyOfRange(16, b.size), bb.getInt(4), b[1].toInt())
        }
    }

    private fun onText(s: String) {
        val m = try { JSONObject(s) } catch (_: Exception) { return }
        val st = m.optJSONObject("state") ?: return
        listener.onTakesInput(st.optBoolean("takesInput", false))
        val cs = st.optJSONObject("consoleStatus")
        if (cs != null) listener.onStatus(cs.optString("head"), cs.optString("detail"))
        else listener.onStatus("", "")
    }

    private fun login(pin: String): String? {
        val u = URL("http://$host:$port/api/login")
        val h = u.openConnection() as HttpURLConnection
        h.connectTimeout = 3000; h.readTimeout = 3000
        h.requestMethod = "POST"; h.doOutput = true
        h.setRequestProperty("content-type", "application/json")
        h.outputStream.use { it.write(JSONObject().put("pin", pin).toString().toByteArray()) }
        val code = h.responseCode
        val set = h.getHeaderField("set-cookie")
        h.disconnect()
        if (code != 200 || set == null) return null
        return set.substringBefore(';')
    }

    fun setAudio(on: Boolean) {
        wantsAudio = on
        ws?.sendText(JSONObject().put("type", "subscribe").put("audio", on).toString())
    }

    override fun requestKeyframe(lockSize: Boolean) {
        ws?.sendText("{\"type\":\"needKey\"}")
    }

    override fun sendPad(state: PadState?) {
        val c = ws ?: return
        if (state == null) {
            if (controlTaken) c.sendText("{\"type\":\"releaseControl\"}")
            controlTaken = false
            return
        }
        if (!controlTaken) { c.sendText("{\"type\":\"takeControl\"}"); controlTaken = true }
        val js = JSONObject().put("buttons", state.buttons).put("lx", state.lx).put("ly", state.ly)
            .put("rx", state.rx).put("ry", state.ry)
        c.sendText(JSONObject().put("type", "pad").put("state", js).toString())
    }

    override fun close() {
        if (closed) return
        closed = true
        ws?.close()
    }
}
