'use strict';
/*
 * Online updates for the PC app. Every release carries latest.json:
 *   { version, build, notes, files: { "<asset>": { sha256, size } } }
 * build is the release's CI run number, so a fix republished under the same
 * version still counts as new. The app knows its own from build.json (written
 * by CI; a source checkout has none and never updates itself).
 *
 * Applying: download the asset for this platform, check its SHA-256, unpack it
 * into .update/staged, then exit with code 75. The launcher (Start NXBeam.bat,
 * .command, start.sh) runs tools/apply-update.js, which copies the staged files
 * over the app, and starts NXBeam again.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const unzip = require('./unzip');

const REPO = 'harisratnopambudi/nxbeam';
// NXBEAM_UPDATE_BASE points a test at a local folder served over http
const TEST_BASE = process.env.NXBEAM_UPDATE_BASE || '';
const LATEST_URL = TEST_BASE ? `${TEST_BASE}/latest.json` : `https://github.com/${REPO}/releases/latest/download/latest.json`;
const assetUrl = (version, name) => TEST_BASE ? `${TEST_BASE}/${name}` : `https://github.com/${REPO}/releases/download/v${version}/${name}`;
const APP_DIR = path.resolve(__dirname, '..');
const UPDATE_DIR = path.join(APP_DIR, '.update');
const EXIT_UPDATE = 75;

function readBuild() {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'build.json'), 'utf8'));
    return { version: String(b.version || ''), build: Number(b.build) || 0 };
  } catch {
    let version = '';
    try { version = require('../package.json').version; } catch {}
    return { version, build: 0 };
  }
}

/** GET with redirects (GitHub sends release downloads elsewhere) */
function get(url, onData, redirects = 6) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('http:') ? http : https).get(url, { headers: { 'user-agent': 'NXBeam-updater' }, timeout: 20000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).toString(), onData, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const total = Number(res.headers['content-length']) || 0;
      const chunks = [];
      let got = 0;
      res.on('data', (c) => { chunks.push(c); got += c.length; if (onData) onData(got, total); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** the release file this copy of NXBeam updates from */
function assetName() {
  const portable = fs.existsSync(path.join(APP_DIR, 'runtime'));
  if (portable && process.platform === 'win32') return 'NXBeam-PC-Windows.zip';
  if (portable && process.platform === 'darwin') return process.arch === 'arm64' ? 'NXBeam-PC-macOS-AppleSilicon.zip' : 'NXBeam-PC-macOS-Intel.zip';
  return 'NXBeam-PC-source.zip';
}

class Updater extends EventEmitter {
  constructor({ enabled = true } = {}) {
    super();
    this.current = readBuild();
    this.enabled = enabled && this.current.build > 0;
    // the launchers set this: only they can swap the files and start again
    this.canApply = process.env.NXBEAM_LAUNCHER === '2';
    this.latest = null;
    this.state = 'idle'; // idle | checking | available | downloading | ready | error | current
    this.progress = 0;
    this.error = '';
    this.timer = null;
  }

  info() {
    return {
      enabled: this.enabled, canApply: this.canApply, state: this.state, progress: this.progress, error: this.error,
      current: this.current,
      latest: this.latest && { version: this.latest.version, build: this.latest.build, notes: this.latest.notes || '' },
      available: this.available(),
    };
  }

  available() { return !!(this.latest && this.latest.build > this.current.build); }

  start() {
    if (!this.enabled) return;
    setTimeout(() => this.check().catch(() => {}), 8000);
    this.timer = setInterval(() => this.check().catch(() => {}), 6 * 3600 * 1000);
    this.timer.unref();
  }

  set(state, extra = {}) {
    Object.assign(this, { state }, extra);
    this.emit('change', this.info());
  }

  async check() {
    if (!this.enabled || this.state === 'downloading' || this.state === 'ready') return this.info();
    this.set('checking', { error: '' });
    try {
      const body = await get(LATEST_URL);
      const j = JSON.parse(body.toString('utf8'));
      if (!j || typeof j.build !== 'number') throw new Error('latest.json without a build number');
      this.latest = j;
      this.set(this.available() ? 'available' : 'current');
    } catch (e) {
      this.set('error', { error: e.message });
    }
    return this.info();
  }

  /** downloads, verifies and unpacks; resolves when NXBeam may restart */
  async apply() {
    if (!this.available()) throw new Error('no update available');
    if (!this.canApply) throw new Error('start NXBeam with its launcher (Start NXBeam) to update from here');
    const name = assetName();
    const meta = this.latest.files && this.latest.files[name];
    if (!meta || !meta.sha256) throw new Error(`${name} is not in this release`);
    this.set('downloading', { progress: 0, error: '' });
    try {
      const url = assetUrl(this.latest.version, name);
      let last = 0;
      const buf = await get(url, (got, total) => {
        const p = Math.floor((got / (total || meta.size || 1)) * 100);
        if (p !== last) { last = p; this.progress = p; this.emit('change', this.info()); }
      });
      const sum = crypto.createHash('sha256').update(buf).digest('hex');
      if (sum !== meta.sha256) throw new Error('the download does not match its checksum');
      fs.rmSync(UPDATE_DIR, { recursive: true, force: true });
      const staged = path.join(UPDATE_DIR, 'staged');
      fs.mkdirSync(staged, { recursive: true });
      const zip = path.join(UPDATE_DIR, name);
      fs.writeFileSync(zip, buf);
      unzip.extract(zip, staged, unzip.commonRoot(zip));
      fs.rmSync(zip, { force: true });
      if (!fs.existsSync(path.join(staged, 'src', 'index.js'))) throw new Error('the update has no src/index.js');
      fs.writeFileSync(path.join(UPDATE_DIR, 'ready.json'), JSON.stringify({ from: this.current, to: { version: this.latest.version, build: this.latest.build } }));
      this.set('ready', { progress: 100 });
    } catch (e) {
      fs.rmSync(UPDATE_DIR, { recursive: true, force: true });
      this.set('error', { error: e.message });
      throw e;
    }
  }
}

module.exports = { Updater, EXIT_UPDATE, APP_DIR, UPDATE_DIR, readBuild, assetName };
