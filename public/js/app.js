import { t, applyI18n, setLang, getLang } from './i18n.js';
import { AudioPlayer } from './player.js';
import { StreamView } from './view.js';
import { InputManager, KEY_HELP } from './input.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem('nxb.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('nxb.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const api = async (path, body, method) => {
  const r = await fetch(path, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: body instanceof Blob ? {} : { 'content-type': 'application/json' },
    body: body instanceof Blob ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
};
const fmtBytes = (n) => n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB';
const fmtTime = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600); const mm = String(Math.floor(s / 60) % 60).padStart(2, '0'); const ss = String(s % 60).padStart(2, '0'); return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`; };
const icon = (el, id) => { const u = el.querySelector('use'); if (u) u.setAttribute('href', '#' + id); };

/* ------------------------------------------------------------ state */
const S = {
  ws: null, myId: null, state: null, clients: [], stats: null, history: [],
  serverOffset: 0, page: 'stage', mediaKind: 'clips', config: null,
  controlling: false, firstFrame: false, touchShown: store.get('touch', null),
};

/* ------------------------------------------------------------ toasts */
function toast(text, level = 'info', ms = 3800) {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

/* ------------------------------------------------------------ online update */
const updSkip = () => Number(store.get('updSkip', 0)) || 0;
async function loadUpdate() {
  try {
    const u = await (await fetch('/api/update')).json();
    // NXBeam restarted on a new build: load the new page too
    if (S.build && u.current && u.current.build && u.current.build !== S.build) { location.reload(); return; }
    if (u.current) S.build = u.current.build;
    renderUpdate(u);
  } catch { /* offline */ }
}
function renderUpdate(u) {
  S.update = u;
  const bar = $('#updateBar');
  if (!u || !u.enabled || !u.latest) { bar.hidden = true; return; }
  const busy = u.state === 'downloading' || u.state === 'ready';
  const show = busy || u.state === 'error' && S.updClicked || (u.available && u.latest.build > updSkip());
  bar.hidden = !show;
  if (!show) return;
  $('#updTitle').textContent = t('updAvailable', u.latest.version);
  $('#updProgress').hidden = u.state !== 'downloading';
  $('#updFill').style.width = `${u.progress || 0}%`;
  $('#updApply').hidden = busy;
  $('#updLater').hidden = busy;
  $('#updApply').textContent = u.state === 'error' ? t('updRetry') : t('updApply');
  $('#updDetail').textContent =
    u.state === 'downloading' ? t('updDownloading', u.progress || 0)
    : u.state === 'ready' ? t('updRestarting')
    : u.state === 'error' ? t('updError', u.error)
    : !u.canApply ? t('updManual')
    : t('updDetail', u.current.version);
  if (!u.canApply && !busy) $('#updApply').hidden = true;
}
$('#updApply').onclick = async () => {
  S.updClicked = true;
  try { renderUpdate(await (await fetch('/api/update/apply', { method: 'POST' })).json()); } catch (e) { toast(e.message, 'error'); }
};
$('#updLater').onclick = () => {
  if (S.update && S.update.latest) store.set('updSkip', S.update.latest.build);
  $('#updateBar').hidden = true;
};

/* ------------------------------------------------------------ media */
const screen = $('#screen');
const audio = new AudioPlayer();

function onJson(m) {
  switch (m.type) {
    case 'welcome':
      loadUpdate();
      S.myId = m.id; S.history = m.history || []; S.stats = m.stats;
      setState(m.state, m.clients);
      break;
    case 'state': setState(m.state, m.clients); break;
    case 'stats':
      S.stats = m.stats;
      if (m.stats.last) { S.history.push(m.stats.last); if (S.history.length > 180) S.history.shift(); }
      renderSignal(); renderStatsPage();
      {
        const dg = diagnose();
        S.lowRun = dg && dg.cls !== 'ok' && !dg.pc ? (S.lowRun || 0) + 1 : 0;
        if (S.lowRun === 10 && !S.hintedLow && S.page !== 'stats' && !S.playing) { S.hintedLow = true; toast(t('dgHint', dg.fps, dg.res), 'info', 9000); }
      }
      fpsGuard();
      break;
    case 'media': if (S.page === 'library') loadMedia(); break;
    case 'update': renderUpdate(m.update); break;
    case 'toast': toast(t(m.key, m.arg), m.level); if (m.key === 'controlTaken') setControlling(false); break;
    default: break;
  }
}

// video decode and drawing run in a worker where the browser allows it
const player = new StreamView($('#video'), {
  onJson,
  onAudio: (u8, rate, ch) => audio.push(u8, rate, ch),
  onStats: (s) => { S.local = s; renderStatsPage(); },
  onFirstFrame: () => {
    S.firstFrame = true; renderStage(); renderDeck();
    clearTimeout(S.audioCheck);
    S.audioCheck = setTimeout(() => {
      if (S.firstFrame && S.state && !S.state.audio && !S.warnedAudio) { S.warnedAudio = true; toast(t('noAudio'), 'error', 12000); }
    }, 6000);
  },
  onClose: () => {
    if (S.state) { S.state.conn = { state: 'hub-offline' }; renderAll(); }
    setTimeout(connectWs, 1500);
  },
}, { allowWorker: store.get('worker', true) });
const adjDefaults = { bright: 0, contrast: 1, sat: 1, sharp: 0.35, audioMs: 80, smooth: 'balanced', fpsCap: 'auto' };
let adj = { ...adjDefaults, ...store.get('adjust', {}) };
player.setAdjust(adj);
audio.targetMs = adj.audioMs;
player.setMode(adj.smooth);
audio.setVolume(store.get('volume', 1));
$('#volume').value = audio.volume;

window.__nxb = { player, audio };
// sound: the worklet is loaded now (it stays silent until a tap turns sound on)
audio.init().then(() => {
  if (player.mode === 'worker') S.audioDirect = player.attachAudioPort(audio.connectPort());
  player.setAudio(!store.get('muted', false));
}).catch(() => {});
const input = new InputManager((state) => send({ type: 'pad', state }));
input.bindTouch($('#touchpad'));

/* ------------------------------------------------------------ connection */
function send(m) { player.send(m); }

function deviceName() {
  let n = store.get('name', '');
  if (!n) {
    const ua = navigator.userAgent;
    n = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Windows/.test(ua) ? 'Windows PC' : /Mac/.test(ua) ? 'Mac' : 'Browser';
    n += ' ' + Math.floor(Math.random() * 90 + 10);
    store.set('name', n);
  }
  return n;
}

function connectWs() {
  player.connect({ type: 'hello', name: deviceName(), role: 'viewer', audio: true, video: true });
}

function setState(state, clients) {
  const prevConn = S.state && S.state.conn && S.state.conn.state;
  S.state = state;
  if (clients) S.clients = clients;
  S.serverOffset = state.now - Date.now();
  if (state.conn.state !== 'connected') { S.firstFrame = false; if (prevConn === 'connected') player.reset(); }
  const amPilot = state.pilot && state.pilot.id === S.myId;
  if (S.controlling && !amPilot) setControlling(false);
  renderAll();
}

/* ------------------------------------------------------------ rendering */
function renderAll() { renderSignal(); renderStage(); renderMode(); renderDeck(); renderStatsPage(); }

function connLabel(c) {
  if (!c) return t('searching');
  if (c.state === 'hub-offline') return t('hubOffline');
  return t(c.state) || c.state;
}

function renderSignal() {
  const st = S.state;
  if (!st) return;
  const c = st.conn;
  $('#sigState').textContent = connLabel(c);
  $('#sigPeer').textContent = c.state === 'connected' ? (c.kind === 'usb' ? 'USB' : c.peer || '') : (c.error || '');
  $('#sigRes').textContent = st.video ? `${st.video.width}×${st.video.height}` : '-';
  $('#sigFps').textContent = S.stats ? S.stats.fps : 0;
  $('#sigKbps').textContent = S.stats ? S.stats.kbps.toLocaleString() : 0;
  $('#sigViewers').textContent = S.clients.filter((x) => x.role === 'viewer').length || 1;
  const dot = $('#connDot');
  dot.className = 'dot ' + (c.state === 'connected' ? 'ok' : c.state === 'hub-offline' ? '' : 'busy');
  icon($('#connIcon').parentElement, c.kind === 'usb' ? 'i-usb' : 'i-wifi');
  $('#railConn').title = connLabel(c);
  $('#recBadge').hidden = !st.recording;
  $('#liveBadge').hidden = !(st.restreams && st.restreams.length);
  drawBars();
}

/* the signal strip: one bar per second of video bitrate, newest at the right */
function drawBars() {
  const cv = $('#sigBars');
  if (!cv.offsetWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.offsetWidth * dpr, h = cv.offsetHeight * dpr;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  const bw = 4 * dpr, gap = 2 * dpr;
  const n = Math.floor(w / (bw + gap));
  const data = S.history.slice(-n);
  const max = Math.max(4000, ...data.map((d) => d.kbps));
  const live = S.state && S.state.conn.state === 'connected';
  data.forEach((d, i) => {
    const x = w - (data.length - i) * (bw + gap);
    const bh = Math.max(2 * dpr, (d.kbps / max) * h);
    const fresh = i >= data.length - 1;
    g.fillStyle = !live ? '#2d3948' : d.fps === 0 ? '#3a4656' : fresh ? '#f2b84b' : 'rgba(242,184,75,0.55)';
    g.fillRect(x, h - bh, bw, bh);
  });
  if (data.length < n) {
    g.fillStyle = '#2d3948';
    for (let i = 0; i < n - data.length; i++) g.fillRect(i * (bw + gap), h - 2 * dpr, bw, 2 * dpr);
  }
}
window.addEventListener('resize', drawBars);

function renderMode() {
  const st = S.state;
  if (!st) return;
  const mode = st.mode || 'auto';
  $$('[data-mode]').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === mode);
    if (b.getAttribute('role') === 'radio') b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  });
  const kind = st.conn.state === 'connected' ? st.conn.kind : mode === 'usb' ? 'usb' : 'network';
  icon($('#connBtn'), kind === 'usb' ? 'i-usb' : 'i-wifi');
  $('#usbDiag').hidden = mode === 'network' || st.conn.state === 'connected';
}

async function setMode(mode) {
  $('#connMenu').hidden = true;
  $('#usbResult').innerHTML = '';
  try { await api('/api/mode', { mode }); } catch (e) { toast(e.message, 'error'); }
  if (mode === 'usb') setTimeout(usbCheck, 1500);
}
$$('[data-mode]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); setMode(b.dataset.mode); }; });
$('#connBtn').onclick = (e) => { e.stopPropagation(); $('#connMenu').hidden = !$('#connMenu').hidden; };
$('#menuReconnect').onclick = async () => { $('#connMenu').hidden = true; await api('/api/connect', {}); };
$('#menuUsbCheck').onclick = () => { $('#connMenu').hidden = true; openPage('stage'); usbCheck(); };
document.addEventListener('click', (e) => { if (!e.target.closest('#connMenu')) $('#connMenu').hidden = true; });

async function usbCheck() {
  const box = $('#usbResult');
  $('#usbDiag').hidden = false;
  let d;
  try { d = await api('/api/usb'); } catch (e) { box.textContent = e.message; return; }
  const sft = d.devices.find((x) => x.kind === 'sft');
  const nin = d.devices.find((x) => x.kind === 'nintendo');
  let msg, cls;
  if (!d.lib) { msg = t('usbDiagNoLib', d.error || '?'); cls = 'bad'; }
  else if (sft && (d.problem === 'driver' || d.problem === 'permission')) { msg = d.problem === 'driver' ? t('usbDiagSftDriver') : t('usbPermission'); cls = 'bad'; }
  else if (sft && d.problem === 'busy') { msg = t('usbBusy'); cls = 'bad'; }
  else if (sft) { msg = t('usbDiagSft'); cls = 'good'; }
  else if (nin) { msg = t('usbDiagNintendo', nin.id.toUpperCase()); cls = 'bad'; }
  else { msg = t('usbDiagNone'); cls = 'bad'; }
  const rep = document.createElement('div');
  rep.className = 'usb-report';
  const p = document.createElement('p'); p.className = cls; p.textContent = msg; rep.append(p);
  if (d.lib) {
    const p2 = document.createElement('p'); p2.textContent = t('usbSeenList', d.devices.length); rep.append(p2);
    const ul = document.createElement('ul');
    for (const x of d.devices) {
      const li = document.createElement('li');
      if (x.kind !== 'other') li.className = 'hit';
      li.innerHTML = '<span></span><span></span>';
      li.firstChild.textContent = x.id.toUpperCase() + (x.kind === 'sft' ? '  Switch Frame Tap' : x.kind === 'nintendo' ? '  Nintendo' : '');
      li.lastChild.textContent = `bus ${x.bus}${x.port ? ' port ' + x.port : ''}`;
      ul.append(li);
    }
    rep.append(ul);
  }
  box.innerHTML = '';
  box.append(rep);
}
$('#btnUsbCheck').onclick = usbCheck;

function renderStage() {
  const st = S.state;
  const ph = $('#placeholder');
  const connected = st && st.conn.state === 'connected';
  const showPicture = connected && S.firstFrame;
  screen.classList.toggle('blank', !showPicture);
  ph.hidden = showPicture;
  if (!showPicture) {
    if (connected) {
      $('#phTitle').textContent = st.consoleStatus ? st.consoleStatus.head : t('connected');
      $('#phText').textContent = st.consoleStatus ? st.consoleStatus.detail : t('waitingPicture');
      $('#ipForm').hidden = true;
    } else {
      const usbMode = st && st.mode === 'usb';
      const usbMsg = { absent: 'usbAbsent', driver: 'usbDriver', permission: 'usbPermission', busy: 'usbBusy', nolib: 'usbNolib', error: 'usbError' };
      const err = (st && st.conn.error) || '';
      const ip = (/^([\d.]+):/.exec(err) || [])[1] || '';
      if (st && st.conn.state !== 'hub-offline' && (usbMode || (st.usbProblem && st.usbProblem !== 'absent' && st.usbProblem !== 'nolib'))) {
        $('#phTitle').textContent = t('usbSearching');
        $('#phText').textContent = t(usbMsg[st.usbProblem] || 'usbAbsent');
      } else if (st && st.conn.state === 'hub-offline') {
        $('#phTitle').textContent = t('hubOffline'); $('#phText').textContent = '';
      } else if (/ECONNREFUSED/.test(err)) {
        $('#phTitle').textContent = t('errRefusedTitle', ip); $('#phText').textContent = t('errRefused');
      } else if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timeout/.test(err)) {
        $('#phTitle').textContent = t('errTimeoutTitle', ip); $('#phText').textContent = t('errTimeout');
      } else {
        $('#phTitle').textContent = t('noConsole'); $('#phText').textContent = t('noConsoleHint');
      }
      $('#ipForm').hidden = !!(st && st.mode === 'usb');
    }
  }
  $('#unsupported').hidden = player.supported;
  $('#soundHint').hidden = !(showPicture && st.audio && !audio.enabled && !store.get('muted', false));
}

function renderDeck() {
  const st = S.state;
  if (!st) return;
  const connected = st.conn.state === 'connected';
  const snd = $('#btnSound');
  icon(snd, audio.enabled ? 'i-vol' : 'i-mute');
  snd.querySelector('span').textContent = audio.enabled ? t('soundOn') : t('soundOff');
  $('#btnShot').disabled = !S.firstFrame;
  $('#btnClip').disabled = !connected || !st.replaySeconds;
  $('#clipLen').textContent = st.replaySeconds ? `${st.replaySeconds}s` : '';
  const rec = $('#btnRec');
  rec.classList.toggle('on', !!st.recording);
  icon(rec, st.recording ? 'i-stop' : 'i-rec');
  rec.querySelector('span').textContent = st.recording ? t('stopRecord') : t('record');
  rec.disabled = !connected && !st.recording;
  $('#btnLive').classList.toggle('on', st.restreams.length > 0);
  const pb = $('#btnPlay');
  pb.disabled = !S.firstFrame && !S.playing;
  pb.querySelector('span').textContent = S.playing ? t('exitPlay') : t('playMode');
  const ctl = $('#btnControl');
  ctl.classList.toggle('on', S.controlling);
  ctl.querySelector('span').textContent = S.controlling ? t('releaseControl') : t('control');
  ctl.disabled = !connected && !S.controlling;
  $('#btnTouch').hidden = !S.controlling;
  $('#btnTouch').classList.toggle('on', !$('#touchpad').hidden);
}

setInterval(() => {
  const st = S.state;
  if (st && st.recording) $('#recTime').textContent = fmtTime(Date.now() + S.serverOffset - st.recording.since);
}, 500);

/* ------------------------------------------------------------ deck actions */
$('#btnSound').onclick = async () => {
  if (audio.enabled) { audio.disable(); player.setAudio(false); store.set('muted', true); }
  else {
    player.setAudio(true);
    await audio.enable(S.state && S.state.audio ? S.state.audio.rate : 48000); store.set('muted', false);
    if (S.firstFrame && S.state && !S.state.audio) toast(t('noAudio'), 'error', 12000);
  }
  renderDeck(); renderStage();
};
$('#soundHint').onclick = async () => { player.setAudio(true); await audio.enable(S.state && S.state.audio ? S.state.audio.rate : 48000); renderDeck(); renderStage(); };
$('#volume').oninput = (e) => { audio.setVolume(Number(e.target.value)); store.set('volume', audio.volume); };

async function screenshot() {
  const blob = await player.screenshot();
  if (!blob) return;
  try { await api('/api/screenshot', blob); toast(t('shotSaved'), 'ok'); } catch (e) { toast(e.message, 'error'); }
  flash('#btnShot');
}
$('#btnShot').onclick = screenshot;

async function clip() {
  flash('#btnClip');
  try { const r = await api('/api/clip', {}); toast(t('clipSaved', r.seconds), 'ok'); } catch (e) { toast(t('clipFailed', e.message), 'error'); }
}
$('#btnClip').onclick = clip;

async function toggleRecord() {
  try {
    if (S.state.recording) { await api('/api/record/stop', {}); toast(t('recStopped'), 'ok'); }
    else { const r = await api('/api/record/start', {}); toast(t('recStarted', r.file)); }
  } catch (e) { toast(e.message, 'error'); }
}
$('#btnRec').onclick = toggleRecord;

function flash(sel) { const b = $(sel); b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); }

$('#btnLive').onclick = async (e) => {
  e.stopPropagation();
  const menu = $('#liveMenu');
  if (!menu.hidden) { menu.hidden = true; return; }
  const cfg = await api('/api/config');
  menu.innerHTML = '';
  if (!S.state.ffmpeg) menu.innerHTML = `<p>${t('restreamNeedsFfmpeg')}</p>`;
  else if (!cfg.restreamTargets.length) menu.innerHTML = `<p>${t('restreamNone')}</p>`;
  for (const tg of cfg.restreamTargets) {
    const on = S.state.restreams.includes(tg.id);
    const b = document.createElement('button');
    b.innerHTML = `<span></span>${on ? '<span class="live">LIVE</span>' : ''}`;
    b.firstChild.textContent = tg.name;
    b.onclick = async () => {
      menu.hidden = true;
      try { await api(on ? '/api/restream/stop' : '/api/restream/start', { id: tg.id }); } catch (err) { toast(err.message, 'error'); }
    };
    menu.append(b);
  }
  menu.hidden = false;
};
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) $('#liveMenu').hidden = true; });

function setControlling(on) {
  S.controlling = on;
  input.setActive(on);
  const touchDefault = matchMedia('(pointer: coarse)').matches;
  const showTouch = on && (S.touchShown === null ? touchDefault : S.touchShown);
  $('#touchpad').hidden = !showTouch;
  renderDeck();
}
$('#btnControl').onclick = () => {
  if (S.controlling) { send({ type: 'releaseControl' }); setControlling(false); return; }
  send({ type: 'takeControl' });
  setControlling(true);
  toast(S.state.takesInput ? t('controlOn') : t('consoleNoInput'), S.state.takesInput ? 'ok' : 'info', 6000);
  if (document.activeElement) document.activeElement.blur();
};
$('#btnTouch').onclick = () => {
  const tp = $('#touchpad');
  tp.hidden = !tp.hidden;
  S.touchShown = !tp.hidden;
  store.set('touch', S.touchShown);
  renderDeck();
};

function toggleFullscreen() {
  if (document.fullscreenElement || document.body.classList.contains('fs')) {
    if (document.fullscreenElement) document.exitFullscreen();
    document.body.classList.remove('fs');
  } else {
    document.body.classList.add('fs');
    (document.documentElement.requestFullscreen ? document.documentElement.requestFullscreen() : Promise.resolve()).catch(() => {});
    if (window.screen.orientation && window.screen.orientation.lock) window.screen.orientation.lock('landscape').catch(() => {});
  }
  setTimeout(() => player.remeasure(), 200);
}
$('#btnFull').onclick = toggleFullscreen;
$('#video').ondblclick = toggleFullscreen;
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) { document.body.classList.remove('fs'); if (S.playing) { S.playing = false; $('#playHud').hidden = true; renderDeck(); } }
  player.remeasure();
});
let idleTimer;
document.addEventListener('pointermove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (document.body.classList.contains('fs')) document.body.classList.add('idle'); }, 2500);
});

/* ------------------------------------------------------------ play mode */
/* one click to play: sound on, controller taken, fullscreen, only the picture and a small fps counter */
async function enterPlay() {
  if (!S.firstFrame) return;
  S.playing = true;
  if (!audio.enabled) { player.setAudio(true); await audio.enable(S.state && S.state.audio ? S.state.audio.rate : 48000).catch(() => {}); store.set('muted', false); }
  if (!S.controlling) { send({ type: 'takeControl' }); setControlling(true); }
  if (!document.body.classList.contains('fs')) toggleFullscreen();
  $('#playHud').hidden = false;
  renderDeck(); renderStage();
}
function exitPlay() {
  S.playing = false;
  $('#playHud').hidden = true;
  if (document.body.classList.contains('fs')) toggleFullscreen();
  renderDeck();
}
$('#btnPlay').onclick = () => (S.playing ? exitPlay() : enterPlay());

/* FPS guard: the console keeps sending fewer than 30 frames a second (not a menu, not a 30 fps game) */
function fpsGuard() {
  const st = S.state;
  if (!st || st.conn.state !== 'connected' || !st.video || store.get('fgOff', false) || S.fgDismissed) { S.fgRun = 0; return; }
  const last = S.history[S.history.length - 1];
  const fps = last ? last.fps : 0;
  S.fgRun = fps >= 5 && fps < 29 ? (S.fgRun || 0) + 1 : 0;
  const hud = $('#playHud');
  const shown = S.local && S.local.fps;
  const capped = S.local && S.local.cap === 30;
  $('#hudFps').textContent = capped ? `30 (${t('capLocked')})` : shown && shown < fps - 3 ? `${fps} (${t('hudShown')} ${shown})` : String(fps);
  hud.classList.toggle('low', fps > 0 && fps < 29);
  if (S.fgRun >= 6 && $('#fpsGuard').hidden) {
    $('#fgTitle').textContent = t('fgTitle', fps, `${st.video.width}\u00d7${st.video.height}`);
    const p = $('#fgText');
    p.textContent = t('fgText');
    const ol = document.createElement('ol');
    const steps = st.video.height >= 1000 ? ['fgStep720', 'fgStepMem', 'fgStepClk'] : ['fgStepClk', 'fgStepMem'];
    if (st.conn.kind === 'network') steps.push('fgStepLan');
    for (const k of steps) { const li = document.createElement('li'); li.textContent = t(k); ol.append(li); }
    p.append(ol);
    $('#fpsGuard').hidden = false;
  }
  if (S.fgRun === 0 && !$('#fpsGuard').hidden && fps >= 29) $('#fpsGuard').hidden = true;
}
$('#fgClose').onclick = () => { S.fgDismissed = true; $('#fpsGuard').hidden = true; };
$('#fgLater').onclick = () => { store.set('fgOff', true); $('#fpsGuard').hidden = true; };

/* shortcuts while the keyboard is not playing */
window.addEventListener('keydown', (e) => {
  if (S.controlling || e.ctrlKey || e.metaKey || e.altKey) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'f') toggleFullscreen();
  else if (k === 'm') $('#btnSound').click();
  else if (k === 'p') screenshot();
  else if (k === 'c' && !$('#btnClip').disabled) clip();
  else if (k === 'r' && !$('#btnRec').disabled) toggleRecord();
  else return;
  e.preventDefault();
});

$('#ipForm').onsubmit = async (e) => {
  e.preventDefault();
  const host = $('#ipInput').value.trim();
  if (host) await api('/api/connect', { host });
};

/* ------------------------------------------------------------ panel / pages */
function openPage(page) {
  S.page = page;
  $$('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  const panel = $('#panel');
  if (page === 'stage') { panel.hidden = true; return; }
  panel.hidden = false;
  $('#panelTitle').textContent = t(page);
  $$('.page').forEach((p) => { p.hidden = p.dataset.page !== page; });
  if (page === 'library') loadMedia();
  if (page === 'settings') loadSettings();
  if (page === 'stats') renderStatsPage();
}
$$('.rail-btn').forEach((b) => { b.onclick = () => openPage(S.page === b.dataset.page && b.dataset.page !== 'stage' ? 'stage' : b.dataset.page); });
$('#panelClose').onclick = () => openPage('stage');

/* library */
$$('.tab').forEach((tb) => { tb.onclick = () => { S.mediaKind = tb.dataset.kind; $$('.tab').forEach((x) => x.classList.toggle('active', x === tb)); loadMedia(); }; });
async function loadMedia() {
  const grid = $('#mediaGrid');
  let list;
  try { list = (await api('/api/media'))[S.mediaKind] || []; } catch { return; }
  grid.innerHTML = '';
  if (!list.length) { grid.innerHTML = `<p class="muted-empty">${t('empty')}</p>`; return; }
  for (const f of list) {
    const url = `/api/media/${S.mediaKind}/${encodeURIComponent(f.name)}`;
    const item = document.createElement('article');
    item.className = 'media-item';
    const media = S.mediaKind === 'screenshots' ? document.createElement('img') : document.createElement('video');
    media.src = S.mediaKind === 'screenshots' ? url : url + '#t=0.5';
    if (media.tagName === 'VIDEO') { media.controls = true; media.preload = 'metadata'; media.playsInline = true; }
    else { media.loading = 'lazy'; media.alt = f.name; }
    const meta = document.createElement('div');
    meta.className = 'media-meta';
    meta.innerHTML = `<div><strong></strong><span></span></div>
      <a class="icon-btn" href="${url}?download" title="${t('download')}" aria-label="${t('download')}"><svg><use href="#i-download"/></svg></a>
      <button class="icon-btn" title="${t('delete')}" aria-label="${t('delete')}"><svg><use href="#i-trash"/></svg></button>`;
    meta.querySelector('strong').textContent = f.name;
    meta.querySelector('span').textContent = `${new Date(f.mtime).toLocaleString(getLang() === 'id' ? 'id-ID' : 'en-US')}  •  ${fmtBytes(f.size)}`;
    meta.querySelector('button').onclick = async () => {
      if (!confirm(t('confirmDelete', f.name))) return;
      await api(url, undefined, 'DELETE');
      loadMedia();
    };
    item.append(media, meta);
    grid.append(item);
  }
}

/* stats */
function renderStatsPage() {
  if (S.page !== 'stats' || !S.state) return;
  const st = S.state, s = S.stats || {}, l = S.local || {};
  const rows = [
    [t('link'), st.conn.state === 'connected' ? `${st.conn.kind === 'usb' ? 'USB' : 'LAN/Wi-Fi'} ${st.conn.kind === 'network' ? st.conn.peer : ''}` : connLabel(st.conn)],
    [t('resolution'), st.video ? `${st.video.width}×${st.video.height}  ${st.video.codec}` : '-'],
    [t('framerate'), `${s.fps || 0} fps`],
    [t('bitrate'), `${(s.kbps || 0).toLocaleString()} kbps`],
    [t('audio'), st.audio ? `${st.audio.rate} Hz, ${st.audio.channels} ch, ${s.akbps || 0} kbps` : '-'],
    [t('audioPlayback'), !st.audio ? t('none') : audio.enabled ? t('playing') : audio.ctx && audio.ctx.state === 'suspended' && !store.get('muted', false) ? t('blocked') : t('off')],
    [t('shownFps'), `${l.fps || 0} fps`],
    [t('capRow'), l.cap === 30 ? t('capRowLocked', l.fpsIn || 0) : `${(adj.fpsCap || 'auto') === 'auto' ? t('capRowAuto') + ', ' : ''}${t('capRowFree')}`],
    [t('latency'), l.lat ? `${l.lat} ms` : '-'],
    [t('frameBuffer'), `${l.depth || 0} / ${l.target || 0}`],
    [t('jitterLabel'), `${l.jitter || 0} ms`],
    [t('audioBufLabel'), audio.ctx ? `${audio.stats.fillMs} / ${Math.round(audio.effectiveMs)} ms` : '-'],
    [t('audioUnderruns'), audio.ctx ? `${audio.stats.underruns}\u00d7${audio.stats.droppedMs ? `, ${t('audioTrimmed')} ${audio.stats.droppedMs} ms` : ''}` : '-'],
    [t('audioPath'), audio.worklet ? (S.audioDirect ? 'AudioWorklet (worker \u2192 audio thread)' : 'AudioWorklet') : t('mainThread')],
    [t('dropped'), String((l.dropped || 0) + (l.skipped || 0))],
    [t('srcHitches'), s.srcMaxGap ? `${s.srcHitchTotal || 0}\u00d7  (${t('maxGap')} ${s.srcMaxGap} ms)` : '-'],
    [t('lateHere'), `${l.late || 0}/s`],
    [t('decoderLabel'), `${l.hw === 'gpu' ? t('decGpu') : l.hw ? t('decAuto') : '-'}${l.light ? ` (${t('lightOn')})` : ''}`],
    [t('renderPath'), player.mode === 'worker' ? 'Worker + OffscreenCanvas' : t('mainThread')],
    [t('keyframes'), String(s.keys || 0)],
    [t('replayBuffer'), `${s.replaySeconds || 0} / ${st.replaySeconds} s`],
  ];
  const dg = diagnose();
  $('#diag').hidden = !dg;
  if (dg) { $('#diag').className = `diag ${dg.cls === 'ok' ? '' : dg.cls}`; $('#diagTitle').textContent = dg.title; $('#diagText').textContent = dg.text; }
  const kv = $('#statsKv');
  kv.innerHTML = '';
  for (const [k, v] of rows) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; kv.append(dt, dd); }
  graph($('#graphFps'), S.history.map((h) => h.fps), 70);
  graph($('#graphKbps'), S.history.map((h) => h.kbps), null);
  const ul = $('#viewerList');
  ul.innerHTML = '';
  for (const c of S.clients) {
    const li = document.createElement('li');
    const isPilot = st.pilot && st.pilot.id === c.id;
    li.innerHTML = '<span></span><small></small>';
    li.firstChild.textContent = c.name + (c.id === S.myId ? ` (${t('you')})` : '');
    li.lastChild.textContent = isPilot ? t('pilot') : `${c.role} ${c.addr}`;
    if (isPilot) li.lastChild.className = 'pilot';
    ul.append(li);
  }
}

/* where frames are lost, from the last 5 seconds */
function diagnose() {
  const st = S.state, l = S.local || {};
  if (!st || st.conn.state !== 'connected' || !st.video || S.history.length < 6) return null;
  const recent = S.history.slice(-5);
  const fps = Math.round(recent.reduce((a, h) => a + h.fps, 0) / recent.length);
  const kbps = recent.reduce((a, h) => a + h.kbps, 0) / recent.length;
  const stalls = recent.filter((h) => (h.gap || 0) > 60).length;
  const res = `${st.video.width}\u00d7${st.video.height}`;
  if (fps < 20) return null; // paused, a menu, or a loading screen
  const gameAt30 = fps >= 28 && fps <= 32;
  if (l.cap === 30 && fps >= 29 && !(l.fps && l.fps < 25)) return { cls: 'ok', title: t('dgCapped'), text: t('dgCappedText', fps), fps, res };
  if (!gameAt30 && fps < 56) {
    if (st.conn.kind === 'network' && (stalls >= 2 || kbps > 25000)) return { cls: 'bad', title: t('dgNet'), text: t('dgNetText', fps, (kbps / 1000).toFixed(1)), fps, res };
    return { cls: 'warn', title: t('dgConsole'), text: t('dgConsoleText', fps), fps, res };
  }
  if (l.fps && l.fps < fps - 4) return { cls: 'warn', title: t('dgPc'), text: t('dgPcText', fps, l.fps), fps, res, pc: true };
  return { cls: 'ok', title: t('dgOk'), text: t('dgOkText', fps), fps, res };
}

function graph(cv, values, fixedMax) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.offsetWidth * dpr, h = cv.offsetHeight * dpr;
  if (!w) return;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  const max = fixedMax || Math.max(1000, ...values) * 1.15;
  g.strokeStyle = '#2d3948'; g.lineWidth = 1;
  for (let i = 1; i < 4; i++) { const y = (h / 4) * i; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  if (values.length < 2) return;
  const step = w / 179;
  const x0 = w - (values.length - 1) * step;
  g.beginPath();
  values.forEach((v, i) => { const x = x0 + i * step, y = h - (v / max) * (h - 6) - 3; i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.strokeStyle = '#f2b84b'; g.lineWidth = 2 * dpr; g.stroke();
  g.fillStyle = '#8f9cae'; g.font = `${11 * dpr}px Bahnschrift, sans-serif`;
  g.fillText(String(Math.round(max)), 6 * dpr, 13 * dpr);
}

/* settings */
async function loadSettings() {
  const cfg = await api('/api/config');
  S.config = cfg;
  $('#setMode').value = cfg.connection.mode;
  $('#setHost').value = cfg.connection.host || '';
  $('#setScan').checked = cfg.connection.scan !== false;
  $('#setReplay').value = cfg.replaySeconds;
  $('#setLock').checked = cfg.lockSizeWhileRecording;
  $('#setRecPreset').value = cfg.recordPreset; $('#setLivePreset').value = cfg.livePreset;
  $('#setSmooth').value = adj.smooth;
  $('#setFpsCap').value = adj.fpsCap || 'auto';
  $('#setWorker').checked = store.get('worker', true);
  $('#setLight').checked = !!adj.light;
  $('#setPin').value = '';
  $('#setPin').placeholder = cfg.pinSet ? '••••' : '';
  $('#setName').value = deviceName();
  $('#setLang').value = getLang();
  $('#ffmpegNote').hidden = !!(S.state && S.state.ffmpeg);
  renderTargets(cfg.restreamTargets);
  $('#adjBright').value = adj.bright; $('#adjContrast').value = adj.contrast; $('#adjSat').value = adj.sat;
  $('#adjSharp').value = adj.sharp; $('#adjAudio').value = adj.audioMs; $('#adjAudioOut').textContent = `${adj.audioMs} ms`;
  const base = `${location.protocol}//${location.host}`;
  $('#ovlVideo').textContent = `${base}/overlay`;
  $('#keyTable').innerHTML = KEY_HELP.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
}

