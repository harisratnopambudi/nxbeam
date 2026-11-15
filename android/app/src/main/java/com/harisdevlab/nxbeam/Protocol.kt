package com.harisdevlab.nxbeam

/*
 * Wire format of the console-side sysmodule (same as the PC hub, src/protocol.js).
 * Console -> viewer: 32-byte little-endian header + payload.
 *   magic "SFTR", version u16, flags u16, width, height, stride, length, extra, kind (u32)
 * Viewer -> console: 4-byte commands and the 32-byte "SFTI" pad message.
 */
object Proto {
    const val MAGIC = 0x52544653
    const val HEADER = 32
    const val MAX_PAYLOAD = 64 * 1024 * 1024

    const val F_H264 = 2
    const val F_KEY = 4
    const val F_AUDIO = 8
    const val F_STATUS = 16
    const val F_INPUT = 128

    const val NET_PORT = 9950
    const val BEACON_PORT = 9951
    const val USB_VID = 0x1209
    const val USB_PID = 0x5F1E

    val KEYFRAME = "SFTK".toByteArray(Charsets.US_ASCII)
    val CONSOLE_CROPS = "SFTD".toByteArray(Charsets.US_ASCII)
    val LOCK_SIZE = "SFTL".toByteArray(Charsets.US_ASCII)
    val FOLLOW_SIZE = "SFTU".toByteArray(Charsets.US_ASCII)
    val BYE = "SFTQ".toByteArray(Charsets.US_ASCII)

    /* Switch button bits (HidNpadButton) */
    const val B_A = 0; const val B_B = 1; const val B_X = 2; const val B_Y = 3
    const val B_LSTICK = 4; const val B_RSTICK = 5; const val B_L = 6; const val B_R = 7
    const val B_ZL = 8; const val B_ZR = 9; const val B_PLUS = 10; const val B_MINUS = 11
    const val B_LEFT = 12; const val B_UP = 13; const val B_RIGHT = 14; const val B_DOWN = 15
    const val B_HOME = 18; const val B_CAPTURE = 19

    fun u32(b: ByteArray, o: Int): Int =
        (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8) or
            ((b[o + 2].toInt() and 0xff) shl 16) or ((b[o + 3].toInt() and 0xff) shl 24)

    fun u16(b: ByteArray, o: Int): Int = (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8)

    fun put32(b: ByteArray, o: Int, v: Int) {
        b[o] = v.toByte(); b[o + 1] = (v shr 8).toByte(); b[o + 2] = (v shr 16).toByte(); b[o + 3] = (v shr 24).toByte()
    }

    /** the commands sent on connect: keyframe, let the console crop, follow or lock the size */
    fun startCommands(withKey: Boolean, lockSize: Boolean): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        if (withKey) out.write(KEYFRAME)
        out.write(CONSOLE_CROPS)
        out.write(if (lockSize) LOCK_SIZE else FOLLOW_SIZE)
        return out.toByteArray()
    }

    /** 32-byte SFTI; state null releases the virtual controller */
    fun padMessage(state: PadState?): ByteArray {
        val m = ByteArray(32)
        "SFTI".toByteArray(Charsets.US_ASCII).copyInto(m)
        if (state == null) return m
        put32(m, 4, 1)
        put32(m, 8, state.buttons)
        put32(m, 16, state.lx); put32(m, 20, state.ly)
        put32(m, 24, state.rx); put32(m, 28, state.ry)
        return m
    }

    fun cstr(b: ByteArray, off: Int, len: Int): String {
        var end = off
        while (end < off + len && end < b.size && b[end] != 0.toByte()) end++
        return String(b, off, end - off, Charsets.UTF_8)
    }
}

data class PadState(val buttons: Int, val lx: Int, val ly: Int, val rx: Int, val ry: Int)

class Header(
    val flags: Int, val width: Int, val height: Int, val length: Int,
) {
    val isAudio get() = flags and Proto.F_AUDIO != 0
    val isStatus get() = flags and Proto.F_STATUS != 0
    val isH264 get() = flags and Proto.F_H264 != 0
    val isKey get() = flags and Proto.F_KEY != 0
    val takesInput get() = flags and Proto.F_INPUT != 0
}

