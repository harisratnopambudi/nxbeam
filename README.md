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

</div>

---

## Unduh

Ambil dua file dari **[Releases](https://github.com/harisratnopambudi/nxbeam/releases/latest)**:

| File | Untuk | Cara pakai |
|---|---|---|
| **`NXBeam-Switch.zip`** | SD card Switch | Ekstrak ke **root SD card** (folder `atmosphere`, `NXBeam`, `switch`), lalu nyalakan Switch. |
| **`NXBeam-PC-Windows.zip`** | Viewer di PC Windows | Ekstrak, lalu klik **`Start NXBeam.bat`**. Portable: Node.js, ffmpeg, dan USB sudah termasuk. |
| `NXBeam-PC-source.zip` | Linux / macOS | Butuh Node.js 18+, jalankan `./start.sh`. |

Setelah itu buka `http://localhost:8090`. NXBeam menemukan Switch sendiri, dan perangkat lain di WiFi yang sama bisa ikut menonton lewat kode QR di Pengaturan.

## Fitur

| | |
|---|---|
| **Banyak penonton** | PC, laptop, ponsel, tablet, TV: cukup browser, tanpa install. |
| **Main dari mana saja** | Gamepad, keyboard, atau stik layar sentuh di ponsel, dengan serah-terima kontrol. |
| **Mode Main** | Satu klik: suara, kontrol, layar penuh, penghitung fps. |
| **Frame rate mengikuti game** | 60 fps bila stabil, dikunci 30 fps yang rata bila tidak. |
| **Simpan klip** | Simpan 30 detik terakhir sebagai MP4, satu klik atau tombol `C`. |
| **Rekam & siaran** | MP4 dan RTMP (YouTube, Twitch), kualitas asli atau 1080p60. |
| **Overlay OBS** | Video dan tampilan tombol yang ditekan, latar transparan. |
| **Diagnosa** | Menunjukkan apakah frame hilang di konsol, di jaringan, atau di PC. |
| **Menu di Switch** | Overlay NXBeam untuk memilih Mode USB / Jaringan. |

## Di Switch

Butuh Atmosphère, serta Ultrahand Overlay atau Tesla Menu untuk menu NXBeam. Di SD card:

```
atmosphere/contents/0100000000000C20/   sysmodule streaming (tanpa UI)
atmosphere/contents/0100000000000C21/   peluncurnya saat boot
NXBeam/console-settings/config.ini      setting
switch/.overlays/nxbeam.ovl             menu NXBeam di overlay
```

Ganti mode: buka overlay (**ZL + ZR + D-pad Bawah**), pilih **NXBeam**, lalu **Mode USB** / **Mode Jaringan**, kemudian **Restart Switch**.

Panduan lengkap (USB dan Zadig, 1080p60, OBS, siaran, tips kelancaran): **[docs/PANDUAN.md](docs/PANDUAN.md)**.

## Build

- Rilis dibuat otomatis oleh GitHub Actions setiap push ke `main`, dengan versi diambil dari `package.json` (misalnya `v1.11.0`).
- Overlay Switch dibangun di repo **[nxbeam-overlay](https://github.com/harisratnopambudi/nxbeam-overlay)**.
- Jalankan dari kode: `npm install && npm start`. Uji tanpa konsol: `npm run simulate`. Tes: `npm test`.

## Lisensi

- Aplikasi PC NXBeam: **MIT**, Haris DevLab.
- Sysmodule streaming di `switch-pack/`: **[Switch Frame Tap](https://github.com/TomasUribe/switch-frame-tap)** oleh Tomas Uribe, **GPL-2.0**. Satu-satunya perubahan adalah nama folder di dalam program (lihat `switch-pack/NXBeam/lisensi/PERUBAHAN.txt` dan `tools/make-switch-pack.py`).
- Patch suara: [dvr-patches](https://github.com/exelix11/dvr-patches) oleh exelix11, BSD-3-Clause.
- Overlay: [nxbeam-overlay](https://github.com/harisratnopambudi/nxbeam-overlay), GPL-2.0 (libtesla).

<div align="center"><sub>Dibuat oleh <b>Haris DevLab</b> (harisdevlab.online)</sub></div>
