/*
 * NXBeam player: H.264 Annex-B access units -> WebCodecs VideoDecoder ->
 * WebGL (color + contrast-adaptive sharpening) or 2D canvas fallback.
 * Audio: 16-bit PCM chunks scheduled on a Web Audio clock with a small jitter buffer.
 */

function codecFromAnnexB(u8) {
  // find the SPS (NAL type 7) and build avc1.PPCCLL
  for (let i = 0; i + 4 < u8.length; i++) {
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1 && (u8[i + 3] & 0x1f) === 7) {
      const h = (v) => v.toString(16).padStart(2, '0');
      return `avc1.${h(u8[i + 4])}${h(u8[i + 5])}${h(u8[i + 6])}`;
    }
  }
  return null;
}

const VERT = `attribute vec2 p; varying vec2 uv;
void main(){ uv = vec2((p.x+1.0)*0.5, 1.0-(p.y+1.0)*0.5); gl_Position = vec4(p,0.0,1.0); }`;
const FRAG = `precision mediump float;
varying vec2 uv; uniform sampler2D tex; uniform vec2 texel;
uniform float bright, contrast, sat, sharp;
vec3 px(vec2 o){ return texture2D(tex, uv + o*texel).rgb; }
void main(){
  vec3 c = px(vec2(0.0));
  if (sharp > 0.001) {
    // contrast-adaptive sharpening (AMD CAS style, single pass)
    vec3 n = px(vec2(0.0,-1.0)), s = px(vec2(0.0,1.0)), e = px(vec2(1.0,0.0)), w = px(vec2(-1.0,0.0));
    vec3 mn = min(c, min(min(n,s), min(e,w)));
    vec3 mx = max(c, max(max(n,s), max(e,w)));
    vec3 amp = sqrt(clamp(min(mn, 1.0-mx) / max(mx, 1e-4), 0.0, 1.0));
    vec3 wgt = -amp / mix(8.0, 5.0, sharp);
    c = clamp((c + (n+s+e+w)*wgt) / (1.0 + 4.0*wgt), 0.0, 1.0);
  }
  c = (c - 0.5) * contrast + 0.5 + bright;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, sat);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

/*
 * Frame pacing. Wi-Fi delivers frames unevenly (two at once, then a gap), and
 * drawing each one the moment it decodes turns that into visible judder.
 * Decoded frames wait in a small queue and leave it on a steady clock at the
 * source frame rate; the queue depth adapts to the measured jitter.
 *   latency: no queue, newest frame always (lowest delay, may judder)
 *   balanced: 1-3 frames (default)
 *   smooth:  2-6 frames
 */
const MODES = { latency: [0, 0], balanced: [1, 3], smooth: [2, 6] };

export class VideoPlayer {
  /*
   * canvas: an HTMLCanvasElement or an OffscreenCanvas (in a worker). The
   * player never touches the DOM: the page gives it the box size (setBox)
   * and gets the picture's CSS size back (onCssSize).
   */
  constructor(canvas, { onStats, onNeedKey, onFirstFrame, onCssSize, raf } = {}) {
    this.canvas = canvas;
    this.onStats = onStats || (() => {});
    this.onNeedKey = onNeedKey || (() => {});
    this.onFirstFrame = onFirstFrame || (() => {});
    this.onCssSize = onCssSize || (() => {});
    this.raf = raf || ((cb) => requestAnimationFrame(cb));
    this.decoder = null;
    this.codec = null;
    this.waitKey = true;
    this.frame = null;       // the frame on screen (kept for screenshots)
    this.queue = [];         // decoded frames waiting for their turn
    this.mode = 'balanced';
    this.dirty = false;
    this.adjust = { bright: 0, contrast: 1, sat: 1, sharp: 0.35 };
    this.stat = { decoded: 0, shown: 0, dropped: 0, skipped: 0, lat: 0, w: 0, h: 0, depth: 0, target: 0, jitter: 0, fps: 0, late: 0, hw: '', light: false, fpsIn: 0, cap: 0, capped: 0 };
    this.capMode = 'auto';
    this.cap = 0;
    this._skipMark = 0;
    this.light = false;
    this.arrivals = [];      // arrival times of the last chunks (ms)
    this.interval = 1000 / 60;
    this.jitter = 0;
    this.nextAt = 0;
    this.vsync = 16.7;
    this.lastRaf = 0;
    this.lastShown = 0;
    this.priming = true;
    this.recvTimes = new Map();
    this.box = { w: 0, h: 0 };
    this.dpr = 1;
    this.cssSize = '';
    this.supported = typeof globalThis.VideoDecoder === 'function';
    this._initGl();
    this._loop = this._loop.bind(this);
    this.raf(this._loop);
    setInterval(() => {
      this.stat.depth = this.queue.length;
      this.stat.target = this._target();
      this.stat.jitter = Math.round(this.jitter * 10) / 10;
      this.stat.fps = this.stat.shown;
      // the device keeps falling behind with frames waiting: switch to light rendering
      if (!this.light && this.stat.late >= 3 && this.stat.skipped > this._skipMark) this._lateRun = (this._lateRun || 0) + 1;
      else this._lateRun = 0;
      this._skipMark = this.stat.skipped;
      if (this._lateRun >= 3 && this.autoLight !== false) { this.light = true; this.dirty = true; }
      this.stat.light = !!this.light;
      this._governor();
      this.onStats({ ...this.stat });
      this.stat.decoded = 0; this.stat.shown = 0; this.stat.late = 0;
    }, 1000);
  }

  setBox(w, h, dpr) { this.box = { w, h }; this.dpr = Math.min(dpr || 1, 2); this.dirty = true; }

  setMode(m) { this.mode = MODES[m] ? m : 'balanced'; this.priming = true; }

  _initGl() {
    const gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, desynchronized: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) { this.ctx2d = this.canvas.getContext('2d', { alpha: false, desynchronized: true }); return; }
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { this.ctx2d = null; return; }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.gl = gl;
    this.u = Object.fromEntries(['texel', 'bright', 'contrast', 'sat', 'sharp'].map((n) => [n, gl.getUniformLocation(prog, n)]));
  }

  setAdjust(a) {
    Object.assign(this.adjust, a);
    if ('light' in a) this.light = !!a.light;
    if ('autoLight' in a) this.autoLight = a.autoLight;
    if ('fpsCap' in a) { this.capMode = a.fpsCap || 'auto'; this._down = 0; this._up = 0; this._applyCapMode(); }
    this.dirty = true;
  }

  /*
   * Frame-rate governor: show what the game can hold, never more.
   * The console sends one frame per game present, so the arrival rate is the
   * game's (or the console's) real rate. Uneven 35-50 fps judders on any
   * screen; locked to a steady 30 it does not. auto: lock 30 after 3 s at
   * 36-51 fps, let go after 5 s at 57+ (or 3 s at a game's own 30, which the
   * normal pacer follows more smoothly than a fixed clock could). Menus and loading screens (under
   * 20 fps) change nothing.
   */
  _fpsIn() {
    const a = this.arrivals, now = performance.now();
    let n = 0;
    for (let i = a.length - 1; i >= 0 && now - a[i] <= 1000; i--) n++;
    return n;
  }

  _applyCapMode() {
    if (this.capMode === '30') this.cap = 30;
    else if (this.capMode === '60' || this.capMode === 'off') this.cap = 0;
  }

  _governor() {
    const fin = this._fpsIn();
    this.stat.fpsIn = fin;
    if ((this.capMode || 'auto') === 'auto') {
      // a game that runs at 30 is paced on its own rhythm (smooth already); the lock is
      // only for the uneven middle: more than 30, not a steady 60
      if (this.cap !== 30) {
        this._down = fin >= 36 && fin < 52 ? (this._down || 0) + 1 : 0;
        if (this._down >= 3) { this.cap = 30; this._down = 0; this._up = 0; this._low = 0; }
      } else {
        this._up = fin >= 57 ? (this._up || 0) + 1 : 0;
        this._low = fin >= 20 && fin < 34 ? (this._low || 0) + 1 : 0;
        if (this._up >= 5 || this._low >= 3) { this.cap = 0; this._up = 0; this._low = 0; this.priming = true; }
      }
    } else this._applyCapMode();
    this.stat.cap = this.cap || 0;
  }

  /* one access unit from the hub */
  push(u8, key, width, height) {
    if (!this.supported) return;
    const now = performance.now();
    this._arrival(now);
    if (key) {
      const codec = codecFromAnnexB(u8);
      if (codec && (codec !== this.codec || !this.decoder || this.decoder.state === 'closed')) {
        this._configure(codec, width, height);
        this.pendingKey = { u8: u8.slice(), w: width, h: height };
        return;
      }
      this.waitKey = false;
    }
    if (this.waitKey || !this.decoder || this.decoder.state !== 'configured') {
      if (key && this.decoder && this.decoder.state === 'unconfigured') this.pendingKey = { u8: u8.slice(), w: width, h: height };
      return;
    }
    if (this.decoder.decodeQueueSize > 60) {
      // the device really cannot keep up: skip to the next keyframe
      this.stat.dropped++;
      this.waitKey = true;
      this.onNeedKey();
      return;
    }
    const ts = Math.round(now * 1000);
    this.recvTimes.set(ts, now);
    if (this.recvTimes.size > 240) this.recvTimes.delete(this.recvTimes.keys().next().value);
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data: u8 }));
    } catch (e) {
      this._fail(e);
    }
  }

  /* source frame interval and network jitter, from arrival times */
  _arrival(now) {
    const a = this.arrivals;
    const prev = a.length ? a[a.length - 1] : 0;
    a.push(now);
    if (a.length > 90) a.shift();
    if (a.length >= 30) {
      // median spacing is robust against bursts
      const d = [];
      for (let i = 1; i < a.length; i++) d.push(a[i] - a[i - 1]);
      d.sort((x, y) => x - y);
      let iv = (a[a.length - 1] - a[0]) / (a.length - 1);
      const med = d[d.length >> 1];
      if (med > 4) iv = Math.min(iv, Math.max(med, iv * 0.9));
      for (const n of [1000 / 60, 1000 / 30, 1000 / 50, 1000 / 20]) if (Math.abs(iv - n) / n < 0.08) iv = n;
      this.interval = Math.max(1000 / 120, Math.min(100, iv));
    }
    if (prev && now - prev < 1000) {
      const dev = Math.abs(now - prev - this.interval);
      // rises fast, falls slowly: one hiccup keeps the buffer up for a while
      this.jitter = dev > this.jitter ? this.jitter * 0.7 + dev * 0.3 : this.jitter * 0.995 + dev * 0.005;
    }
  }

  _target() {
    const [lo, hi] = MODES[this.mode];
    if (!hi) return 0;
    return Math.max(lo, Math.min(hi, Math.ceil((this.jitter * 1.6) / this.interval)));
  }

  _configure(codec, width, height) {
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch { /* ignore */ } }
    this._flushQueue();
    this.codec = codec;
    this.decoder = new VideoDecoder({
      output: (f) => this._output(f),
      error: (e) => this._fail(e),
    });
    const base = { codec, codedWidth: width, codedHeight: height, optimizeForLatency: true };
    const decoder = this.decoder;
    // 1080p60 in software can eat a whole CPU core: ask for the GPU's decoder when the browser has one
    const pick = async () => {
      for (const hw of ['prefer-hardware', 'no-preference']) {
        try { const r = await VideoDecoder.isConfigSupported({ ...base, hardwareAcceleration: hw }); if (r.supported) return hw; } catch { /* next */ }
      }
      return 'no-preference';
    };
    this.waitKey = true; // the first keyframe is replayed once the decoder is configured
    pick().then((hw) => {
      if (this.decoder !== decoder || decoder.state === 'closed') return;
      this.stat.hw = hw === 'prefer-hardware' ? 'gpu' : 'auto';
      try { decoder.configure({ ...base, hardwareAcceleration: hw }); } catch (e) { this._fail(e); return; }
      if (this.pendingKey) { const k = this.pendingKey; this.pendingKey = null; this.waitKey = false; this.push(k.u8, true, k.w, k.h); }
    });
  }

  _fail(e) {
    console.warn('decoder:', e);
    this.codec = null;
    this.waitKey = true;
    this.onNeedKey();
  }

  _output(f) {
    const t0 = this.recvTimes.get(f.timestamp);
    if (t0 !== undefined) { this.stat.lat = Math.round(performance.now() - t0); this.recvTimes.delete(f.timestamp); }
    this.stat.decoded++;
    this.queue.push(f);
    // a hardware decoder has few buffers: never hold many
    while (this.queue.length > 8) { this.queue.shift().close(); this.stat.skipped++; }
  }

  _show(f) {
    const t = performance.now();
    const iv = this.cap === 30 ? 1000 / 30 : this.interval;
    if (this.lastShown && t - this.lastShown > iv * 1.6 + this.vsync / 2) this.stat.late++;
    this.lastShown = t;
    if (this.frame) this.frame.close();
    const first = !this.stat.w;
    this.frame = f;
    this.stat.shown++;
    this.stat.w = f.displayWidth; this.stat.h = f.displayHeight;
    this.dirty = true;
    if (first) this.onFirstFrame();
  }

  _pace(now) {
    const q = this.queue;
    if (this.cap === 30) {
      // locked 30: one picture every 33.3 ms (every other refresh at 60 Hz), always the newest
      const step = 1000 / 30;
      if (!this.nextAt || now - this.nextAt > step * 3) this.nextAt = now;
      if (now + this.vsync / 2 < this.nextAt) return;
      this.nextAt += step;
      if (this.nextAt < now - step) this.nextAt = now;
      if (!q.length) return; // nothing new: the last picture stays, the cadence goes on
      // keep one frame in hand so a slightly late arrival does not leave the next tick empty
      while (q.length > 2) { q.shift().close(); this.stat.capped = (this.stat.capped || 0) + 1; }
      this._show(q.shift());
      return;
    }
    const target = this._target();
    if (target === 0) {
      // lowest latency: always the newest frame
      if (!q.length) return;
      while (q.length > 1) { q.shift().close(); this.stat.skipped++; }
      this._show(q.shift());
      return;
    }
    if (this.priming) {
      if (q.length < target) return;
      this.priming = false;
      this.nextAt = now;
    }
    // too far behind (a burst after a stall): drop the oldest, keep the motion current
    while (q.length > target + 3) { q.shift().close(); this.stat.skipped++; }
    if (now + this.vsync / 2 < this.nextAt) return;
    if (!q.length) { this.priming = true; return; } // ran dry: refill to the target first
    this._show(q.shift());
    // nudge the clock so the queue stays near its target without dropping frames
    let step = this.interval;
    if (q.length > target) step *= 0.92; else if (q.length < target - 1) step *= 1.04;
    this.nextAt += step;
    if (this.nextAt < now - this.interval) this.nextAt = now; // fell behind a whole frame: resync
  }

  _flushQueue() { for (const f of this.queue) f.close(); this.queue = []; this.priming = true; }

  _loop() {
    this.raf(this._loop);
    const now = performance.now();
    if (this.lastRaf) { const d = now - this.lastRaf; if (d > 2 && d < 50) this.vsync = this.vsync * 0.95 + d * 0.05; }
    this.lastRaf = now;
    this._pace(now);
    if (!this.dirty || !this.frame) return;
    this.dirty = false;
    const f = this.frame;
    const c = this.canvas;
    const dpr = this.dpr;
    if (!this.box.w || !this.box.h) return;
    // fit the picture inside the box, keep its aspect
    const ar = f.displayWidth / f.displayHeight;
    let w = this.box.w, h = this.box.w / ar;
    if (h > this.box.h) { h = this.box.h; w = h * ar; }
    /*
     * Backing store: a 1080p picture is drawn at (at most) its own size and
     * the compositor scales it up for free; only smaller pictures get the
     * sharpened upscale, up to 2x. In light mode (the device fell behind)
     * nothing is drawn larger than the picture and sharpening is off.
     */
    const maxScale = this.light || f.displayHeight >= 1000 || this.adjust.sharp < 0.01 ? 1 : 2;
    const scale = Math.min((w * dpr) / f.displayWidth, maxScale);
    const bw = Math.max(2, Math.round(f.displayWidth * scale)), bh = Math.max(2, Math.round(f.displayHeight * scale));
    if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
    const css = `${Math.round(w)}x${Math.round(h)}`;
    if (css !== this.cssSize) { this.cssSize = css; this.onCssSize(Math.round(w), Math.round(h)); }
    if (this.gl) {
      const gl = this.gl;
      gl.viewport(0, 0, bw, bh);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, f); } catch { this.gl = null; return; }
      const a = this.adjust;
      gl.uniform2f(this.u.texel, 1 / f.displayWidth, 1 / f.displayHeight);
      gl.uniform1f(this.u.bright, a.bright); gl.uniform1f(this.u.contrast, a.contrast);
      gl.uniform1f(this.u.sat, a.sat); gl.uniform1f(this.u.sharp, this.light ? 0 : a.sharp);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else if (this.ctx2d) {
      this.ctx2d.drawImage(f, 0, 0, bw, bh);
    }
  }

  /* native-resolution PNG of the current picture */
  async screenshot() {
    if (!this.frame) return null;
    const f = this.frame;
    if (typeof OffscreenCanvas === 'function') {
      const oc = new OffscreenCanvas(f.displayWidth, f.displayHeight);
      oc.getContext('2d').drawImage(f, 0, 0);
      return oc.convertToBlob({ type: 'image/png' });
    }
    const oc = document.createElement('canvas');
    oc.width = f.displayWidth; oc.height = f.displayHeight;
    oc.getContext('2d').drawImage(f, 0, 0);
    return new Promise((res) => oc.toBlob(res, 'image/png'));
  }

  reset() {
    this._flushQueue();
    if (this.frame) { this.frame.close(); this.frame = null; }
    this.waitKey = true;
    this.stat.w = 0;
  }
}

/*
 * Game audio. With AudioWorklet (all current browsers) the sound is buffered
 * and paced on the audio thread (audio-worklet.js), and the media worker can
 * feed it directly through a MessagePort, so the page's main thread is not in
 * the path at all. Older browsers get the scheduled-buffer fallback.
 */
export class AudioPlayer {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.node = null;
    this.volume = 1;
    this._targetMs = 60;
    this.enabled = false;
    this.stats = { fillMs: 0, targetMs: 0, underruns: 0, droppedMs: 0 };
    this.initPromise = null;
    // fallback state
    this.next = 0; this.extraMs = 0; this.lastUnderrun = 0;
  }

  get worklet() { return !!this.node; }

  init(rate = 48000) {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const AC = window.AudioContext || window.webkitAudioContext;
      try { this.ctx = new AC({ latencyHint: 'interactive', sampleRate: rate }); } catch { this.ctx = new AC({ latencyHint: 'interactive' }); }
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
      if (this.ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
        try {
          await this.ctx.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));
          this.node = new AudioWorkletNode(this.ctx, 'nxb-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
          this.node.connect(this.gain);
          this.node.port.onmessage = (e) => { if (e.data && e.data.type === 'stats') this.stats = e.data; };
          this.node.port.postMessage({ type: 'cfg', targetMs: this._targetMs });
        } catch (e) { console.warn('AudioWorklet unavailable, using the fallback', e); this.node = null; }
      }
    })();
    return this.initPromise;
  }

  /* a port the media worker can push PCM into directly */
  connectPort() {
    if (!this.node) return null;
    const ch = new MessageChannel();
    this.node.port.postMessage({ port: ch.port1 }, [ch.port1]);
    return ch.port2;
  }

  /* must run from a user gesture */
  async enable(rate = 48000) {
    await this.init(rate);
    if (this.node) this.node.port.postMessage({ type: 'flush' });
    await this.ctx.resume();
    this.enabled = this.ctx.state === 'running';
    return this.enabled;
  }

  disable() { this.enabled = false; if (this.ctx) this.ctx.suspend(); }

  setVolume(v) { this.volume = v; if (this.gain) this.gain.gain.value = v; }

  set targetMs(v) { this._targetMs = v; if (this.node) this.node.port.postMessage({ type: 'cfg', targetMs: v }); }
  get targetMs() { return this._targetMs; }
  get effectiveMs() { return this.node && this.stats.targetMs ? this.stats.targetMs : this._targetMs + this.extraMs; }

  push(u8, rate, channels) {
    if (!this.enabled || !this.ctx || !channels) return;
    if (this.node) {
      const copy = u8.slice().buffer;
      this.node.port.postMessage({ buf: copy, rate, ch: channels }, [copy]);
      return;
    }
    this._pushFallback(u8, rate, channels);
  }

  _pushFallback(u8, rate, channels) {
    const frames = Math.floor(u8.byteLength / (2 * channels));
    if (!frames) return;
    const now = this.ctx.currentTime;
    const target = (this._targetMs + this.extraMs) / 1000;
    const ahead = this.next - now;
    if (ahead > target + 0.4) return; // only a backlog far past the target is dropped
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const buf = this.ctx.createBuffer(channels, frames, rate);
    for (let ch = 0; ch < channels; ch++) {
      const out = buf.getChannelData(ch);
      for (let i = 0; i < frames; i++) out[i] = dv.getInt16((i * channels + ch) * 2, true) / 32768;
    }
    if (ahead < 0.004) {
      if (this.next > 0) {
        this.stats.underruns++;
        if (performance.now() - this.lastUnderrun < 20000) this.extraMs = Math.min(200, this.extraMs + 20);
        this.lastUnderrun = performance.now();
      }
      this.next = now + target;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start(this.next);
    this.next += buf.duration;
    this.stats.fillMs = Math.round((this.next - now) * 1000);
  }
}
