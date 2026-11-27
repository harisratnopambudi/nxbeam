#!/usr/bin/env python3
"""
NXBeam Switch pack builder.

Takes the two sysmodule programs of Switch Frame Tap (GPL-2.0, Tomas Uribe,
https://github.com/TomasUribe/switch-frame-tap) and writes an SD-card pack
whose folders are named for NXBeam:

  atmosphere/contents/0100000000000C20/   the streaming sysmodule
  atmosphere/contents/0100000000000C21/   its boot launcher
  NXBeam/console-settings/config.ini      settings (was config/switch-frame-tap)
  NXBeam/console-captures/                screenshots (was switch/switch-frame-tap)

The changes to the programs: the folder names, the USB device name and the
notice title inside their read-only data, replaced by bytes of exactly the
same length, and at most two instructions in the code (CODE_PATCHES, below);
nothing moves. The segment's SHA-256 in the NSO header is recomputed.

  python3 make-switch-pack.py C20/exefs.nsp C21/exefs.nsp OUTDIR [--dvr DIR]
Needs: pip install lz4
"""
import hashlib, os, re, struct, sys, shutil

RULES = [(b'config/switch-frame-tap', b'NXBeam/console-settings'),
         (b'switch/switch-frame-tap', b'NXBeam/console-captures'),
         (b'switch-frame-tap-sound',  b'NXBeam-streaming-sound'),
         (b'switch-frame-tap',        b'NXBeam-streaming'),
         # the name the PC shows for the console on USB (Zadig, Device Manager) and its webcam mode
         (b'Switch Frame Tap\0\0\0\0\0\0\0\0' + b'0001', b'NXBeam' + b'\0' * 18 + b'0001'),
         (b'\0Switch Frame Tap Camera\0', b'\0NXBeam Camera' + b'\0' * 11),
         # the title of the console's on-screen notices; JSON whitespace keeps every later byte in place
         (b'{"title":"Switch Frame Tap",', b'{"title":"NXBeam",' + b' ' * 10)]
SEG = [(0x10, 0x60, 0xA0), (0x20, 0x64, 0xC0), (0x30, 0x68, 0xE0)]

def pfs0_read(d):
    assert d[:4] == b'PFS0', 'not an exefs.nsp (PFS0)'
    n, strsz = struct.unpack_from('<II', d, 4)
    base = 0x10 + n * 0x18; data0 = base + strsz; ents = []
    for i in range(n):
        off, sz, stro = struct.unpack_from('<QQI', d, 0x10 + i * 0x18)
        name = d[base + stro:d.index(b'\0', base + stro)].decode()
        ents.append([name, d[data0 + off:data0 + off + sz], stro])
    return ents, d[base:data0]

def pfs0_write(ents, strtab):
    hdr = bytearray(b'PFS0' + struct.pack('<II', len(ents), len(strtab)) + b'\0' * 4)
    off = 0; body = b''
    for name, data, stro in ents:
        hdr += struct.pack('<QQII', off, len(data), stro, 0); off += len(data); body += data
    return bytes(hdr) + strtab + body

def nso_segments(nso):
    import lz4.block
    flags = struct.unpack_from('<I', nso, 0xC)[0]; out = []
    for k, (h, c, _) in enumerate(SEG):
        foff, _m, dsz = struct.unpack_from('<III', nso, h); csz = struct.unpack_from('<I', nso, c)[0]
        raw = nso[foff:foff + csz]
        out.append(lz4.block.decompress(raw, uncompressed_size=dsz) if flags & (1 << k) else raw)
    return out