/**
 * Turns a byte stream (TCP or USB) into whole packets. Resyncs on a bad
 * magic by looking for the next "SFTR".
 */
class StreamParser(private val onPacket: (Header, ByteArray) -> Unit) {
    private var buf = ByteArray(1 shl 20)
    private var start = 0
    private var end = 0
    private var header: Header? = null
    var resyncs = 0
        private set

    fun reset() { start = 0; end = 0; header = null }

    fun push(src: ByteArray, off: Int, len: Int) {
        if (len <= 0) return
        ensure(len)
        System.arraycopy(src, off, buf, end, len)
        end += len
        parse()
    }

    private fun ensure(more: Int) {
        if (end + more <= buf.size) return
        val used = end - start
        if (used + more <= buf.size && start > 0) {
            System.arraycopy(buf, start, buf, 0, used)
        } else {
            var cap = buf.size
            while (cap < used + more) cap *= 2
            val nb = ByteArray(cap)
            System.arraycopy(buf, start, nb, 0, used)
            buf = nb
        }
        start = 0; end = used
    }

    private fun parse() {
        while (true) {
            var h = header
            if (h == null) {
                if (end - start < Proto.HEADER) break
                if (Proto.u32(buf, start) != Proto.MAGIC) { resync(); continue }
                val len = Proto.u32(buf, start + 20)
                h = Header(
                    flags = Proto.u16(buf, start + 6),
                    width = Proto.u32(buf, start + 8),
                    height = Proto.u32(buf, start + 12),
                    length = len,
                )
                start += Proto.HEADER
                if (len < 0 || len > Proto.MAX_PAYLOAD) { resyncs++; continue }
                header = h
            }
            if (end - start < h.length) break
            val payload = buf.copyOfRange(start, start + h.length)
            start += h.length
            header = null
            onPacket(h, payload)
        }
        if (start == end) { start = 0; end = 0 }
    }

    private fun resync() {
        resyncs++
        var i = start + 1
        while (i + 3 < end) {
            if (buf[i] == 'S'.code.toByte() && buf[i + 1] == 'F'.code.toByte() &&
                buf[i + 2] == 'T'.code.toByte() && buf[i + 3] == 'R'.code.toByte()) { start = i; return }
            i++
        }
        start = maxOf(start, end - 3)
    }
}

/* H.264 Annex-B helpers */
object H264 {
    /** SPS and PPS NAL units (without start codes) of a keyframe, or null */
    fun params(au: ByteArray): Pair<ByteArray, ByteArray>? {
        var sps: ByteArray? = null
        var pps: ByteArray? = null
        forEachNal(au) { s, e ->
            when (au[s].toInt() and 0x1f) {
                7 -> if (sps == null) sps = au.copyOfRange(s, e)
                8 -> if (pps == null) pps = au.copyOfRange(s, e)
            }
        }
        val a = sps ?: return null
        val b = pps ?: return null
        return a to b
    }

    inline fun forEachNal(buf: ByteArray, fn: (start: Int, end: Int) -> Unit) {
        var i = 0
        var s = -1
        val n = buf.size
        while (i + 2 < n) {
            if (buf[i].toInt() == 0 && buf[i + 1].toInt() == 0 &&
                (buf[i + 2].toInt() == 1 || (buf[i + 2].toInt() == 0 && i + 3 < n && buf[i + 3].toInt() == 1))) {
                val sc = if (buf[i + 2].toInt() == 1) 3 else 4
                if (s >= 0) {
                    var e = i
                    while (e > s && buf[e - 1].toInt() == 0) e--
                    if (e > s) fn(s, e)
                }
                i += sc
                s = i
            } else i++
        }
        if (s in 0 until n) fn(s, n)
    }

    fun withStartCode(nal: ByteArray): ByteArray {
        val out = ByteArray(nal.size + 4)
        out[3] = 1
        nal.copyInto(out, 4)
        return out
    }
}
