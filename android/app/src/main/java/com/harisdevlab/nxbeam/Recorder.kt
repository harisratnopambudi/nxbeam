package com.harisdevlab.nxbeam

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Handler
import android.os.HandlerThread
import java.nio.ByteBuffer

/**
 * Records to MP4: the H.264 from the console as it is (no re-encode) and the
 * game sound encoded to AAC. Starts on a keyframe.
 */
class Recorder(
    private val out: MediaFile,
    private val withAudio: Boolean,
) {
    private val thread = HandlerThread("nxbeam-rec").apply { start() }
    private val handler = Handler(thread.looper)
    private var muxer: MediaMuxer? = null
    private var started = false
    private var videoTrack = -1
    private var audioTrack = -1
    private var videoFormat: MediaFormat? = null
    private var audioFormat: MediaFormat? = null
    private var aac: MediaCodec? = null
    private var aacRate = 0
    private var aacCh = 0
    private var t0 = -1L
    private var audioBaseUs = -1L
    private var audioSamples = 0L
    private var lastVideoUs = -1L
    private var lastAudioUs = -1L
    private var createdAt = System.nanoTime()
    private val held = ArrayList<Sample>() // samples kept until the muxer can start
    @Volatile var bytes = 0L
    @Volatile var failed = false
    private var wrote = false

    private class Sample(val audio: Boolean, val data: ByteArray, val us: Long, val key: Boolean)

    fun video(data: ByteArray, key: Boolean, w: Int, h: Int, ns: Long) = handler.post {
        if (failed) return@post
        if (videoFormat == null) {
            if (!key) return@post
            val p = H264.params(data) ?: return@post
            videoFormat = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
                setByteBuffer("csd-0", ByteBuffer.wrap(H264.withStartCode(p.first)))
                setByteBuffer("csd-1", ByteBuffer.wrap(H264.withStartCode(p.second)))
            }
            t0 = ns
        }
        var us = (ns - t0) / 1000
        if (us <= lastVideoUs) us = lastVideoUs + 1
        lastVideoUs = us
        write(Sample(false, data, us, key))
    }

    fun audio(pcm: ByteArray, rate: Int, ch: Int, ns: Long) = handler.post {
        if (failed || !withAudio || t0 < 0) return@post
        if (aac == null) {
            if (started) return@post // the sound came late: the file carries video only
            openAac(rate, ch) ?: return@post
            audioBaseUs = (ns - t0) / 1000
        }
        if (rate != aacRate || ch != aacCh) return@post
        encode(pcm)
    }

    private fun openAac(rate: Int, ch: Int): MediaCodec? {
        return try {
            val f = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, rate, ch).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, 192_000)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 64 * 1024)
            }
            MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC).apply {
                configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                start()
                aac = this; aacRate = rate; aacCh = ch
            }
        } catch (e: Exception) { null }
    }

    private fun encode(pcm: ByteArray) {
        val c = aac ?: return
        var off = 0
        while (off < pcm.size) {
            val idx = c.dequeueInputBuffer(10_000)
            if (idx < 0) { drainAac(); continue }
            val buf = c.getInputBuffer(idx)!!
            buf.clear()
            val n = minOf(buf.remaining(), pcm.size - off)
            buf.put(pcm, off, n)
            val us = audioBaseUs + audioSamples * 1_000_000L / aacRate
            c.queueInputBuffer(idx, 0, n, us, 0)
            audioSamples += n / (2 * aacCh)
            off += n
        }
        drainAac()
    }

    private fun drainAac() {
        val c = aac ?: return
        val info = MediaCodec.BufferInfo()
        while (true) {
            val idx = c.dequeueOutputBuffer(info, 0)
            if (idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { audioFormat = c.outputFormat; tryStart(); continue }
            if (idx < 0) break
            if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0) {
                val b = c.getOutputBuffer(idx)!!
                val data = ByteArray(info.size)
                b.position(info.offset); b.get(data)
                var us = info.presentationTimeUs
                if (us <= lastAudioUs) us = lastAudioUs + 1
                lastAudioUs = us
                write(Sample(true, data, us, false))
            }
            c.releaseOutputBuffer(idx, false)
        }
    }

    private fun write(s: Sample) {
        if (!started) {
            held.add(s)
            tryStart()
            return
        }
        put(s)
    }

    /* start once every track is known; without sound after 1.5 s, go on with video only */
    private fun tryStart() {
        if (started || videoFormat == null) return
        val audioReady = !withAudio || audioFormat != null ||
            (aac == null && System.nanoTime() - createdAt > 1_500_000_000L)
        if (!audioReady) {
            if (held.size > 600) failed = true
            return
        }
        try {
            val m = MediaMuxer(out.pfd!!.fileDescriptor, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            videoTrack = m.addTrack(videoFormat!!)
            audioFormat?.let { audioTrack = m.addTrack(it) }
            m.start()
            muxer = m
            started = true
            for (s in held) put(s)
            held.clear()
        } catch (e: Exception) { failed = true }
    }

    private fun put(s: Sample) {
        val m = muxer ?: return
        val track = if (s.audio) audioTrack else videoTrack
        if (track < 0) return
        val info = MediaCodec.BufferInfo()
        info.set(0, s.data.size, s.us, if (s.key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
        try {
            m.writeSampleData(track, ByteBuffer.wrap(s.data), info)
            bytes += s.data.size
            wrote = true
        } catch (e: Exception) { failed = true }
    }

    /** finishes the file; calls back with whether anything was saved */
    fun stop(done: (Boolean) -> Unit) = handler.post {
        try { aac?.let { drainAac(); it.stop(); it.release() } } catch (_: Exception) { }
        aac = null
        var ok = false
        try { muxer?.let { it.stop(); it.release(); ok = wrote } } catch (_: Exception) { }
        muxer = null
        out.finish(ok)
        thread.quitSafely()
        done(ok)
    }
}