# One code change, in the streaming sysmodule (C20): never put an app on the
# "never stream" list. Upstream skips an app for good when it closes within
# 6 s of the stream attaching (meant for anti-debug apps such as TiCo's), and
# homebrew such as emulators and ports, which may quit or crash at start, then
# stayed off the stream. The conditional jump that skips SetExcluded() becomes
# an unconditional one; nothing else in the code moves. Apps can still be left
# out by hand with "Stream aplikasi ini" in the NXBeam overlay.
#   cmp x0, x1 / b.hi +0x34 / ldr x23, [sp, #0xa0] / mov w1, #1
#   -> the same, with b +0x34
CODE_PATCHES = [
    (bytes.fromhex('1f0001eb') + bytes.fromhex('a8010054') + bytes.fromhex('f75340f9') + bytes.fromhex('21008052'),
     bytes.fromhex('1f0001eb') + bytes.fromhex('0d000014') + bytes.fromhex('f75340f9') + bytes.fromhex('21008052')),
    # For a module built from source (switch-sysmodule/): libstratosphere stops a module
    # on a firmware newer than the Atmosphere it was built with (hos_version_api.cpp,
    # current <= Version_Max). The official Switch Frame Tap binaries compare with
    # 0xFF000000 there, so its own firmware check decides; the same one immediate here:
    #   lsr w1, w19, #24 / mov w0, #0x17000000 / cmp w19, w0  ->  mov w0, #0xff000000
    (bytes.fromhex('617e1853') + bytes.fromhex('00e0a252') + bytes.fromhex('7f02006b'),
     bytes.fromhex('617e1853') + bytes.fromhex('00e0bf52') + bytes.fromhex('7f02006b')),
]

def patch_nso(nso):
    import lz4.block
    flags = struct.unpack_from('<I', nso, 0xC)[0]
    text, ro, data = nso_segments(nso)
    new = ro
    for a, b in RULES:
        assert len(a) == len(b); new = new.replace(a, b)
    code = text
    for a, b in CODE_PATCHES:
        assert len(a) == len(b)
        if code.count(a) == 1: code = code.replace(a, b)
    raws = []
    for h, c, _ in SEG:
        foff = struct.unpack_from('<I', nso, h)[0]; csz = struct.unpack_from('<I', nso, c)[0]
        raws.append(nso[foff:foff + csz])
    if code != text: raws[0] = lz4.block.compress(code, store_size=False) if flags & 1 else code
    raws[1] = lz4.block.compress(new, store_size=False) if flags & 2 else new
    first = min(struct.unpack_from('<I', nso, h)[0] for h, _, _ in SEG)
    out = bytearray(nso[:first])
    for k, (h, c, _) in enumerate(SEG):
        struct.pack_into('<I', out, h, len(out)); struct.pack_into('<I', out, c, len(raws[k])); out += raws[k]
    struct.pack_into('32s', out, 0xA0, hashlib.sha256(code).digest())
    struct.pack_into('32s', out, 0xC0, hashlib.sha256(new).digest())
    t2, r2, d2 = nso_segments(bytes(out))
    assert t2 == code and d2 == data and r2 == new and b'switch-frame-tap' not in r2
    assert len(code) == len(text) and sum(x != y for x, y in zip(code, text)) <= 4 * len(CODE_PATCHES)
    return bytes(out)

def patch_nsp(path):
    ents, strtab = pfs0_read(open(path, 'rb').read())
    for e in ents:
        if e[0] == 'main': e[1] = patch_nso(e[1])
    return pfs0_write(ents, strtab)

if __name__ == '__main__':
    if len(sys.argv) < 4: sys.exit(__doc__)
    c20, c21, out = sys.argv[1:4]
    a = os.path.join(out, 'atmosphere/contents/0100000000000C20'); b = os.path.join(out, 'atmosphere/contents/0100000000000C21')
    os.makedirs(a, exist_ok=True); os.makedirs(os.path.join(b, 'flags'), exist_ok=True)
    open(os.path.join(a, 'exefs.nsp'), 'wb').write(patch_nsp(c20))
    open(os.path.join(b, 'exefs.nsp'), 'wb').write(patch_nsp(c21))
    open(os.path.join(b, 'flags/boot2.flag'), 'wb').close()
    # no toolbox.json: the sysmodules menu (Ultrahand) would put a boot flag on
    # the module itself when switched on; the NXBeam overlay has the switches
    for d in ['NXBeam/console-settings', 'NXBeam/console-captures/screenshots']: os.makedirs(os.path.join(out, d), exist_ok=True)
    if '--dvr' in sys.argv:
        src = sys.argv[sys.argv.index('--dvr') + 1]
        shutil.copytree(src, os.path.join(out, 'NXBeam/console-settings/dvr-patches'), dirs_exist_ok=True)
    print('pack written to', out)
