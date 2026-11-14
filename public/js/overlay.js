/*
 * OBS overlay: /overlay          the game's video with sound, nothing else
 * Options: audio=0 (no sound), pad=1 (also show the buttons pressed),
 *          video=0&pad=1 (only the buttons, transparent), pos=br|bl|tr|tl|center, size=320
 */
import { AudioPlayer } from './player.js';
import { StreamView } from './view.js';

const q = new URLSearchParams(location.search);
// video (with sound) by default; the button display only on request (?pad=1)
const withVideo = q.get('video') !== '0';
const withPad = q.get('pad') === '1';
const padEl = document.getElementById('pad');
padEl.className = `pad ${q.get('pos') || 'br'}`;
padEl.style.setProperty('--w', `${Number(q.get('size')) || 320}px`);
padEl.hidden = !withPad;

let player = null, audio = null;
// a browser without WebCodecs (an old OBS) cannot show the video: say so instead of a black page
if (withVideo && typeof window.VideoDecoder !== 'function') {
  const m = document.getElementById('msg');
  m.hidden = false;
  m.textContent = 'This browser cannot decode the video (no WebCodecs). Update OBS to version 30 or newer.';
}
if (withVideo) {
  document.body.classList.add('video');
  const cv = document.getElementById('video');
  cv.hidden = false;
  if (q.get('audio') !== '0') {
    audio = new AudioPlayer();
    // OBS browser sources may play audio without a gesture; browsers wait for a click
    audio.enable(48000).catch(() => {});
    document.addEventListener('click', () => audio.enable(48000));
  }
}
const buttons = [...document.querySelectorAll('[data-b]')];
const ls = document.getElementById('ls'), rs = document.getElementById('rs');
let idleTimer;
function showPad(s) {
  const b = s ? s.buttons : 0;
  for (const el of buttons) el.classList.toggle('on', (b & (1 << Number(el.dataset.b))) !== 0);
  const mv = (el, cx, cy, x, y) => { el.setAttribute('cx', cx + (x / 32767) * 13); el.setAttribute('cy', cy - (y / 32767) * 13); };
  mv(ls, 78, 78, s ? s.lx : 0, s ? s.ly : 0);
  mv(rs, 206, 122, s ? s.rx : 0, s ? s.ry : 0);
  padEl.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => padEl.classList.add('idle'), s ? 8000 : 1500);
}
showPad(null);

const hello = { type: 'hello', name: 'OBS overlay', role: 'overlay', video: withVideo, audio: withVideo && !!audio, padEvents: withPad };
let ws;
if (withVideo) {
  // video: decoded and drawn in the media worker, like the main page
  player = new StreamView(document.getElementById('video'), {
    onJson: (m) => { if (m.type === 'pad') showPad(m.state); },
    onAudio: (u8, rate, ch) => audio && audio.push(u8, rate, ch),
    onClose: () => setTimeout(() => player.connect(hello), 1500),
  });
  if (audio) audio.init().then(() => player.attachAudioPort(audio.connectPort())).catch(() => {});
  player.connect(hello);
} else {
  const connect = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify(hello));
    ws.onmessage = (ev) => { if (typeof ev.data === 'string') { const m = JSON.parse(ev.data); if (m.type === 'pad') showPad(m.state); } };
    ws.onclose = () => setTimeout(connect, 1500);
  };
  connect();
}
