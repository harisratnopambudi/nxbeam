package com.harisdevlab.nxbeam

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest

/**
 * The Switch is on the local Wi-Fi (or Ethernet on a TV box). When that
 * network has no internet, Android sends an app's connections over mobile
 * data instead, and 10.x / 192.168.x addresses never answer there. Every
 * socket of the app is bound to the local network while one is up.
 */
object LocalNet {
    @Volatile private var started = false
    @Volatile var network: Network? = null
        private set

    fun start(context: Context) {
        if (started) return
        started = true
        val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val req = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        // pick one that is already up
        for (n in cm.allNetworks) {
            val c = cm.getNetworkCapabilities(n) ?: continue
            if (c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
                bind(cm, n); break
            }
        }
        cm.registerNetworkCallback(req, object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(n: Network) { bind(cm, n) }
            override fun onLost(n: Network) {
                if (n == network) { network = null; cm.bindProcessToNetwork(null) }
            }
        })
    }

    private fun bind(cm: ConnectivityManager, n: Network) {
        network = n
        try { cm.bindProcessToNetwork(n) } catch (_: Exception) { }
    }
}