function renderTargets(list) {
  const box = $('#targets');
  box.innerHTML = '';
  for (const tg of list) addTargetRow(tg);
}
function addTargetRow(tg = {}) {
  const d = document.createElement('div');
  d.className = 'target';
  d.dataset.id = tg.id || '';
  d.innerHTML = `
    <label><span>${t('name')}</span><input class="tg-name" maxlength="40" placeholder="YouTube"></label>
    <label><span>${t('serverUrl')}</span><input class="tg-url" placeholder="rtmp://a.rtmp.youtube.com/live2"></label>
    <label><span>${t('streamKey')}</span><input class="tg-key" type="password" autocomplete="off"></label>
    <div class="row"><span></span><button type="button" class="btn ghost tg-del"><svg><use href="#i-trash"/></svg><span>${t('remove')}</span></button></div>`;
  d.querySelector('.tg-name').value = tg.name || '';
  d.querySelector('.tg-url').value = tg.url || '';
  if (tg.hasKey) d.querySelector('.tg-key').placeholder = t('keySaved');
  d.querySelector('.tg-del').onclick = () => d.remove();
  $('#targets').append(d);
}
$('#btnAddTarget').onclick = () => addTargetRow();

$('#btnSave').onclick = async () => {
  const targets = $$('#targets .target').map((d) => {
    const key = d.querySelector('.tg-key').value;
    const o = { id: d.dataset.id || undefined, name: d.querySelector('.tg-name').value || 'RTMP', url: d.querySelector('.tg-url').value };
    if (key || !d.dataset.id) o.key = key;
    return o;
  });
  const body = {
    connection: { mode: $('#setMode').value, host: $('#setHost').value, scan: $('#setScan').checked },
    replaySeconds: Number($('#setReplay').value),
    lockSizeWhileRecording: $('#setLock').checked,
    recordPreset: $('#setRecPreset').value,
    livePreset: $('#setLivePreset').value,
    restreamTargets: targets,
  };
  if ($('#setPin').value) body.pin = $('#setPin').value;
  try {
    const cfg = await api('/api/config', body);
    renderTargets(cfg.restreamTargets);
    const name = $('#setName').value.trim();
    if (name && name !== deviceName()) { store.set('name', name); send({ type: 'rename', name }); }
    if (body.pin) location.reload();
    toast(t('saved'), 'ok');
  } catch (e) { toast(e.message, 'error'); }
};
$('#btnReconnect').onclick = async () => {
  await api('/api/connect', $('#setMode').value === 'usb' ? {} : { host: $('#setHost').value.trim() });
};
$('#setLang').onchange = (e) => { setLang(e.target.value); openPage(S.page); renderAll(); };

