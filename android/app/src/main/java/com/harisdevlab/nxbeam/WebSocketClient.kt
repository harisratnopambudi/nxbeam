package com.harisdevlab.nxbeam

import android.util.Base64
import java.io.BufferedInputStream
import java.io.DataInputStream
import java.io.IOException
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom

/** a small RFC 6455 client: enough for the NXBeam hub (no extensions, no TLS) */
class WebSocketClient(
    private val host: String,
    private val port: Int,
    private val path: String,
    private val cookie: String?,
) {
    private val sock = Socket()
    private lateinit var input: DataInputStream
    private lateinit var output: OutputStream
    private val rnd = SecureRandom()
    private val writeLock = Any()
    @Volatile private var open = false

    fun connect() {
        sock.connect(InetSocketAddress(host, port), 3000)
        sock.tcpNoDelay = true
        sock.receiveBufferSize = 1 shl 20
        input = DataInputStream(BufferedInputStream(sock.getInputStream(), 1 shl 16))
        output = sock.getOutputStream()
        val key = ByteArray(16).also { rnd.nextBytes(it) }
        val req = buildString {
            append("GET $path HTTP/1.1\r\n")
            append("Host: $host:$port\r\n")
            append("Upgrade: websocket\r\nConnection: Upgrade\r\n")
            append("Sec-WebSocket-Key: ${Base64.encodeToString(key, Base64.NO_WRAP)}\r\n")
            append("Sec-WebSocket-Version: 13\r\n")
            if (cookie != null) append("Cookie: $cookie\r\n")
            append("\r\n")
        }
        output.write(req.toByteArray(Charsets.ISO_8859_1))
        output.flush()
        val status = readLine()
        while (readLine().isNotEmpty()) { /* headers */ }
        if (status.contains(" 401")) { close(); throw AuthRequired() }
        if (!status.contains(" 101")) { close(); throw IOException("not an NXBeam hub ($status)") }
        open = true
    }

    private fun readLine(): String {
        val sb = StringBuilder()
        while (true) {
            val c = input.read()
            if (c < 0) throw IOException("connection closed")
            if (c == '\n'.code) break
            if (c != '\r'.code) sb.append(c.toChar())
            if (sb.length > 8192) throw IOException("bad response")
        }
        return sb.toString()
    }

    /** reads messages until the connection ends */
    fun loop(onText: (String) -> Unit, onBinary: (ByteArray) -> Unit) {
        var fragments: java.io.ByteArrayOutputStream? = null
        var fragOp = 0
        while (open) {
            val b0 = input.readUnsignedByte()
            val b1 = input.readUnsignedByte()
            val fin = b0 and 0x80 != 0
            val op = b0 and 0x0f
            var len = (b1 and 0x7f).toLong()
            if (len == 126L) len = input.readUnsignedShort().toLong()
            else if (len == 127L) len = input.readLong()
            if (len < 0 || len > Proto.MAX_PAYLOAD) throw IOException("frame too large")
            val mask = if (b1 and 0x80 != 0) ByteArray(4).also { input.readFully(it) } else null
            val data = ByteArray(len.toInt())
            input.readFully(data)
            if (mask != null) for (i in data.indices) data[i] = (data[i].toInt() xor mask[i and 3].toInt()).toByte()
            when (op) {
                0x0 -> {
                    val f = fragments ?: continue
                    f.write(data)
                    if (fin) { deliver(fragOp, f.toByteArray(), onText, onBinary); fragments = null }
                }
                0x1, 0x2 -> {
                    if (fin) deliver(op, data, onText, onBinary)
                    else { fragments = java.io.ByteArrayOutputStream().apply { write(data) }; fragOp = op }
                }
                0x8 -> { close(); return }
                0x9 -> sendFrame(0xA, data)
                else -> { }
            }
        }
    }

    private fun deliver(op: Int, data: ByteArray, onText: (String) -> Unit, onBinary: (ByteArray) -> Unit) {
        if (op == 0x1) onText(String(data, Charsets.UTF_8)) else onBinary(data)
    }

    fun sendText(s: String) {
        val payload = s.toByteArray(Charsets.UTF_8)
        Thread { try { sendFrame(0x1, payload) } catch (_: IOException) { } }.start()
    }

    private fun sendFrame(op: Int, payload: ByteArray) {
        if (!open) return
        val mask = ByteArray(4).also { rnd.nextBytes(it) }
        val head = java.io.ByteArrayOutputStream()
        head.write(0x80 or op)
        when {
            payload.size < 126 -> head.write(0x80 or payload.size)
            payload.size < 65536 -> { head.write(0x80 or 126); head.write(payload.size shr 8); head.write(payload.size and 0xff) }
            else -> {
                head.write(0x80 or 127)
                for (i in 7 downTo 0) head.write(((payload.size.toLong() shr (8 * i)) and 0xff).toInt())
            }
        }
        head.write(mask)
        val body = ByteArray(payload.size) { (payload[it].toInt() xor mask[it and 3].toInt()).toByte() }
        synchronized(writeLock) {
            output.write(head.toByteArray())
            output.write(body)
            output.flush()
        }
    }

    fun close() {
        if (open) try { sendFrame(0x8, ByteArray(0)) } catch (_: Exception) { }
        open = false
        try { sock.close() } catch (_: Exception) { }
    }
}
