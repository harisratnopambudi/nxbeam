package com.harisdevlab.nxbeam

import android.content.Context

/** the few things the app remembers */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("nxbeam", Context.MODE_PRIVATE)

    var lastHost: String
        get() = sp.getString("lastHost", "") ?: ""
        set(v) = sp.edit().putString("lastHost", v).apply()
    var hubAddress: String
        get() = sp.getString("hub", "") ?: ""
        set(v) = sp.edit().putString("hub", v).apply()
    var hubPin: String
        get() = sp.getString("hubPin", "") ?: ""
        set(v) = sp.edit().putString("hubPin", v).apply()
    /** 0 fastest, 1 balanced, 2 smoothest */
    var pictureMode: Int
        get() = sp.getInt("mode", 0)
        set(v) = sp.edit().putInt("mode", v).apply()
    var audio: Boolean
        get() = sp.getBoolean("audio", true)
        set(v) = sp.edit().putBoolean("audio", v).apply()
    var gamepad: Boolean
        get() = sp.getBoolean("gamepad", false)
        set(v) = sp.edit().putBoolean("gamepad", v).apply()
    /** the update build the user put off with Later */
    var updateSkip: Int
        get() = sp.getInt("updSkip", 0)
        set(v) = sp.edit().putInt("updSkip", v).apply()
    var showStats: Boolean
        get() = sp.getBoolean("stats", false)
        set(v) = sp.edit().putBoolean("stats", v).apply()

    companion object {
        /** delay used to even out arrival jitter, per picture mode */
        fun smoothingMs(mode: Int) = when (mode) { 1 -> 34; 2 -> 70; else -> 0 }
        /** sound buffer per picture mode */
        fun audioMs(mode: Int) = when (mode) { 1 -> 70; 2 -> 110; else -> 50 }
    }
}
