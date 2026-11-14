'use strict';
/* Minimal H.264 Annex-B helpers: NAL splitting, codec string, avcC. */

function splitNals(buf) {
  const nals = [];
  let i = 0, start = -1;
  const n = buf.length;
  while (i + 2 < n) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && i + 3 < n && buf[i + 3] === 1))) {
      const sc = buf[i + 2] === 1 ? 3 : 4;
      if (start >= 0) {
        let end = i;
        while (end > start && buf[end - 1] === 0) end--;
        nals.push(buf.subarray(start, end));
      }
      i += sc;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < n) nals.push(buf.subarray(start, n));
  return nals.filter((x) => x.length > 0);
}

const nalType = (nal) => nal[0] & 0x1f;

function findParams(annexb) {
  let sps = null, pps = null, idr = false;
  for (const nal of splitNals(annexb)) {
    const t = nalType(nal);
    if (t === 7 && !sps) sps = nal;
    else if (t === 8 && !pps) pps = nal;
    else if (t === 5) idr = true;
  }
  return { sps, pps, idr };
}

function codecString(sps) {
  if (!sps || sps.length < 4) return 'avc1.640028';
  const hex = (v) => v.toString(16).padStart(2, '0');
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

function avcC(sps, pps) {
  const out = Buffer.alloc(11 + sps.length + pps.length);
  let o = 0;
  out[o++] = 1; out[o++] = sps[1]; out[o++] = sps[2]; out[o++] = sps[3];
  out[o++] = 0xff; // 4-byte NAL lengths
  out[o++] = 0xe1; // one SPS
  out.writeUInt16BE(sps.length, o); o += 2; sps.copy(out, o); o += sps.length;
  out[o++] = 1;
  out.writeUInt16BE(pps.length, o); o += 2; pps.copy(out, o);
  return out;
}

/* Annex-B access unit -> length-prefixed samples (AUD dropped) */
function toAvcc(annexb) {
  const nals = splitNals(annexb).filter((n) => nalType(n) !== 9);
  const total = nals.reduce((s, n) => s + 4 + n.length, 0);
  const out = Buffer.alloc(total);
  let o = 0;
  for (const n of nals) { out.writeUInt32BE(n.length, o); n.copy(out, o + 4); o += 4 + n.length; }
  return out;
}

module.exports = { splitNals, nalType, findParams, codecString, avcC, toAvcc };
