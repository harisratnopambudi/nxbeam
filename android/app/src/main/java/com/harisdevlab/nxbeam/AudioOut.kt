package com.harisdevlab.nxbeam

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Game sound: 16-bit PCM from the console, played through a low-latency
 * AudioTrack. A short queue absorbs bursts; when it runs far ahead of the
 * target the oldest packets go, so the sound never drifts behind the picture.
 */
class AudioOut {
    @Volatile var enabled = true
    @Volatile var targetMs = 60
    @Volatile var volume = 1f
        set(v) { field = v; track?.setVolume(v) }

    private val queue = LinkedBlockingQueue<ByteArray>()
    private val queued = java.util.concurrent.atomic.AtomicInteger()
    private val queuedBytes get() = queued.get()
    private var track: AudioTrack? = null
    private var rate = 0
    private var channels = 0
    private var written = 0L
    @Volatile private var running = true
    @Volatile var underruns = 0
    @Volatile var dropped = 0

    private val thread = Thread({ loop() }, "nxbeam-audio").apply {
        priority = Thread.MAX_PRIORITY
        start()
    }

    fun push(pcm: ByteArray, r: Int, ch: Int) {
        if (!enabled || !running) return
        if (r != rate || ch != channels) { formatPending = r to ch }
        queue.offer(pcm)
        queued.addAndGet(pcm.size)
    }

    @Volatile private var formatPending: Pair<Int, Int>? = null

    private fun bytesPerMs() = if (rate > 0) rate * channels * 2 / 1000 else 192

    private fun loop() {
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
        var playing = false
        while (running) {
            formatPending?.let { (r, ch) -> formatPending = null; open(r, ch); playing = false }
            val t = track
            if (t == null || !enabled) {
                drain(); Thread.sleep(20); continue
            }
            if (!playing) {
                // fill up to the target before starting, so the first gap does not come at once
                if (queuedBytes < targetMs * bytesPerMs()) { Thread.sleep(5); continue }
                t.play(); playing = true
            }
            val pcm = queue.poll(100, TimeUnit.MILLISECONDS) ?: continue
            queued.addAndGet(-pcm.size)
            // too far ahead: skip, so latency stays near the target
            val ahead = queuedBytes / bytesPerMs() + bufferedMs(t)
            if (ahead > targetMs + 120) { dropped++; continue }
            t.write(pcm, 0, pcm.size, AudioTrack.WRITE_BLOCKING)
            written += pcm.size / (2 * channels)
            underruns = t.underrunCount
        }
        track?.release()
    }

    private fun bufferedMs(t: AudioTrack): Int {
        val pending = written - (t.playbackHeadPosition.toLong() and 0xffffffffL)
        return if (rate > 0) (pending * 1000 / rate).toInt().coerceAtLeast(0) else 0
    }

    private fun drain() { queue.clear(); queued.set(0) }

    private fun open(r: Int, ch: Int) {
        track?.release()
        track = null
        rate = r; channels = ch; written = 0
        if (r <= 0 || ch !in 1..2) return
        val mask = if (ch == 1) AudioFormat.CHANNEL_OUT_MONO else AudioFormat.CHANNEL_OUT_STEREO
        val min = AudioTrack.getMinBufferSize(r, mask, AudioFormat.ENCODING_PCM_16BIT)
        track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_GAME)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(r).setChannelMask(mask)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(maxOf(min * 2, r * ch * 2 * 80 / 1000))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
            .build().apply { setVolume(volume) }
    }

    fun setOn(on: Boolean) {
        enabled = on
        if (!on) { track?.pause(); track?.flush(); written = 0; formatPending = rate to channels }
    }

    fun release() { running = false; drain() }
}
