<div align="center">

<img src="public/icon.svg" width="96" alt="NXBeam">

# NXBeam

**Stream Nintendo Switch ke browser: tonton di banyak perangkat, main dari PC atau ponsel, rekam, simpan klip, dan siaran langsung.**

[![Release](https://img.shields.io/github/v/release/harisratnopambudi/nxbeam?label=release&color=f2b84b)](https://github.com/harisratnopambudi/nxbeam/releases/latest)
[![Build](https://github.com/harisratnopambudi/nxbeam/actions/workflows/release.yml/badge.svg)](https://github.com/harisratnopambudi/nxbeam/actions/workflows/release.yml)
[![Downloads](https://img.shields.io/github/downloads/harisratnopambudi/nxbeam/total?color=58c68e)](https://github.com/harisratnopambudi/nxbeam/releases)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20GPL--2.0-blue)](#lisensi)

![Windows](https://img.shields.io/badge/Windows-portable-0078d4?logo=windows&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-Node.js-fcc624?logo=linux&logoColor=black)
![macOS](https://img.shields.io/badge/macOS-Node.js-000000?logo=apple&logoColor=white)
![Nintendo Switch](https://img.shields.io/badge/Nintendo%20Switch-Atmosph%C3%A8re-e60012?logo=nintendoswitch&logoColor=white)
![USB + Network](https://img.shields.io/badge/koneksi-USB%20%7C%20Jaringan-2d3948)
![1080p60](https://img.shields.io/badge/hingga-1080p%2060fps-6a4fb6)
![Haris DevLab](https://img.shields.io/badge/by-Haris%20DevLab-151b24)

[![Tested firmware](https://img.shields.io/badge/diuji-FW%2023.5.0-58c68e?logo=nintendoswitch&logoColor=white)](#kompatibilitas)
[![Tested Atmosphère](https://img.shields.io/badge/diuji-Atmosph%C3%A8re%201.12.2%7CE-58c68e)](#kompatibilitas)

</div>

---

## Unduh

Ambil dua file dari **[Releases](https://github.com/harisratnopambudi/nxbeam/releases/latest)**:

| File | Untuk | Cara pakai |
|---|---|---|
| **`NXBeam-Switch.zip`** | SD card Switch | Ekstrak ke **root SD card** (folder `atmosphere`, `NXBeam`, `switch`), lalu nyalakan Switch. |
| **`NXBeam-PC-Windows.zip`** | Viewer di PC Windows | Ekstrak, lalu klik **`Start NXBeam.bat`**. Portable: Node.js, ffmpeg, dan USB sudah termasuk. |
| `NXBeam-PC-source.zip` | Linux / macOS | Butuh Node.js 18+, jalankan `./start.sh`. |

Setelah itu buka `http://localhost:8090`. NXBeam menemukan Switch sendiri. Perangkat lain di WiFi yang sama bisa ikut menonton dengan membuka alamat IP PC tersebut, yang tertera di jendela NXBeam (misalnya `http://192.168.1.10:8090`).

## Fitur

| | |
|---|---|
| **Banyak penonton** | PC, laptop, ponsel, tablet, TV: cukup browser, tanpa install. |
| **Main dari mana saja** | Gamepad, keyboard, atau stik layar sentuh di ponsel, dengan serah-terima kontrol. |
| **Mode Main** | Satu klik: suara, kontrol, layar penuh, penghitung fps. |
| **Frame rate mengikuti game** | 60 fps bila stabil, dikunci 30 fps yang rata bila tidak. |
| **Simpan klip** | Simpan 30 detik terakhir sebagai MP4, satu klik atau tombol `C`. |
| **Rekam & siaran** | MP4 dan RTMP (YouTube, Twitch), kualitas asli atau 1080p60. |
| **Overlay OBS** | `http://localhost:8090/overlay`: video dan suara game saja, siap untuk Browser Source. |
| **Diagnosa** | Menunjukkan apakah frame hilang di konsol, di jaringan, atau di PC. |
| **Menu di Switch** | Overlay NXBeam: Mode USB / Jaringan, layar Switch mati saat streaming, restart. |

## Kompatibilitas

Sudah diuji di:

| Komponen | Versi |
|---|---|
| Firmware Switch | **23.5.0** |
| Atmosphère | **1.12.2\|E** (emuMMC) |

## Di Switch

Butuh Atmosphère, serta Ultrahand Overlay atau Tesla Menu untuk menu NXBeam. Di SD card:

```
atmosphere/contents/0100000000000C20/   sysmodule streaming (tanpa UI)
atmosphere/contents/0100000000000C21/   peluncurnya saat boot
NXBeam/console-settings/config.ini      setting
switch/.overlays/nxbeam.ovl             menu NXBeam di overlay
```

Buka overlay (**ZL + ZR + D-pad Bawah**), pilih **NXBeam**: **Mode USB** / **Mode Jaringan**, **Layar mati saat streaming**, lalu **Restart Switch**.

Panduan lengkap (USB dan Zadig, 1080p60, OBS, siaran, tips kelancaran): **[docs/PANDUAN.md](docs/PANDUAN.md)**.

## Build

- Rilis dibuat otomatis oleh GitHub Actions setiap push ke `main`, dengan versi diambil dari `package.json` (misalnya `v1.11.0`).
- Overlay Switch ada di folder [`overlay/`](overlay) dan dibangun dalam workflow yang sama.
- Jalankan dari kode: `npm install && npm start`. Uji tanpa konsol: `npm run simulate`. Tes: `npm test`.

## Lisensi

- Aplikasi PC NXBeam: **MIT**, Haris DevLab.
- Sysmodule streaming di `switch-pack/`: **[Switch Frame Tap](https://github.com/TomasUribe/switch-frame-tap)** oleh Tomas Uribe, **GPL-2.0**. Satu-satunya perubahan adalah nama folder di dalam program (lihat `switch-pack/NXBeam/lisensi/PERUBAHAN.txt` dan `tools/make-switch-pack.py`).
- Patch suara: [dvr-patches](https://github.com/exelix11/dvr-patches) oleh exelix11, BSD-3-Clause.
- Overlay (`overlay/`): GPL-2.0, memakai libtesla oleh WerWolv.

<div align="center"><sub>Dibuat oleh <b>Haris DevLab</b> (harisdevlab.online)</sub></div>
