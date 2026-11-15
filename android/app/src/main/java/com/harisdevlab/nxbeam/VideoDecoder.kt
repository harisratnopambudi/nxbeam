package com.harisdevlab.nxbeam

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import java.util.ArrayDeque

/**
 * Hardware H.264 decode straight onto the screen surface.
 * Every access unit carries its arrival time as the presentation time, so
 * the pacing below can space frames evenly without waiting on the clock of
 * the console.
 */
class VideoDecoder(
    private val surface: Surface,
    private val onNeedKey: () -> Unit,
    private val onFormat: (w: Int, h: Int) -> Unit,
) {
    /** extra delay used to even out arrival jitter: 0 = show at once */
    @Volatile var smoothingMs = 0

    private val thread = HandlerThread("nxbeam-video", android.os.Process.THREAD_PRIORITY_URGENT_DISPLAY).apply { start() }
    private val handler = Handler(thread.looper)
    private var codec: MediaCodec? = null
    private var params: Pair<ByteArray, ByteArray>? = null
    private var width = 0
    private var height = 0
    private val freeInputs = ArrayDeque<Int>()
    private val pending = ArrayDeque<Pair<ByteArray, Long>>()
    private var waitKey = true
    @Volatile private var released = false

    /* stats, read by the UI */
    @Volatile var framesShown = 0L
    @Volatile var dropped = 0L
    @Volatile var decodeMs = 0f

    /* pacing state */
    private var lastShowNs = 0L
    private var intervalNs = 16_666_667L
    private var lastArrivalNs = 0L

    fun feed(data: ByteArray, key: Boolean, w: Int, h: Int, arrivalNs: Long) {
        handler.post { onUnit(data, key, w, h, arrivalNs) }
    }

    private fun onUnit(data: ByteArray, key: Boolean, w: Int, h: Int, arrivalNs: Long) {
        if (released) return
        if (key) {
            val p = H264.params(data)
            if (p != null) {
                val changed = codec == null || w != width || h != height ||
                    !p.first.contentEquals(params?.first) || !p.second.contentEquals(params?.second)
                if (changed) {
                    params = p; width = w; height = h
                    configure()
                    onFormat(w, h)
                }
            }
            waitKey = false
        }
        if (codec == null || waitKey) return
        if (lastArrivalNs > 0) {
            val d = arrivalNs - lastArrivalNs
            if (d in 5_000_000L..100_000_000L) intervalNs = (intervalNs * 7 + d) / 8
        }
        lastArrivalNs = arrivalNs
        // a long queue means the decoder fell behind: skip to the next keyframe
        if (pending.size > 12) {
            pending.clear()
            dropped += 12
            waitKey = true
            onNeedKey()
            return
        }
        pending.add(data to arrivalNs)
        pump()
    }

    private fun pump() {
        val c = codec ?: return
        while (pending.isNotEmpty() && freeInputs.isNotEmpty()) {
            val idx = freeInputs.poll()!!
            val (data, t) = pending.poll()!!
            try {
                val buf = c.getInputBuffer(idx) ?: continue
                if (data.size > buf.capacity()) { dropped++; waitKey = true; onNeedKey(); c.queueInputBuffer(idx, 0, 0, t / 1000, 0); continue }
                buf.clear(); buf.put(data)
                c.queueInputBuffer(idx, 0, data.size, t / 1000, 0)
            } catch (e: Exception) { restart(); return }
        }
    }

    private fun configure() {
        stopCodec()
        val (sps, pps) = params ?: return
        // level 0: every low-latency key, 1: without vendor keys, 2: the plain format
        fun format(level: Int) = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
            setByteBuffer("csd-0", java.nio.ByteBuffer.wrap(H264.withStartCode(sps)))
            setByteBuffer("csd-1", java.nio.ByteBuffer.wrap(H264.withStartCode(pps)))
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, maxOf(2 shl 20, width * height))
            if (level < 2) {
                if (Build.VERSION.SDK_INT >= 30) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                setInteger(MediaFormat.KEY_PRIORITY, 0)
                setInteger(MediaFormat.KEY_OPERATING_RATE, Short.MAX_VALUE.toInt())
            }
            if (level < 1) {
                setInteger("vendor.qti-ext-dec-low-latency.enable", 1)
                setInteger("vendor.qti-ext-dec-picture-order.enable", 1)
                setInteger("vendor.rtc-ext-dec-low-latency.enable", 1)
                setInteger("vendor.low-latency.enable", 1)
            }
        }
        val name = pickDecoder()
        val c = try { if (name != null) MediaCodec.createByCodecName(name) else MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC) }
            catch (e: Exception) { return }
        c.setCallback(callback, handler)
        // some decoders refuse the low-latency keys (the emulator's does): step down
        var ok = false
        for (level in 0..2) {
            try {
                c.configure(format(level), surface, null, 0)
                ok = true
                break
            } catch (e: Exception) {
                try { c.reset() } catch (_: Exception) { }
                c.setCallback(callback, handler)
            }
        }
        if (!ok) { c.release(); return }
        c.start()
        codec = c
        lastShowNs = 0
    }

    private val callback = object : MediaCodec.Callback() {
        override fun onInputBufferAvailable(mc: MediaCodec, index: Int) {
            if (mc !== codec) return
            freeInputs.add(index); pump()
        }
        override fun onOutputBufferAvailable(mc: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
            if (mc !== codec) return
            show(mc, index, info)
        }
        override fun onError(mc: MediaCodec, e: MediaCodec.CodecException) {
            if (mc === codec) restart()
        }
        override fun onOutputFormatChanged(mc: MediaCodec, format: MediaFormat) { }
    }

    private fun show(mc: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
        val now = System.nanoTime()
        val arrival = info.presentationTimeUs * 1000
        decodeMs = decodeMs * 0.9f + ((now - arrival) / 1e6f) * 0.1f
        try {
            if ((info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0 || info.size == 0 && info.flags != 0) {
                mc.releaseOutputBuffer(index, false); return
            }
            val delay = smoothingMs * 1_000_000L
            if (delay <= 0) {
                mc.releaseOutputBuffer(index, true)
                lastShowNs = now
            } else {
                // evenly spaced, but never later than arrival + delay and never in the past
                var at = if (lastShowNs == 0L) arrival + delay else lastShowNs + intervalNs
                if (at > arrival + delay) at = arrival + delay
                if (at < now) at = now
                mc.releaseOutputBuffer(index, at)
                lastShowNs = at
            }
            framesShown++
        } catch (_: Exception) { }
    }

    private fun restart() {
        stopCodec()
        waitKey = true
        pending.clear()
        if (params != null) configure()
        onNeedKey()
    }

    private fun stopCodec() {
        val c = codec ?: return
        codec = null
        freeInputs.clear()
        try { c.stop() } catch (_: Exception) { }
        try { c.release() } catch (_: Exception) { }
    }

    fun release() {
        released = true
        handler.post { stopCodec(); thread.quitSafely() }
    }

    /** prefer a hardware decoder that advertises low latency */
    private fun pickDecoder(): String? {
        val list = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter {
            !it.isEncoder && it.supportedTypes.any { t -> t.equals(MediaFormat.MIMETYPE_VIDEO_AVC, true) }
        }
        fun hw(i: MediaCodecInfo) = if (Build.VERSION.SDK_INT >= 29) i.isHardwareAccelerated
            else !i.name.startsWith("OMX.google.") && !i.name.startsWith("c2.android.")
        fun lowLat(i: MediaCodecInfo) = Build.VERSION.SDK_INT >= 30 &&
            i.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC).isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_LowLatency)
        return (list.firstOrNull { hw(it) && lowLat(it) } ?: list.firstOrNull { hw(it) })?.name
    }
}
