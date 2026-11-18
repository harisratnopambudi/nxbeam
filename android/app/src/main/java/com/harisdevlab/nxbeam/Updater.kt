package com.harisdevlab.nxbeam

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.ConnectivityManager
import android.os.Build
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Online updates. Every release carries latest.json with its build number (the
 * CI run): a higher one than this APK's means an update. The APK is checked
 * against its SHA-256 and handed to Android's installer, which asks the user.
 */
object Updater {
    private const val REPO = "harisratnopambudi/nxbeam"
    private const val LATEST = "https://github.com/$REPO/releases/latest/download/latest.json"
    const val APK = "NXBeam-Android.apk"

    data class Latest(val version: String, val build: Int, val sha256: String, val size: Long)

    val enabled get() = BuildConfig.BUILD_NUMBER > 0

    /* the app binds its sockets to the local Wi-Fi (LocalNet); the update comes from the internet */
    private fun open(context: Context, url: String): HttpURLConnection {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val u = URL(url)
        val net = cm.activeNetwork
        val c = (if (net != null) net.openConnection(u) else u.openConnection()) as HttpURLConnection
        c.connectTimeout = 10000; c.readTimeout = 20000
        c.setRequestProperty("user-agent", "NXBeam-Android")
        c.instanceFollowRedirects = true
        return c
    }

    /** blocking: null when there is nothing newer (or no network) */
    fun check(context: Context): Latest? {
        if (!enabled) return null
        return try {
            val c = open(context, LATEST)
            val j = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            c.disconnect()
            val f = j.optJSONObject("files")?.optJSONObject(APK) ?: return null
            val l = Latest(j.getString("version"), j.getInt("build"), f.getString("sha256"), f.optLong("size"))
            if (l.build > BuildConfig.BUILD_NUMBER) l else null
        } catch (_: Exception) { null }
    }

    /** blocking: downloads and verifies the APK, reporting 0..100 */
    fun download(context: Context, l: Latest, progress: (Int) -> Unit): File {
        val out = File(context.cacheDir, "update.apk")
        val c = open(context, "https://github.com/$REPO/releases/download/v${l.version}/$APK")
        val total = if (c.contentLengthLong > 0) c.contentLengthLong else l.size
        val md = MessageDigest.getInstance("SHA-256")
        var got = 0L
        var last = -1
        c.inputStream.use { input ->
            out.outputStream().use { o ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    o.write(buf, 0, n); md.update(buf, 0, n); got += n
                    val p = if (total > 0) (got * 100 / total).toInt() else 0
                    if (p != last) { last = p; progress(p) }
                }
            }
        }
        c.disconnect()
        val sum = md.digest().joinToString("") { "%02x".format(it) }
        if (sum != l.sha256) { out.delete(); throw IllegalStateException("checksum") }
        return out
    }

    /** hands the APK to Android's installer; it asks the user to confirm */
    fun install(context: Context, apk: File) {
        val pi = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(context.packageName)
        val id = pi.createSession(params)
        pi.openSession(id).use { s ->
            s.openWrite("nxbeam.apk", 0, apk.length()).use { o ->
                apk.inputStream().use { it.copyTo(o) }
                s.fsync(o)
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val intent = Intent(context, InstallResult::class.java)
            s.commit(PendingIntent.getBroadcast(context, id, intent, flags).intentSender)
        }
    }

    /** the installer's answers: ask the user, then report the outcome */
    class InstallResult : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -1)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    @Suppress("DEPRECATION")
                    val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                    context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                PackageInstaller.STATUS_SUCCESS -> { }
                else -> {
                    val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""
                    Toast.makeText(context, context.getString(R.string.upd_failed, msg), Toast.LENGTH_LONG).show()
                }
            }
        }
    }
}
