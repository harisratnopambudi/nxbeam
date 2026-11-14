# NXBeam overlay

Menu NXBeam di overlay Switch (Ultrahand / Tesla): pilih **Mode USB** atau **Mode Jaringan**, lalu **Restart Switch**. Dibangun otomatis oleh workflow repo ini dan sudah termasuk di `NXBeam-Switch.zip` (`switch/.overlays/nxbeam.ovl`).

Build lokal dengan devkitPro:

```bash
cd overlay
git clone --depth 1 https://github.com/WerWolv/libtesla libs/libtesla
make
```

Lisensi: GPL-2.0 (libtesla, Tesla-Template oleh WerWolv).
