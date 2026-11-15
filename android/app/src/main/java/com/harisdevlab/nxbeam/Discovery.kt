package com.harisdevlab.nxbeam

import android.content.Context
import android.net.wifi.WifiManager
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Finds consoles on the local network: the "SFTAP1 <ip> <port>" beacon on
 * UDP 9951, and (because many access points drop broadcasts between wireless
 * clients) a probe of every host of the local /24 on TCP 9950.
 */
class Discovery(context: Context, private val onFound: (host: String, port: Int) -> Unit) {
    private val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private var lock: WifiManager.MulticastLock? = null
    private var sock: DatagramSocket? = null
    private val running = AtomicBoolean(false)
    private val seen = HashSet<String>()

    fun start() {
        if (!running.compareAndSet(false, true)) return
        lock = wifi.createMulticastLock("nxbeam").apply { setReferenceCounted(false); acquire() }
        Thread({ listen() }, "nxbeam-beacon").start()
        Thread({ scan() }, "nxbeam-scan").start()
    }

    fun stop() {
        running.set(false)
        try { sock?.close() } catch (_: Exception) { }
        try { lock?.release() } catch (_: Exception) { }
    }

    /** probe the subnet again (the "search again" button) */
    fun rescan() { if (running.get()) Thread({ scan() }, "nxbeam-scan").start() }

    private fun found(host: String, port: Int) {
        synchronized(seen) { if (!seen.add("$host:$port")) return }
        onFound(host, port)
    }

    private fun listen() {
        try {
            val s = DatagramSocket(null).apply { reuseAddress = true; broadcast = true; bind(InetSocketAddress(Proto.BEACON_PORT)) }
            sock = s
            val buf = ByteArray(512)
            while (running.get()) {
                val p = DatagramPacket(buf, buf.size)
                s.receive(p)
                val text = String(p.data, 0, p.length, Charsets.ISO_8859_1)
                val m = Regex("^SFTAP1\\s+(\\S+)\\s+(\\d+)").find(text) ?: continue
                val host = p.address.hostAddress ?: continue
                found(host, m.groupValues[2].toIntOrNull() ?: Proto.NET_PORT)
            }
        } catch (_: Exception) { }
    }

    private fun scan() {
        val hosts = ArrayList<String>()
        for (self in localAddresses()) {
            val base = self.substringBeforeLast('.') + "."
            for (i in 1..254) { val h = base + i; if (h != self) hosts.add(h) }
        }
        if (hosts.isEmpty()) return
        val pool = Executors.newFixedThreadPool(48)
        for (h in hosts) pool.execute {
            if (!running.get()) return@execute
            try {
                Socket().use { it.connect(InetSocketAddress(h, Proto.NET_PORT), 700) }
                found(h, Proto.NET_PORT)
            } catch (_: Exception) { }
        }
        pool.shutdown()
        pool.awaitTermination(30, TimeUnit.SECONDS)
    }

    companion object {
        fun localAddresses(): List<String> = try {
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback }
                .filter { n -> listOf("rmnet", "ccmni", "tun", "dummy", "p2p", "v4-").none { n.name.startsWith(it) } }
                .flatMap { it.inetAddresses.toList() }
                .filterIsInstance<Inet4Address>()
                .mapNotNull { it.hostAddress }
                .filter { !it.startsWith("169.254.") }
        } catch (_: Exception) { emptyList() }
    }
}
