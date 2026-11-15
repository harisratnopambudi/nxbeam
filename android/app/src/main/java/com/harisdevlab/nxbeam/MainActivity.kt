package com.harisdevlab.nxbeam

import android.app.Activity
import android.app.AlertDialog
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.RelativeSizeSpan
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView

class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var usb: UsbManager
    private var discovery: Discovery? = null
    private val found = LinkedHashSet<String>()

    private lateinit var wifiStatus: TextView
    private lateinit var consoleList: LinearLayout
    private lateinit var ipInput: EditText
    private lateinit var usbStatus: TextView
    private lateinit var usbConnect: Button
    private lateinit var hubInput: EditText
    private lateinit var modeButtons: List<Button>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)
        usb = getSystemService(Context.USB_SERVICE) as UsbManager

        // on wide screens (TV, tablets) keep the column readable
        val column = findViewById<LinearLayout>(R.id.column)
        val dm = resources.displayMetrics
        if (dm.widthPixels / dm.density > 760) {
            column.layoutParams = FrameLayout.LayoutParams((640 * dm.density).toInt(), FrameLayout.LayoutParams.WRAP_CONTENT)
                .apply { gravity = android.view.Gravity.CENTER_HORIZONTAL }
        }

        wifiStatus = findViewById(R.id.wifiStatus)
        consoleList = findViewById(R.id.consoleList)
        ipInput = findViewById(R.id.ipInput)
        usbStatus = findViewById(R.id.usbStatus)
        usbConnect = findViewById(R.id.usbConnect)
        hubInput = findViewById(R.id.hubInput)

        ipInput.setText(prefs.lastHost)
        hubInput.setText(prefs.hubAddress)
        findViewById<Button>(R.id.ipConnect).setOnClickListener { connectIp() }
        ipInput.setOnEditorActionListener { _, id, _ -> if (id == EditorInfo.IME_ACTION_GO) { connectIp(); true } else false }
        findViewById<Button>(R.id.hubConnect).setOnClickListener { openHub() }
        hubInput.setOnEditorActionListener { _, id, _ -> if (id == EditorInfo.IME_ACTION_GO) { openHub(); true } else false }
        findViewById<View>(R.id.rescan).setOnClickListener { rescan() }
        usbConnect.setOnClickListener { connectUsb() }
        findViewById<View>(R.id.usbCheck).setOnClickListener { usbCheck() }

        modeButtons = listOf(R.id.modeLatency, R.id.modeBalanced, R.id.modeSmooth).map { findViewById(it) }
        modeButtons.forEachIndexed { i, b -> b.setOnClickListener { prefs.pictureMode = i; showMode() } }
        showMode()
        findViewById<Switch>(R.id.audioSwitch).apply {
            isChecked = prefs.audio
            setOnCheckedChangeListener { _, on -> prefs.audio = on }
        }
        findViewById<Switch>(R.id.padSwitch).apply {
            isChecked = prefs.gamepad
            setOnCheckedChangeListener { _, on -> prefs.gamepad = on }
        }
        val version = try { packageManager.getPackageInfo(packageName, 0).versionName } catch (_: Exception) { "" }
        findViewById<TextView>(R.id.footer).text = getString(R.string.footer, version)

        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_USB_HOST)) {
            usbStatus.setText(R.string.usb_no_host)
            usbConnect.isEnabled = false
        }
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(i: Intent?) {
        handleUsbIntent(i)
        handleLink(i)
    }

    /* nxbeam://wifi/192.168.1.20  nxbeam://hub/192.168.1.10:8090  nxbeam://usb */
    private fun handleLink(i: Intent?) {
        val u = i?.data ?: return
        if (u.scheme != "nxbeam") return
        val addr = u.path?.trim('/') ?: ""
        val host = addr.substringBefore(':')
        val port = addr.substringAfter(':', "").toIntOrNull()
        when (u.host) {
            "wifi" -> if (host.isNotEmpty()) play(Target(Target.WIFI, host, port ?: Proto.NET_PORT))
            "hub" -> if (host.isNotEmpty()) play(Target(Target.HUB, host, port ?: 8090, prefs.hubPin))
            "usb" -> connectUsb()
        }
        i.data = null
    }

    /* the Switch was plugged in and Android opened NXBeam for it: permission comes with that */
    private fun handleUsbIntent(i: Intent?) {
        if (i?.action == UsbManager.ACTION_USB_DEVICE_ATTACHED) {
            val dev = UsbSource.find(usb)
            if (dev != null && usb.hasPermission(dev)) play(Target(Target.USB))
        }
    }

    override fun onStart() {
        super.onStart()
        val f = IntentFilter().apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        registerSystemReceiver(usbEvents, f, exported = true)
        registerSystemReceiver(permission, IntentFilter(ACTION_PERMISSION), exported = false)
        showUsb()
        startDiscovery()
    }

    override fun onStop() {
        super.onStop()
        try { unregisterReceiver(usbEvents) } catch (_: Exception) { }
        try { unregisterReceiver(permission) } catch (_: Exception) { }
        discovery?.stop(); discovery = null
    }

    private fun registerSystemReceiver(r: BroadcastReceiver, f: IntentFilter, exported: Boolean) {
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(r, f, if (exported) Context.RECEIVER_EXPORTED else Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(r, f)
        }
    }

    /* ------------------------------------------------------------ Wi-Fi */
    private fun startDiscovery() {
        found.clear()
        consoleList.removeAllViews()
        if (Discovery.localAddresses().isEmpty()) {
            wifiStatus.setText(R.string.wifi_no_network)
            return
        }
        wifiStatus.setText(R.string.wifi_searching)
        discovery = Discovery(this) { host, port -> runOnUiThread { addConsole(host, port) } }.also { it.start() }
        wifiStatus.postDelayed({ if (found.isEmpty() && discovery != null) wifiStatus.setText(R.string.wifi_none) }, 6000)
    }

    private fun rescan() {
        discovery?.stop(); discovery = null
        startDiscovery()
    }

    private fun addConsole(host: String, port: Int) {
        if (!found.add("$host:$port")) return
        wifiStatus.setText(R.string.wifi_found)
        val b = layoutInflater.inflate(R.layout.item_console, consoleList, false) as Button
        b.text = SpannableStringBuilder(getString(R.string.console_found)).apply {
            append("\n")
            val at = length
            append(host)
            setSpan(RelativeSizeSpan(0.82f), at, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        b.setOnClickListener { prefs.lastHost = host; play(Target(Target.WIFI, host, port)) }
        consoleList.addView(b)
        if (consoleList.childCount == 1 && !ipInput.hasFocus() && !hubInput.hasFocus()) b.requestFocus()
    }

    private fun connectIp() {
        val text = ipInput.text.toString().trim()
        if (text.isEmpty()) { ipInput.requestFocus(); return }
        val host = text.substringBefore(':')
        val port = text.substringAfter(':', "").toIntOrNull() ?: Proto.NET_PORT
        prefs.lastHost = text
        play(Target(Target.WIFI, host, port))
    }

    /* ------------------------------------------------------------ USB */
    private fun showUsb() {
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_USB_HOST)) return
        val dev = UsbSource.find(usb)
        val nintendo = usb.deviceList.values.any { it.vendorId == NINTENDO_VID }
        usbStatus.setText(when {
            dev != null -> R.string.usb_present
            nintendo -> R.string.usb_switch_not_nxbeam
            else -> R.string.usb_absent
        })
        usbStatus.setTextColor(getColor(if (dev != null) R.color.ok else R.color.text))
    }

    /* everything this device sees on USB, and what it means */
    private fun usbCheck() {
        val list = usb.deviceList.values.toList()
        val lines = list.joinToString("\n") { d ->
            val name = listOfNotNull(d.manufacturerName, d.productName).joinToString(" ").ifBlank { "-" }
            "%04X:%04X  %s".format(d.vendorId, d.productId, name)
        }
        val verdict = when {
            list.any { it.vendorId == Proto.USB_VID && it.productId == Proto.USB_PID } -> getString(R.string.usb_check_ok)
            list.any { it.vendorId == NINTENDO_VID } -> getString(R.string.usb_switch_not_nxbeam)
            list.isEmpty() -> getString(R.string.usb_check_none)
            else -> getString(R.string.usb_check_other)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.usb_check)
            .setMessage(if (lines.isEmpty()) verdict else lines + "\n\n" + verdict)
            .setPositiveButton(android.R.string.ok, null)
            .show()
        showUsb()
    }

    private fun connectUsb() {
        val dev = UsbSource.find(usb)
        if (dev == null) { showUsb(); return }
        if (usb.hasPermission(dev)) { play(Target(Target.USB)); return }
        val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        val pi = PendingIntent.getBroadcast(this, 0, Intent(ACTION_PERMISSION).setPackage(packageName), flags)
        usb.requestPermission(dev, pi)
    }

    private val usbEvents = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) = showUsb()
    }

    private val permission = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            val granted = i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
            val dev = UsbSource.find(usb)
            if (granted || (dev != null && usb.hasPermission(dev))) play(Target(Target.USB))
            else usbStatus.setText(R.string.usb_denied)
        }
    }

    /* ------------------------------------------------------------ PC hub */
    private fun openHub(pin: String? = null) {
        var text = hubInput.text.toString().trim()
        if (text.isEmpty()) { hubInput.requestFocus(); return }
        text = text.removePrefix("http://").removePrefix("https://").trimEnd('/')
        val host = text.substringBefore(':').substringBefore('/')
        val port = text.substringAfter(':', "").substringBefore('/').toIntOrNull() ?: 8090
        prefs.hubAddress = text
        if (pin != null) prefs.hubPin = pin
        play(Target(Target.HUB, host, port, pin ?: prefs.hubPin))
    }

    private fun askPin() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            setHint(R.string.pin_hint)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.pin_title)
            .setView(input)
            .setPositiveButton(R.string.connect) { _, _ -> openHub(input.text.toString().trim()) }
            .show()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_PLAY && resultCode == PlayerActivity.RESULT_PIN) askPin()
    }

    /* ------------------------------------------------------------ */
    private fun showMode() {
        modeButtons.forEachIndexed { i, b ->
            val on = i == prefs.pictureMode
            b.setBackgroundResource(if (on) R.drawable.bg_chip_on else R.drawable.bg_chip)
            b.setTextColor(getColor(if (on) R.color.beam_ink else R.color.text))
        }
    }

    private fun play(t: Target) {
        discovery?.stop(); discovery = null
        val i = Intent(this, PlayerActivity::class.java)
            .putExtra("kind", t.kind).putExtra("host", t.host).putExtra("port", t.port).putExtra("pin", t.pin)
        @Suppress("DEPRECATION")
        startActivityForResult(i, REQ_PLAY)
    }

    companion object {
        const val ACTION_PERMISSION = "com.harisdevlab.nxbeam.USB_PERMISSION"
        const val REQ_PLAY = 7
        const val NINTENDO_VID = 0x057E
    }
}