const onAdj = () => {
  adj = { bright: +$('#adjBright').value, contrast: +$('#adjContrast').value, sat: +$('#adjSat').value, sharp: +$('#adjSharp').value, audioMs: +$('#adjAudio').value, smooth: $('#setSmooth').value, light: $('#setLight').checked, fpsCap: $('#setFpsCap').value };
  $('#adjAudioOut').textContent = `${adj.audioMs} ms`;
  player.setAdjust(adj); player.setMode(adj.smooth); audio.targetMs = adj.audioMs; store.set('adjust', adj);
};
['#adjBright', '#adjContrast', '#adjSat', '#adjSharp', '#adjAudio', '#setSmooth', '#setFpsCap'].forEach((s) => { $(s).oninput = onAdj; $(s).onchange = onAdj; });
$('#setLight').onchange = (e) => { adj.light = e.target.checked; store.set('adjust', adj); player.setAdjust({ light: adj.light }); };
$('#setWorker').onchange = (e) => { store.set('worker', e.target.checked); location.reload(); };
$('#btnResetPic').onclick = () => {
  adj = { ...adjDefaults };
  player.setAdjust(adj); player.setMode(adj.smooth); audio.targetMs = adj.audioMs; store.set('adjust', adj); loadSettings();
};
$$('[data-copy]').forEach((b) => {
  b.onclick = async () => { try { await navigator.clipboard.writeText($('#' + b.dataset.copy).textContent); toast(t('copied'), 'ok', 1500); } catch { /* insecure context */ } };
});

/* ------------------------------------------------------------ boot */
async function boot() {
  applyI18n();
  const ses = await api('/api/session').catch(() => ({ authed: true }));
  if (!ses.authed) {
    $('#login').hidden = false;
    $('#loginForm').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/api/login', { pin: $('#loginPin').value }); location.reload(); } catch { $('#loginErr').hidden = false; }
    };
    return;
  }
  $('#app').hidden = false;
  if (!store.get('muted', false)) audio.enable(48000).then(() => { renderDeck(); renderStage(); }).catch(() => {});
  connectWs();
}
boot();
