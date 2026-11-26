/*
 * NXBeam player: H.264 Annex-B access units -> WebCodecs VideoDecoder ->
 * WebGL (colour + contrast-adaptive sharpening, optional frame generation on
 * WebGL2) or 2D canvas fallback.
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

/*
 * Shaders. Every texture keeps the picture's top row at t=0 (like a decoded
 * VideoFrame); FBO passes draw with flip=0, the last pass to the canvas with flip=1.
 */
const VERT = `attribute vec2 p; varying vec2 uv; uniform float flip;
void main(){ uv = vec2((p.x+1.0)*0.5, flip > 0.5 ? 1.0-(p.y+1.0)*0.5 : (p.y+1.0)*0.5); gl_Position = vec4(p,0.0,1.0); }`;

// last pass: contrast-adaptive sharpening and the picture adjustments
const FRAG = `precision highp float;
varying vec2 uv; uniform sampler2D tex; uniform vec2 texel;
uniform float bright, contrast, sat, sharp, algo;
vec3 px(vec2 o){ return texture2D(tex, uv + o*texel).rgb; }
void main(){
  vec3 c = px(vec2(0.0));
  if (algo > 0.5 && sharp > 0.001) {
    vec3 n = px(vec2(0.0,-1.0)), s = px(vec2(0.0,1.0)), e = px(vec2(1.0,0.0)), w = px(vec2(-1.0,0.0));
    vec3 mn = min(min(n,s), min(e,w)), mx = max(max(n,s), max(e,w));
    // contrast-adaptive sharpening (AMD CAS style, single pass)
    vec3 mn5 = min(c, mn), mx5 = max(c, mx);
    vec3 amp = sqrt(clamp(min(mn5, 1.0-mx5) / max(mx5, 1e-4), 0.0, 1.0));
    vec3 wgt = -amp / mix(8.0, 5.0, sharp);
    c = clamp((c + (n+s+e+w)*wgt) / (1.0 + 4.0*wgt), 0.0, 1.0);
  }
  c = (c - 0.5) * contrast + 0.5 + bright;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, sat);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

/*
 * Frame generation (WebGL2). Motion is searched on the in-between frame's own
 * grid: for every 16x16 block, the half-vector h for which A(p-h) matches B(p+h)
 * (no holes, no overlaps). A coarse search at 1/16 size (up to 128 px of motion
 * per frame) is refined at 1/8 and 1/4 size down to 1 px, with the neighbours'
 * vectors as extra candidates, then cleaned with a vector median;
 * the in-between frame then takes half of each side along that path.
 */
const VERT3 = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = (p + 1.0) * 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const LUM4 = `#version 300 es
precision highp float;
uniform sampler2D A, B; uniform vec2 srcSize; out vec4 o;
float L(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec2 base = floor(gl_FragCoord.xy) * 4.0 + 2.0;
  float a = 0.0, b = 0.0;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec2 q = (base + vec2(float(i)*2.0 - 1.0, float(j)*2.0 - 1.0)) / srcSize;
    a += L(texture(A, q).rgb); b += L(texture(B, q).rgb);
  }
  o = vec4(a*0.25, b*0.25, 0.0, 1.0);
}`;

const LUM8 = `#version 300 es
precision highp float;
uniform sampler2D L4; uniform vec2 size4; out vec4 o;
void main(){ o = vec4(texture(L4, (floor(gl_FragCoord.xy)*2.0 + 1.0) / size4).rg, 0.0, 1.0); }`;

const ENC = `
const float Z = 128.0 / 255.0;
vec4 enc(vec2 h, float cost){ return vec4(clamp(h / 128.0 + Z, 0.0, 1.0), clamp(cost, 0.0, 1.0), 1.0); }
vec2 dec(vec4 t){ return (t.rg - Z) * 128.0; }`;

// coarse search at 1/16 size, half-pixel steps: up to 64 px each way per half-vector
const ME_COARSE = `#version 300 es
precision highp float;
uniform sampler2D LV; uniform vec2 size; out vec4 o;${ENC}
float fa(vec2 q){ return texture(LV, q / size).r; }
float fb(vec2 q){ return texture(LV, q / size).g; }
void main(){
  vec2 q = floor(gl_FragCoord.xy) + 0.5;
  float best = 1e9; vec2 bh = vec2(0.0);
  for (int y = -8; y <= 8; y++) for (int x = -8; x <= 8; x++) {
    vec2 h = vec2(float(x), float(y)) * 0.5;
    float c = 0.0;
    for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
      vec2 w = q + vec2(float(i) - 1.5, float(j) - 1.5);
      c += abs(fa(w - h) - fb(w + h));
    }
    c += 0.01 * length(h);
    if (c < best) { best = c; bh = h; }
  }
  o = enc(bh * 16.0, best / 16.0);
}`;

// refinement on a finer level: the block's own and its 4 neighbours' vectors, +-R steps around each
const ME_REFINE = `#version 300 es
precision highp float;
uniform sampler2D LV, MV; uniform vec2 size; uniform ivec2 mvSize; uniform float stp, lvl; uniform int R; out vec4 o;${ENC}
float fa(vec2 q){ return texture(LV, q / size).r; }
float fb(vec2 q){ return texture(LV, q / size).g; }
vec2 cand(ivec2 c){ return dec(texelFetch(MV, clamp(c, ivec2(0), mvSize - 1), 0)) / lvl; }
void main(){
  ivec2 bi = ivec2(gl_FragCoord.xy);
  float bs = 16.0 / lvl;
  vec2 q = (vec2(bi) + 0.5) * bs;
  vec2 cs[5];
  cs[0] = cand(bi); cs[1] = cand(bi + ivec2(1, 0)); cs[2] = cand(bi - ivec2(1, 0));
  cs[3] = cand(bi + ivec2(0, 1)); cs[4] = cand(bi - ivec2(0, 1));
  float best = 1e9; vec2 bh = cs[0];
  for (int k = 0; k < 5; k++) for (int dy = -R; dy <= R; dy++) for (int dx = -R; dx <= R; dx++) {
    vec2 h = cs[k] + vec2(float(dx), float(dy)) * stp;
    float c = 0.0;
    for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
      vec2 w = q + (vec2(float(i), float(j)) - 1.5) * bs * 0.25;
      c += abs(fa(w - h) - fb(w + h));
    }
    c += 0.005 * length(h);
    if (c < best) { best = c; bh = h; }
  }
  o = enc(bh * lvl, best / 16.0);
}`;

// vector median of the 3x3 neighbourhood: removes stray vectors (flat areas match anything)
const ME_MEDIAN = `#version 300 es
precision highp float;
uniform sampler2D MV; uniform ivec2 mvSize; out vec4 o;${ENC}
void main(){
  ivec2 bi = ivec2(gl_FragCoord.xy);
  vec2 v[9]; int n = 0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) v[n++] = dec(texelFetch(MV, clamp(bi + ivec2(x, y), ivec2(0), mvSize - 1), 0));
  float best = 1e9; vec2 bv = v[4];
  for (int i = 0; i < 9; i++) {
    float d = 0.0;
    for (int j = 0; j < 9; j++) d += abs(v[i].x - v[j].x) + abs(v[i].y - v[j].y);
    if (d < best) { best = d; bv = v[i]; }
  }
  o = enc(bv, 0.0);
}`;

const INTERP = `#version 300 es
precision highp float;
in vec2 uv; uniform sampler2D A, B, MV; uniform vec2 srcSize, mvScale; out vec4 o;
const float Z = 128.0 / 255.0;
float L(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec4 m = texture(MV, uv * mvScale);
  vec2 h = (m.rg - Z) * 128.0 / srcSize;
  vec3 a = texture(A, uv - h).rgb, b = texture(B, uv + h).rgb;
  vec3 c = 0.5 * (a + b);
  // where the two sides disagree (something appears or disappears), lean on the newer frame
  float d = abs(L(a) - L(b));
  c = mix(c, b, smoothstep(0.12, 0.35, d) * 0.6);
  o = vec4(c, 1.0);
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
    this.adjust = { bright: 0, contrast: 1, sat: 1, sharp: 0.35, framegen: false };
    this.stat = { decoded: 0, shown: 0, dropped: 0, skipped: 0, lat: 0, w: 0, h: 0, fails: 0, err: '', depth: 0, target: 0, jitter: 0, fps: 0, late: 0, hw: '', light: false, fpsIn: 0, cap: 0, capped: 0, gen: 0, fg: false };
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
      this.stat.fg = this._fgWanted();
      this.stat.fgAvail = !!this.fgOk && !this.softGl;
      // the device keeps falling behind with frames waiting: switch to light rendering
      if (!this.light && this.stat.late >= 3 && this.stat.skipped > this._skipMark) this._lateRun = (this._lateRun || 0) + 1;
      else this._lateRun = 0;
      this._skipMark = this.stat.skipped;
      if (this._lateRun >= 3 && this.autoLight !== false) { this.light = true; this.dirty = true; }
      this.stat.light = !!this.light;
      this._governor();
      this.onStats({ ...this.stat });
      this.stat.decoded = 0; this.stat.shown = 0; this.stat.late = 0; this.stat.gen = 0;
    }, 1000);
  }

  setBox(w, h, dpr) { this.box = { w, h }; this.dpr = Math.min(dpr || 1, 2); this.dirty = true; }

  setMode(m) { this.mode = MODES[m] ? m : 'balanced'; this.priming = true; }

  _initGl() {
    const opts = { alpha: false, antialias: false, desynchronized: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
    let gl = null;
    try { gl = this.canvas.getContext('webgl2', opts); } catch { gl = null; }
    this.gl2 = !!gl;
    if (!gl) gl = this.canvas.getContext('webgl', opts);
    if (!gl) { this.ctx2d = this.canvas.getContext('2d', { alpha: false, desynchronized: true }); return; }
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const mk = (vs, fs, names) => {
      const prog = gl.createProgram();
      const v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs);
      gl.attachShader(prog, v); gl.attachShader(prog, f);
      gl.bindAttribLocation(prog, 0, 'p');
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.warn('shader:', gl.getShaderInfoLog(f) || gl.getProgramInfoLog(prog));
        return null;
      }
      return { prog, u: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(prog, n)])) };
    };
    this.pFinal = mk(VERT, FRAG, ['flip', 'tex', 'texel', 'bright', 'contrast', 'sat', 'sharp', 'algo']);
    if (!this.pFinal) { this.ctx2d = null; return; }
    if (this.gl2) {
      this.pLum4 = mk(VERT3, LUM4, ['A', 'B', 'srcSize']);
      this.pLum8 = mk(VERT3, LUM8, ['L4', 'size4']);
      this.pMeC = mk(VERT3, ME_COARSE, ['LV', 'size']);
      this.pMeR = mk(VERT3, ME_REFINE, ['LV', 'MV', 'size', 'mvSize', 'stp', 'lvl', 'R']);
      this.pMed = mk(VERT3, ME_MEDIAN, ['MV', 'mvSize']);
      this.pInterp = mk(VERT3, INTERP, ['A', 'B', 'MV', 'srcSize', 'mvScale']);
      this.fgOk = !!(this.pLum4 && this.pLum8 && this.pMeC && this.pMeR && this.pMed && this.pInterp);
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.gl = gl;
    // no GPU (software WebGL): upscaling and frame generation would cost more than they give
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      this.softGl = /swiftshader|llvmpipe|softpipe|basic render|software/i.test(r);
    } catch { this.softGl = false; }
    this.stat.softGl = !!this.softGl;
    this.tex = [this._newTex(), this._newTex()]; // decoded frames: [previous, current]
    this.texSize = [null, null];
    this.fbos = {};
  }

  _newTex(filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /* an offscreen target of the given size, made or resized on demand */
  _fbo(name, w, h, filter) {
    const gl = this.gl;
    let t = this.fbos[name];
    if (!t) {
      t = { tex: this._newTex(filter), fb: gl.createFramebuffer(), w: 0, h: 0 };
      this.fbos[name] = t;
    }
    if (t.w !== w || t.h !== h) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      t.w = w; t.h = h;
    }
    return t;
  }

  _pass(p, target, w, h, tex) {
    const gl = this.gl;
    gl.useProgram(p.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, w, h);
    tex.forEach(([name, t], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      if (p.u[name]) gl.uniform1i(p.u[name], i);
    });
    if (p.u.flip) gl.uniform1f(p.u.flip, target ? 0 : 1);
  }

  _draw(p) { const gl = this.gl; gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.activeTexture(gl.TEXTURE0); }

  /* the in-between picture of the previous and the current frame */
  _interpolate(w, h) {
    const gl = this.gl;
    const [A, B] = this.tex;
    const w4 = Math.ceil(w / 4), h4 = Math.ceil(h / 4), w8 = Math.ceil(w4 / 2), h8 = Math.ceil(h4 / 2);
    const w16 = Math.ceil(w8 / 2), h16 = Math.ceil(h8 / 2);
    const bw = Math.ceil(w / 16), bh = Math.ceil(h / 16);
    const l4 = this._fbo('l4', w4, h4), l8 = this._fbo('l8', w8, h8), l16 = this._fbo('l16', w16, h16);
    const N = gl.NEAREST;
    const v = [this._fbo('mv0', bw, bh, N), this._fbo('mv1', bw, bh, N), this._fbo('mv2', bw, bh, N), this._fbo('mv3', bw, bh, N)];
    const mv = this._fbo('mv', bw, bh), out = this._fbo('mid', w, h);
    // luma pyramid: R = previous frame, G = current frame
    this._pass(this.pLum4, l4, w4, h4, [['A', A], ['B', B]]);
    gl.uniform2f(this.pLum4.u.srcSize, w, h); this._draw();
    for (const [from, to, fw, fh] of [[l4, l8, w4, h4], [l8, l16, w8, h8]]) {
      this._pass(this.pLum8, to, to.w, to.h, [['L4', from.tex]]);
      gl.uniform2f(this.pLum8.u.size4, fw, fh); this._draw();
    }
    this._pass(this.pMeC, v[0], bw, bh, [['LV', l16.tex]]);
    gl.uniform2f(this.pMeC.u.size, w16, h16); this._draw();
    // refine: 1/8 size 4 px steps, 1/4 size 2 px then 1 px steps
    const steps = [[l8, 8, 0.5, 2], [l4, 4, 0.5, 1], [l4, 4, 0.25, 1]];
    steps.forEach(([lv, lvl, stp, R], i) => {
      const pr = this.pMeR;
      this._pass(pr, v[i + 1], bw, bh, [['LV', lv.tex], ['MV', v[i].tex]]);
      gl.uniform2f(pr.u.size, lv.w, lv.h); gl.uniform2i(pr.u.mvSize, bw, bh);
      gl.uniform1f(pr.u.stp, stp); gl.uniform1f(pr.u.lvl, lvl); gl.uniform1i(pr.u.R, R); this._draw();
    });
    const m2 = v[3];
    this._pass(this.pMed, mv, bw, bh, [['MV', m2.tex]]);
    gl.uniform2i(this.pMed.u.mvSize, bw, bh); this._draw();
    this._pass(this.pInterp, out, w, h, [['A', A], ['B', B], ['MV', mv.tex]]);
    gl.uniform2f(this.pInterp.u.srcSize, w, h); gl.uniform2f(this.pInterp.u.mvScale, w / (16 * bw), h / (16 * bh)); this._draw();
    return out.tex;
  }

  /* frame generation runs when the screen refreshes at least ~1.7x as often as the game draws */
  _fgWanted() {
    if (!this.adjust.framegen || !this.fgOk || this.light || this.softGl) return false;
    const iv = this.cap === 30 ? 1000 / 30 : this.interval;
    return iv >= this.vsync * 1.7 && iv <= 70;
  }

  setAdjust(a) {
    Object.assign(this.adjust, a);
    if ('light' in a) this.light = !!a.light;
    if ('autoLight' in a) this.autoLight = a.autoLight;
    if ('framegen' in a && !a.framegen) { this.fgRealAt = 0; this.fgMid = false; }
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
    // configured a while ago, fed, and still not one picture: this decoder will not work here
    if (!this.fedAt) this.fedAt = now;
    else if (!this.outCount && now - this.fedAt > 2500) { this._fail(new Error('the decoder gives no picture')); return; }
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
      // after the GPU decoder failed here, stay on the software one for this session
      for (const hw of this.forceSoft ? ['prefer-software', 'no-preference'] : ['prefer-hardware', 'no-preference']) {
        try { const r = await VideoDecoder.isConfigSupported({ ...base, hardwareAcceleration: hw }); if (r.supported) return hw; } catch { /* next */ }
      }
      return 'no-preference';
    };
    this.waitKey = true; // the first keyframe is replayed once the decoder is configured
    pick().then((hw) => {
      if (this.decoder !== decoder || decoder.state === 'closed') return;
      this.stat.hw = hw === 'prefer-hardware' ? 'gpu' : 'auto';
      this.hwUsed = hw;
      this.fedAt = 0; this.outCount = 0;
      try { decoder.configure({ ...base, hardwareAcceleration: hw }); } catch (e) { this._fail(e); return; }
      if (this.pendingKey) { const k = this.pendingKey; this.pendingKey = null; this.waitKey = false; this.push(k.u8, true, k.w, k.h); }
    });
  }

  _fail(e) {
    console.warn('decoder:', e);
    this.stat.fails++;
    this.stat.err = String((e && e.message) || e).slice(0, 160);
    // some GPU decoders (drivers, remote desktop, older iGPUs) accept H.264 and then fail or
    // never give a picture: fall back to the software decoder
    if (this.hwUsed !== 'prefer-software') this.forceSoft = true;
    this.fedAt = 0;
    this.codec = null;
    this.waitKey = true;
    this.onNeedKey();
  }

  _output(f) {
    const t0 = this.recvTimes.get(f.timestamp);
    if (t0 !== undefined) { this.stat.lat = Math.round(performance.now() - t0); this.recvTimes.delete(f.timestamp); }
    this.stat.decoded++;
    this.outCount = (this.outCount || 0) + 1;
    this.queue.push(f);
    // a hardware decoder has few buffers: never hold many
    while (this.queue.length > 8) { this.queue.shift().close(); this.stat.skipped++; }
  }

  _show(f) {
    const t = performance.now();
    const iv = this.cap === 30 ? 1000 / 30 : this.interval;
    if (this.lastShown && t - this.lastShown > iv * 1.6 + this.vsync / 2) this.stat.late++;
    this.lastShown = t;
    // frame generation: the in-between picture now, this frame half an interval later
    const had = !!this.frame;
    if (this.frame) this.frame.close();
    const first = !this.stat.w;
    this.frame = f;
    this.frameNew = true;
    if (had && this._fgWanted()) { this.fgMid = true; this.fgRealAt = t + iv / 2; } else { this.fgMid = false; this.fgRealAt = 0; }
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
    if (this.fgRealAt && now + this.vsync / 2 >= this.fgRealAt) { this.fgRealAt = 0; this.fgMid = false; this.dirty = true; }
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
    const sharpOn = !this.light && !!this.gl;
    const sw = f.displayWidth, sh = f.displayHeight;
    const maxScale = sharpOn && sh < 1000 && this.adjust.sharp >= 0.01 ? 2 : 1;
    const scale = Math.min((w * dpr) / sw, maxScale);
    const bw = Math.max(2, Math.round(sw * scale)), bh = Math.max(2, Math.round(sh * scale));
    if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
    const css = `${Math.round(w)}x${Math.round(h)}`;
    if (css !== this.cssSize) { this.cssSize = css; this.onCssSize(Math.round(w), Math.round(h)); }
    if (this.gl) {
      const gl = this.gl;
      try {
        if (this.frameNew) {
          this.frameNew = false;
          this.tex.reverse(); this.texSize.reverse();
          gl.bindTexture(gl.TEXTURE_2D, this.tex[1]);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f);
          this.texSize[1] = `${sw}x${sh}`;
          this.midTex = null;
          if (this.fgMid && this.texSize[0] === this.texSize[1] && sw <= 1920 && sh <= 1088) {
            this.midTex = this._interpolate(sw, sh);
            this.stat.gen++;
          }
        }
      } catch (e) { console.warn('render:', e); this.gl = null; return; }
      const src = this.fgMid && this.midTex ? this.midTex : this.tex[1];
      const p = this.pFinal;
      this._pass(p, null, bw, bh, [['tex', src]]);
      const a = this.adjust;
      gl.uniform2f(p.u.texel, 1 / sw, 1 / sh);
      gl.uniform1f(p.u.bright, a.bright); gl.uniform1f(p.u.contrast, a.contrast);
      gl.uniform1f(p.u.sat, a.sat); gl.uniform1f(p.u.sharp, sharpOn ? a.sharp : 0); gl.uniform1f(p.u.algo, sharpOn ? 1 : 0);
      this._draw();
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
