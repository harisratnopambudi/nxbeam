'use strict';
/*
 * Run by the launcher after NXBeam exits with code 75: copies the update
 * staged in .update/staged over the app, then the launcher starts NXBeam again.
 *
 * Left alone: the launchers themselves (a running .bat or shell script must
 * not change under it), the user's data. The Node.js runtime cannot be
 * replaced while it runs this script: a new one goes to runtime/node.next and
 * the launcher swaps it in before the next start.
 */
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const STAGED = path.join(APP, '.update', 'staged');
const KEEP = new Set(['Start NXBeam.bat', 'Start NXBeam.command', 'start.sh']);

function same(a, b) {
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
}

/*
 * Windows: a file in use (NXBeam.exe and its WebView2 libraries while the
 * NXBeam window is open) cannot be overwritten, but it can be renamed: the
 * old one becomes <name>.old (NXBeam.exe deletes those at its next start, and
 * seeing NXBeam.exe.old, starts the new copy of itself).
 */
function put(src, dst) {
  if (same(src, dst)) return false;
  try {
    fs.copyFileSync(src, dst);
  } catch (e) {
    if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
    const old = `${dst}.old`;
    try { fs.rmSync(old, { force: true }); } catch { /* an older .old still in use: keep going */ }
    fs.renameSync(dst, fs.existsSync(old) ? `${dst}.${Date.now()}.old` : old);
    fs.copyFileSync(src, dst);
  }
  return true;
}

function copyTree(from, to, rel = '') {
  let n = 0;
  for (const e of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    const src = path.join(from, r);
    const dst = path.join(to, r);
    if (e.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); n += copyTree(from, to, r); continue; }
    if (!rel && KEEP.has(e.name) && fs.existsSync(dst)) continue;
    if (/^runtime[\\/]node(\.exe)?$/.test(r)) {
      if (!same(src, dst)) {
        const next = dst.replace(/(\.exe)?$/, '.next$1');
        fs.copyFileSync(src, next);
        fs.chmodSync(next, fs.statSync(src).mode);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (!put(src, dst)) continue;
    if (process.platform !== 'win32') fs.chmodSync(dst, fs.statSync(src).mode);
    n++;
  }
  return n;
}

function main() {
  if (!fs.existsSync(path.join(APP, '.update', 'ready.json')) || !fs.existsSync(STAGED)) {
    console.log('  No update to apply.');
    return;
  }
  const info = JSON.parse(fs.readFileSync(path.join(APP, '.update', 'ready.json'), 'utf8'));
  console.log(`\n  Updating NXBeam ${info.from.version} -> ${info.to.version} (build ${info.to.build})...`);
  const n = copyTree(STAGED, APP);
  fs.rmSync(path.join(APP, '.update'), { recursive: true, force: true });
  console.log(`  ${n} files updated. Starting NXBeam again.\n`);
}

try { main(); } catch (e) {
  console.error('  The update failed: ' + e.message);
  console.error('  NXBeam starts with the files it has; download the new version from GitHub Releases if it does not.');
  process.exitCode = 1;
}
