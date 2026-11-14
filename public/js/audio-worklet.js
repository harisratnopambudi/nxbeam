/*
 * NXBeam audio: runs on the browser's audio thread.
 *
 * The console sends 16-bit PCM in ~21 ms chunks, but from a ~340 ms ring, so
 * after any stall it sends a burst. Everything goes into a ring buffer here;
 * playback runs a hair faster or slower (at most 0.6 %, inaudible) to hold
 * the fill at the target, which also absorbs the console's and the sound
 * card's clocks drifting apart. Nothing is dropped unless the backlog passes
 * ~400 ms. After an underrun the target grows by 25 ms (up to +300 ms) and
 * shrinks back slowly while playback is clean.
 */
class NxbPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 1 << 17;                      // frames (~2.7 s at 48 kHz)
    this.L = new Float32Array(this.cap);
    this.R = new Float32Array(this.cap);
    this.w = 0;                              // frames written (total)
    this.r = 0;                              // read position (fractional, total)
    this.srcRate = 48000;
    this.targetMs = 60;
    this.extraMs = 0;
    this.priming = true;
    this.fadeIn = 0;
    this.underruns = 0;
    this.dropped = 0;
    this.cleanFrames = 0;
    this.lastL = 0; this.lastR = 0;
    this.statAt = 0;
    const onMsg = (m) => {
      if (!m) return;
      if (m.type === 'cfg') { if (m.targetMs) this.targetMs = m.targetMs; return; }
      if (m.type === 'flush') { this.r = this.w; this.priming = true; return; }
      if (m.buf) this.push(m.buf, m.off || 0, m.rate, m.ch);
    };
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) { e.data.port.onmessage = (ev) => onMsg(ev.data); return; }
      onMsg(e.data);
    };
  }

  push(buf, off, rate, ch) {
    if (!ch) return;
    if (rate && rate !== this.srcRate) { this.srcRate = rate; this.r = this.w; this.priming = true; }
    const s = new Int16Array(buf, off, Math.floor((buf.byteLength - off) / 2));
    const n = Math.floor(s.length / ch);
    const cap = this.cap;
    // never overwrite what has not been played: drop the oldest instead
    if (this.w + n - this.r > cap - 256) { const drop = this.w + n - this.r - (cap - 256); this.r += drop; this.dropped += drop; }
    let w = this.w;
    for (let i = 0; i < n; i++) {
      const k = w & (cap - 1);
      const a = s[i * ch] / 32768;
      this.L[k] = a;
      this.R[k] = ch > 1 ? s[i * ch + 1] / 32768 : a;
      w++;
    }
    this.w = w;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const len = oL.length;
    const cap = this.cap;
    const target = ((this.targetMs + this.extraMs) / 1000) * this.srcRate;
    let fill = this.w - this.r;

    if (this.priming) {
      if (fill < target) { oL.fill(0); if (oR !== oL) oR.fill(0); this._stats(fill); return true; }
      this.priming = false;
      this.fadeIn = 256;
      // start from exactly the target, not from a burst's worth of old sound
      if (fill > target * 1.5) { this.r = this.w - target; fill = target; }
    }
    // a backlog no correction could ever drain: jump to the target
    if (fill > target + 0.4 * this.srcRate) { this.dropped += fill - target; this.r = this.w - target; fill = target; }

    const err = (fill - target) / this.srcRate;             // seconds above/below target
    const adj = Math.max(-0.006, Math.min(0.006, err * 0.06));
    const step = (this.srcRate / sampleRate) * (1 + adj);

    for (let i = 0; i < len; i++) {
      if (this.w - this.r < 2) {
        // ran dry: fade what is left to silence, wait for the target again, keep more in hand
        for (let j = i; j < len; j++) {
          const g = Math.max(0, 1 - (j - i) / 32);
          oL[j] = this.lastL * g; oR[j] = this.lastR * g;
        }
        this.priming = true;
        this.underruns++;
        this.extraMs = Math.min(300, this.extraMs + 25);
        this.cleanFrames = 0;
        break;
      }
      const ri = Math.floor(this.r);
      const f = this.r - ri;
      const k0 = ri & (cap - 1), k1 = (ri + 1) & (cap - 1);
      let l = this.L[k0] + (this.L[k1] - this.L[k0]) * f;
      let r = this.R[k0] + (this.R[k1] - this.R[k0]) * f;
      if (this.fadeIn > 0) { const g = 1 - this.fadeIn / 256; l *= g; r *= g; this.fadeIn--; }
      oL[i] = l; if (oR !== oL) oR[i] = r;
      this.lastL = l; this.lastR = r;
      this.r += step;
    }
    // clean for 20 s: give back 10 ms of the extra delay
    this.cleanFrames += len;
    if (this.extraMs > 0 && this.cleanFrames > sampleRate * 20) { this.extraMs = Math.max(0, this.extraMs - 10); this.cleanFrames = 0; }
    this._stats(this.w - this.r);
    return true;
  }

  _stats(fill) {
    if (currentTime - this.statAt < 1) return;
    this.statAt = currentTime;
    this.port.postMessage({
      type: 'stats', fillMs: Math.round((fill / this.srcRate) * 1000),
      targetMs: Math.round(this.targetMs + this.extraMs), underruns: this.underruns,
      droppedMs: Math.round((this.dropped / this.srcRate) * 1000),
    });
  }
}
registerProcessor('nxb-pcm', NxbPcm);
