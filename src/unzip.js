'use strict';
// A small ZIP reader for the updater: stored and deflated entries, the unix
// mode kept where the archive has one. No dependency, no external tool.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function entries(buf) {
  // end of central directory: the last 22..65557 bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const attr = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen).replace(/\\/g, '/');
    const mode = madeBy === 3 ? (attr >>> 16) & 0o777 : 0;
    out.push({ name, method, csize, size, local, mode });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

function data(buf, e) {
  const p = e.local;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('bad zip entry ' + e.name);
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const raw = buf.subarray(start, start + e.csize);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`zip method ${e.method} not supported (${e.name})`);
}

/** extracts every entry under dest; strip removes a leading folder ("NXBeam/") */
function extract(file, dest, strip = '') {
  const buf = fs.readFileSync(file);
  const root = path.resolve(dest);
  let files = 0;
  for (const e of entries(buf)) {
    let name = e.name;
    if (strip && name.startsWith(strip)) name = name.slice(strip.length);
    if (!name || name.endsWith('/')) continue;
    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep)) throw new Error('unsafe path in zip: ' + e.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const body = data(buf, e);
    if (body.length !== e.size) throw new Error('size mismatch in ' + e.name);
    fs.writeFileSync(target, body);
    if (e.mode && process.platform !== 'win32') fs.chmodSync(target, e.mode);
    files++;
  }
  return files;
}

/** the leading folder every entry shares, or '' */
function commonRoot(file) {
  const names = entries(fs.readFileSync(file)).map((e) => e.name);
  const first = names[0] && names[0].split('/')[0] + '/';
  return first && names.every((n) => n.startsWith(first)) ? first : '';
}

module.exports = { extract, commonRoot, entries };
