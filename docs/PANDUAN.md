# NXBeam

Hub streaming untuk Nintendo Switch ber-Atmosphère. Satu komputer menyambung ke konsol, lalu **semua perangkat di jaringan yang sama** bisa menonton lewat browser, memegang kontrol, merekam, menyimpan klip replay, dan siaran langsung ke YouTube/Twitch, tanpa memasang aplikasi apa pun di perangkat penonton.

NXBeam bekerja dengan sysmodule **[Switch Frame Tap](https://github.com/TomasUribe/switch-frame-tap)** yang terpasang di konsol (sisi Switch). NXBeam adalah pengganti viewer PC-nya, dengan kode yang ditulis sendiri dari nol.

## Yang membedakan dari viewer bawaan

| | Viewer bawaan | NXBeam |
|---|---|---|
| Penonton sekaligus | 1 | Tidak terbatas (PC, laptop, ponsel, tablet, Smart TV dengan browser) |
| Perlu install aplikasi di perangkat penonton | Ya | Tidak, cukup buka browser |
| Kontrol dari | PC (gamepad, keyboard, mouse) / Android gamepad | Perangkat mana saja: gamepad, keyboard, **stik layar sentuh di ponsel**, dengan serah-terima kontrol antar perangkat |
| Replay buffer ("simpan 30 detik terakhir") | Tidak | Ya, satu klik atau tombol `C` |
| Siaran langsung RTMP (YouTube, Twitch, Facebook, dll.) | Tidak | Ya, beberapa tujuan sekaligus, tanpa encode ulang video |
| Overlay OBS | Tidak | Ya, video + tampilan tombol yang ditekan (input display) dengan latar transparan |
| Galeri rekaman/klip/tangkapan | Folder | Di dalam aplikasi: putar, unduh, hapus dari perangkat mana pun |
| Dashboard statistik | HUD | Grafik fps & bitrate, daftar penonton, jeda tampil |
| Proteksi akses | - | PIN opsional |
| Simulator konsol untuk uji/demo | - | Ya |

## Aplikasi Windows (NXBeam-Setup.exe)

Cara termudah di Windows 10/11 adalah memakai **NXBeam-Setup.exe** dari halaman Releases.

- Jalankan installer-nya. NXBeam terpasang untuk pengguna Windows yang sedang dipakai, jadi tidak butuh admin.
- **Driver USB untuk Switch ikut terpasang otomatis.** Tidak perlu Zadig, dan Switch tidak perlu dicolok dulu. Windows hanya meminta izin sekali. Driver disimpan di Windows dan langsung dipakai saat Switch pertama kali dicolok dalam mode USB.
  - Kalau perlu memasang ulang: Start menu > **NXBeam - Install USB driver**, atau lewat ikon NXBeam di tray.
- NXBeam terbuka di **jendelanya sendiri**, tidak di tab browser. Mesinnya Edge (WebView2) yang sudah diatur untuk streaming:
  - GPU selalu dipakai, dan di laptop dengan dua GPU yang dipakai GPU yang kencang, jadi frame generation tetap tersedia;
  - gambar tetap lancar walau jendelanya di belakang jendela lain (enak untuk OBS);
  - suara langsung keluar tanpa perlu klik dulu.
- **F11** untuk layar penuh.
- Menutup jendela tidak menghentikan NXBeam: ia tetap berjalan di **tray** (dekat jam) supaya HP, TV, dan OBS tetap bisa menonton. Untuk benar-benar menutup: klik kanan ikon NXBeam > **Exit**. Di menu yang sama ada pilihan **Start with Windows**.
- Update online tetap jalan seperti biasa. Aplikasinya memperbarui dirinya sendiri lalu terbuka lagi.
- Kalau muncul **"Windows protected your PC"**, klik **More info > Run anyway**. Peringatan ini muncul karena installer belum ditandatangani (code signing berbayar).

Versi portable (**NXBeam-PC-Windows.zip**) tetap tersedia. Ekstrak, lalu jalankan `NXBeam.exe`. Di versi portable, driver USB dipasang lewat menu tray **Install USB driver** atau dengan Zadig.

## Kebutuhan

- **Komputer hub** (Windows, Linux, atau macOS) dengan [Node.js 18+](https://nodejs.org).
- **Switch** dengan Atmosphère dan sysmodule Switch Frame Tap terpasang. Di aplikasi Switch-nya, set **Connection** ke **Network**, lalu restart konsol. Untuk kontrol dari NXBeam, aktifkan juga **Beta > Controller from the PC viewer**.
- **Browser penonton**: Chrome/Edge 94+, Safari 16.4+, atau Chrome Android. Browser harus mendukung WebCodecs.
- ffmpeg sudah ikut terpasang otomatis (paket `ffmpeg-static`). Tanpa ffmpeg, rekaman tetap tersimpan sebagai `.mkv`, tapi fitur siaran tidak aktif.

## Menyiapkan Switch (paket NXBeam-Switch)

Paket `NXBeam-Switch-Jaringan.zip` atau `NXBeam-Switch-USB.zip` cukup diekstrak ke root SD card. Isinya hanya dua folder:

```
atmosphere/contents/0100000000000C20/   sysmodule streaming (tanpa UI)
atmosphere/contents/0100000000000C21/   peluncurnya saat boot
NXBeam/console-settings/config.ini      setting, sudah disetel untuk NXBeam
NXBeam/console-captures/screenshots/    screenshot dari konsol
```

Untuk ganti mode, pakai overlay **NXBeam** di Switch (dengan kombinasi tombol overlay Anda: bawaan Ultrahand ZL + ZR + D-pad Bawah, bawaan Tesla L + D-pad Bawah + R3, atau kombinasi yang sudah Anda ubah), atau salin `config.ini` dari `NXBeam/ganti-mode/`, lalu restart Switch.

Paket ini dibuat dengan `tools/make-switch-pack.py` dari `exefs.nsp` Switch Frame Tap (GPL-2.0, Tomas Uribe). Satu-satunya perubahan adalah nama folder di dalam program, diganti dengan teks yang panjangnya sama persis. Untuk versi baru Switch Frame Tap: `python3 tools/make-switch-pack.py C20/exefs.nsp C21/exefs.nsp OUT --dvr dvr-patches`.

## Menjalankan

**Windows:** klik dua kali `Start NXBeam.bat`.

**Linux / macOS:**

```bash
./start.sh
# atau
npm install
npm start
```

Browser akan terbuka di `http://localhost:8090`. NXBeam menemukan konsol sendiri (beacon UDP 9951, lalu memindai jaringan lokal bila beacon diblokir router). Dari ponsel, buka alamat IP PC yang tertera di jendela NXBeam, misalnya `http://192.168.1.10:8090`.

Opsi baris perintah:

```
--port 8090         port web
--console 192.168.1.20   langsung ke IP konsol
--mode auto|network|usb
--media FOLDER      lokasi rekaman, klip, tangkapan (default: Videos/NXBeam)
--no-open           jangan buka browser
```

## Kelancaran gambar (Mode tampilan)

WiFi mengirim frame tidak rata. Kadang dua sekaligus, kadang telat. NXBeam menahan beberapa frame di buffer kecil, lalu menampilkannya dengan ritme tetap sesuai frame rate game. Ukuran buffer menyesuaikan sendiri dengan fluktuasi jaringan. Pilih di **Pengaturan > Gambar > Mode tampilan**:

- **Jeda terendah**: tanpa buffer. Paling responsif, tapi bisa patah-patah di WiFi.
- **Seimbang** (bawaan): buffer 1–3 frame (sekitar 17–50 ms di 60 fps).
- **Paling halus**: buffer 2–6 frame, untuk WiFi yang kurang stabil.

Audio diputar di thread audio browser (AudioWorklet) dan dikirim langsung dari media worker tanpa lewat halaman. Semburan audio dari konsol ditampung di ring buffer, tidak dibuang. Kecepatan putar dikoreksi halus (maksimal ±0,6%, tidak terdengar) agar buffer tetap di target dan perbedaan clock audio Switch dan PC ikut terkoreksi. Setelah suara sempat habis, buffer membesar 25 ms (sampai +300 ms), lalu mengecil lagi setelah 20 detik lancar. Kondisinya terlihat di **Statistik**: Frame tampil, Buffer gambar, Fluktuasi jaringan, Buffer audio.

Sejak v1.4, video di-decode dan digambar di **thread terpisah** (Web Worker + OffscreenCanvas), sehingga aktivitas lain di halaman tidak bisa menunda frame. Bisa dimatikan di Pengaturan > Gambar bila layar tetap hitam di browser tertentu. Pembacaan USB memakai 4 transfer yang selalu antre di libusb, dan proses hub berjalan dengan prioritas tinggi.

**Diagnosa otomatis:** bagian atas halaman Statistik menyebut di mana frame hilang, yaitu di konsol, di jaringan, atau di PC/browser, beserta solusinya. NXBeam juga memberi tahu sendiri kalau konsol terus mengirim kurang dari 60 fps.

**1080p60 di dock:** decode memakai GPU bila tersedia. Gambar 1080p dirender seukuran aslinya, dan pembesaran ke monitor dikerjakan GPU tanpa beban tambahan. Bila perangkat terus tertinggal, NXBeam otomatis pindah ke mode ringan (tanpa penajaman). Mode ringan juga bisa dipaksa di Pengaturan > Gambar. Di sisi konsol, 1080p60 stabil butuh CPU 1785 MHz (sys-clk) dan jaringan yang kuat; kabel LAN ke dock paling ideal.

**Mencari sumber tersendat** (halaman Statistik):
- **Tersendat dari konsol** naik saat terasa patah: frame memang datang telat dari Switch. Biasanya karena CPU Switch di clock standar (1080p60 butuh 1785 MHz lewat sys-clk), game sedang loading atau adegan berat, atau "Picture > quality" terlalu tinggi.
- **Frame telat di browser** yang naik, sementara angka konsol tetap: masalahnya di PC atau browser. Coba mode tampilan "Paling halus", tutup tab berat, aktifkan akselerasi hardware di Chrome, dan pastikan laptop tidak dalam mode hemat daya.

Tips jaringan: pakai WiFi 5 GHz, letakkan Switch dekat router, atau sambungkan dock dengan kabel LAN. Bila memungkinkan, sambungkan juga PC hub ke router dengan kabel.

## Notifikasi update dan saklar NXBeam di overlay

- Kalau ada versi NXBeam yang lebih baru, overlay menampilkan **Update available** di bagian paling atas dan di bawah judul. Untuk memasangnya, buka aplikasi **NXBeam Update**. Pengecekan berjalan di belakang, paling sering setiap 6 jam, dan hanya kalau Switch tersambung internet.
- Bagian **NXBeam sysmodule** di overlay:
  - **Running**: menyalakan atau mematikan NXBeam saat itu juga, tanpa restart.
  - **Start at boot**: mengatur apakah NXBeam ikut menyala saat Switch dinyalakan.
- NXBeam tidak lagi muncul di menu sysmodules Ultrahand. Di menu itu NXBeam memang tidak bisa dinyalakan. Kalaupun dipaksa, modulnya akan start terlalu awal saat booting dan bisa membuat sebagian konsol error. Pakai saklar di overlay NXBeam sebagai gantinya.

## Mode docked/handheld dan resolusi game (ReverseNX-RT)

Overlay NXBeam punya bagian **Game display (ReverseNX-RT)**. Fungsinya sama dengan ReverseNX-RT, jadi tidak perlu membuka overlay ReverseNX-RT lagi. Bagian ini butuh **SaltyNX** terpasang di Switch.

- **Mode**: pilih **Auto** (ikut sistem), **Docked**, atau **Handheld** untuk game yang sedang jalan. Perubahannya langsung berlaku.
  - Contoh: Switch dipegang (handheld) tapi Mode diset **Docked**, maka game berjalan seperti di dock, di resolusi docked-nya (biasanya 1080p), dan resolusi itu yang dikirim ke NXBeam.
  - Mode docked lebih berat, jadi baterai lebih cepat habis.
- **Docked resolution** / **Handheld resolution**: resolusi tampilan yang dipakai game, dari 480p sampai 1080p. Pilihan ini hanya muncul untuk game yang menanyakannya, dan baru bisa diatur setelah Mode bukan Auto.
- Pilihan disimpan per game, di file yang sama dengan ReverseNX-RT (`/SaltySD/plugins/ReverseNX-RT/`). Pengaturan lama dari ReverseNX-RT tetap terpakai.
- Status **Needs SaltyNX**: SaltyNX belum terpasang. **Not available in this game**: game 32-bit atau game yang dikecualikan SaltyNX.
- Stream NXBeam hanya 1080p kalau game menggambar tepat 1920x1080 dan **Resolution** di overlay diset 1080p.

## Frame generation

Pengaturannya ada di **Settings > Picture**, berlaku untuk perangkat yang sedang dipakai menonton.

- **Frame generation (beta)**, bawaan mati. Di antara dua frame asli disisipkan satu frame buatan. Gerakannya dihitung di GPU, jadi game 30 fps tampil 60 di monitor 60 Hz, dan game 60 fps tampil sekitar 120 di monitor 120/144 Hz.
- Fitur ini hanya aktif kalau game berjalan di bawah refresh layar.
- Jedanya bertambah sekitar setengah frame (17 ms di 30 fps). Di gerakan yang sangat cepat atau objek yang tiba-tiba muncul, bisa terlihat bayangan (ghosting), terutama di layar penuh. Matikan kalau terasa mengganggu.
- Fitur ini butuh akselerasi GPU di browser. Kalau browser berjalan tanpa GPU, atau perangkat tidak kuat (mode ringan aktif), frame generation mati sendiri. Statusnya bisa dilihat di halaman **Stats**.
- Kalau game tersendat di 1080p, set **Resolution** di overlay NXBeam ke **720p**. Pengaturan ini langsung berlaku tanpa restart, dan konsol jadi lebih stabil di 60 fps.

## Veyra: frame generation dan super resolution dari GPU

[Veyra](https://github.com/Likely7/Veyra-NRVideo) adalah aplikasi Windows (GPU NVIDIA/AMD) yang memperhalus video dengan frame generation, super resolution, dan denoise. Teknologinya DLSS, FSR, atau XeSS, jadi hasilnya jauh lebih bagus daripada frame generation bawaan NXBeam. Di aplikasi NXBeam untuk Windows, Veyra tampil **di dalam jendela NXBeam**, jadi tidak perlu membuka dua aplikasi.

1. Unduh dan ekstrak Veyra dari halaman rilisnya. Pilih versi NVIDIA atau AMD sesuai GPU kamu.
2. Di aplikasi NXBeam, tekan tombol **bintang** di kanan bawah. Bisa juga lewat **Settings > Picture > Buka di Veyra**.
3. Pertama kali, NXBeam bertanya letak Veyra. Pilih **veyra_qml_ui.exe** di folder Veyra. Pilihan ini diingat untuk seterusnya.
4. Veyra muncul di area layar NXBeam dan langsung memutar gambar dari Switch. Atur frame generation dan super resolution lewat kontrol Veyra di bawah gambar.
5. Tekan tombol bintang lagi untuk kembali ke tampilan NXBeam biasa.

Hal yang perlu diketahui:

- **Profil terpisah**: NXBeam menjalankan Veyra dengan profilnya sendiri, tanpa buffer jaringan supaya delay sekecil mungkin. Pengaturan Veyra yang biasa kamu pakai tidak berubah.
- **Suara**: suara NXBeam otomatis dimatikan karena suaranya keluar dari Veyra.
- **Frame generation NXBeam**: matikan, tidak perlu dipakai bersamaan dengan Veyra.
- **Kontroler**: kontroler yang tersambung ke Switch tetap jalan seperti biasa.
- **Di browser** (bukan aplikasi NXBeam): tombol yang sama menyuruh Veyra yang sudah terbuka untuk memutar stream. Alamat stream-nya `http://127.0.0.1:8090/live.mkv` juga bisa ditempel manual di Veyra.

## 1080p 60fps

- **Gambar asli 1080p dari konsol:** resolusi ditentukan oleh konsol, bukan oleh NXBeam. Pasang Switch di dock, lalu di aplikasi Switch Frame Tap halaman **Picture** set resolusi maksimum ke 1080p dan aktifkan scaling ke 1080p. Untuk 60 fps penuh, naikkan CPU ke 1785 MHz dengan sys-clk. Mode genggam tetap 720p, kecuali memakai ReverseNX-RT lewat USB.
- **Output rekaman/klip/siaran 1080p60:** di **Pengaturan > Rekaman & klip**, pilih kualitas **1080p 60fps**. Gambar diskalakan ke 1920×1080 60 fps dan di-encode ulang dengan x264. Ini butuh CPU yang cukup kuat (sekitar 1,5 core). Pilihan **Asli dari konsol** tidak membebani CPU sama sekali.

## Frame rate mengikuti game

NXBeam membaca frame rate asli dari frame yang datang, lalu menampilkannya di ritme yang bisa dipertahankan (**Pengaturan > Gambar > Frame rate tampilan**, bawaan Otomatis):

- Game stabil di 60 fps: ditampilkan 60 fps.
- Game 30 fps: ditampilkan 30 fps, mengikuti ritme game itu sendiri.
- Konsol naik-turun di 36–51 fps (paling terasa patah-patah): **dikunci ke 30 fps yang rata**, lalu kembali ke 60 otomatis setelah 5 detik stabil di 60.

Status kuncinya terlihat di penghitung fps mode Main ("30 (dikunci 30)") dan di Statistik.

## Mode Main dan setting Switch untuk minimal 30 fps

Tombol **Main** di deck menyiapkan semuanya dengan satu klik: menyalakan suara, memegang kontrol, masuk layar penuh, dan menampilkan penghitung fps kecil di pojok. Tekan Esc untuk keluar.

NXBeam tidak bisa menambah frame yang tidak dikirim konsol, dan protokolnya tidak punya perintah untuk mengubah resolusi dari PC. Karena itu, **penjaga FPS** langsung memberi tahu saat konsol mengirim kurang dari 30 fps selama beberapa detik, beserta setting yang harus diubah. Rekomendasi di aplikasi Switch Frame Tap:

| Tujuan | Setting |
|---|---|
| Selalu lancar (60 fps), paling pasti | Overlay NXBeam > **Resolution: 720p** (langsung berlaku, tanpa restart). NXBeam memperbesar dan menajamkannya ke layar. |
| 1080p, tetap di atas 30 fps | Picture > **Faster memory while streaming: On**, CPU **1785 MHz** dengan sys-clk, matikan cheat untuk game itu, dan kabel LAN ke dock |

## Pintasan keyboard

Saat tidak memegang kontrol: `F` layar penuh, `M` suara, `P` tangkapan layar, `C` simpan klip, `R` rekam.

Saat memegang kontrol (dapat diubah di `public/js/input.js`):

| Keyboard | Switch |
|---|---|
| W A S D | Stik kiri |
| Numpad 8 4 5 6 | Stik kanan |
| K J I U | A B X Y |
| Panah | D-pad |
| Q E / 1 3 | L R / ZL ZR |
| Enter / Backspace | + / − |
| F G | L3 R3 |
| H / C | HOME / Capture |

Gamepad memakai posisi tombol, bukan labelnya: tombol bawah selalu menjadi B Switch, tombol kanan menjadi A.

### Tampilkan HOME menu dan overlay (beta)

Bawaannya hanya game yang tampil. Supaya semua yang ada di layar Switch ikut tampil (mirroring penuh), buka overlay NXBeam lalu nyalakan di bagian **Full mirroring (beta)**, kemudian **Restart Switch**:

- **HOME menu**: HOME menu, Album, dan layar sistem ikut tampil.
- **System overlays**: bar volume, quick settings, menu power, dan menu Tesla/Ultrahand ikut tampil di atas game. Overlay disalin 10-20 kali per detik, jadi gerakannya sedikit kurang halus dibanding game.

Catatan: manual game, eShop, dan applet lain tetap menghentikan stream sementara. Fitur ini masih beta dari sysmodule-nya.

### Homebrew, emulator, atau game port

Semua aplikasi ikut tampil, termasuk homebrew (GreenX, emulator, game port): sysmodule NXBeam tidak pernah melewati aplikasi secara otomatis. Homebrew yang dibuka dari **Album** hanya tampil kalau **HOME menu** (Full mirroring) dinyalakan. Aplikasi dengan proteksi anti-debug (misalnya TiCo) bisa menutup sendiri saat di-stream.

### Tombol HOME lambat atau tidak merespons di dalam game

Penyebabnya fitur beta **HOME menu** / **System overlays**. Mulai 1.18.1 keduanya mati secara bawaan (overlay NXBeam dan NXBeam Update mematikannya sekali secara otomatis). Kalau Anda menyalakannya lagi dan tombol HOME jadi lambat di game tertentu (misalnya EA FC), matikan kembali lalu restart.

### Mode Jaringan: Switch di 5 GHz, PC/HP di 2,4 GHz (atau sebaliknya)

Selama keduanya tersambung ke **router yang sama**, NXBeam tetap bisa tersambung walaupun frekuensinya berbeda.

- NXBeam mencari Switch di jaringannya sendiri. Kalau tidak ketemu, pencarian diperluas ke subnet tetangga dan subnet rumahan yang umum, karena ada router yang memberi alamat berbeda untuk 2,4 GHz dan 5 GHz.
- Kalau tetap tidak ketemu, buka overlay NXBeam di Switch, lihat **Switch IP**, lalu ketik IP itu di NXBeam (PC: kolom IP di layar sambungan; Android: kolom IP Switch).
- **Switch hanya melayani satu penonton.** Kalau NXBeam di PC sedang tersambung, HP tidak bisa tersambung langsung ke Switch (muncul "tidak ada jawaban"). Tutup NXBeam di PC dulu, atau di aplikasi Android pakai bagian **NXBeam di PC** supaya HP menonton lewat PC.
- Kalau dengan IP pun tidak tersambung, router memblokir perangkat Wi-Fi untuk saling terhubung. Matikan **AP Isolation / Client Isolation / Wireless Isolation** di pengaturan router, dan jangan pakai jaringan **Tamu (Guest)**. Atau sambungkan PC ke router dengan kabel LAN.

## Update online

Mulai versi 1.18.0 semua bagian NXBeam bisa diperbarui langsung dari internet. Tidak ada yang berubah sebelum Anda menekan Update.

**Disarankan memakai versi 1.18.2 ke atas.** Di PC, notifikasi update baru tampil dengan benar mulai versi ini. Kalau masih memakai versi lama, unduh manual sekali dari halaman Releases. Setelah itu update berikutnya tinggal klik.

- **PC:** kalau ada versi baru, muncul bar di bagian atas NXBeam. Klik **Update**: NXBeam mengunduh versi baru, mencocokkan checksum, memasangnya, lalu menyala ulang sendiri. Jalankan NXBeam lewat `Start NXBeam.bat` (Windows), `Start NXBeam.command` (Mac), atau `start.sh` (Linux), karena launcher itulah yang memasang update. Tombol **x** menyembunyikan bar sampai ada versi yang lebih baru lagi. Selain bar, tombol **Settings** di menu samping diberi titik, dan **Settings > Versi & update** selalu menampilkan versi terpasang, versi terbaru, tombol **Update**, dan **Cek update**.
- **Android:** muncul kartu "NXBeam X tersedia" di layar utama aplikasi. Ketuk **Update**, APK diunduh, lalu Android menampilkan dialog pemasangan. Pertama kali, Android meminta izin "Instal aplikasi yang tidak dikenal" untuk NXBeam.
- **Switch:** buka **NXBeam Update** dari menu homebrew (Album, atau tahan R saat membuka game). Aplikasi menampilkan versi terpasang dan versi terbaru. Tekan A untuk update: paket Switch diunduh, dicocokkan checksum-nya, dipasang ke SD card **tanpa menimpa pengaturan Anda** (`config.ini`), lalu tekan A lagi untuk restart. Versi terpasang juga tampil di overlay NXBeam.

Versi 1.17.0 ke bawah belum punya fitur ini, jadi update ke 1.18.0 harus dilakukan manual sekali. Setelah itu, update berikutnya bisa langsung dari aplikasi.

## Aplikasi Android (HP dan Android TV)

`NXBeam-Android.apk` di halaman Releases bisa dipasang di HP, tablet, dan Android TV / Google TV (Android 8 ke atas). Aplikasi ini tersambung langsung ke Switch, jadi tidak perlu PC.

- **Wi-Fi**: Switch dalam mode Jaringan dan satu Wi-Fi dengan HP/TV. Switch akan muncul di daftar, tinggal pilih. Bisa juga ketik IP-nya.
- **USB OTG**: Switch dalam mode USB (handheld). Sambungkan dengan **adaptor OTG (USB-C ke USB-A female) di HP, lalu kabel USB-A ke USB-C** ke Switch, yaitu kabel yang sama seperti ke PC. Saat dicolok, Android menawarkan membuka NXBeam.
  - **Kabel USB-C ke USB-C tidak bisa.** Switch tetap menjadi host atau hanya mengisi daya HP, jadi HP tidak melihatnya. Pilihan "USB dikendalikan oleh: Perangkat ini" di Samsung dan HP lain juga gagal, karena Switch menolak tukar peran. Ujung USB-A dari adaptor OTG membuat HP pasti menjadi host.
  - Tombol **Cek USB** di aplikasi menampilkan perangkat yang dilihat HP: kosong berarti masalah kabel, `057E:xxxx` berarti NXBeam di Switch belum mode USB, `1209:5F1E` berarti siap.
- **NXBeam di PC**: ketik alamat PC yang tertulis di jendela NXBeam, misalnya `192.168.1.10:8090`.
- **Gambar**: *Tercepat* menampilkan frame begitu tiba (latensi paling rendah). *Seimbang* dan *Paling halus* menunggu beberapa frame agar gerakan rata saat Wi-Fi sibuk.
- **Rekam** menyimpan MP4 ke folder **Movies/NXBeam**, **Screenshot** ke **Pictures/NXBeam**.
- **Controller**: aktifkan *Pakai controller untuk Switch*, lalu controller yang tersambung ke HP/TV dipakai sebagai controller Switch.
- **Di TV** semua bisa dengan remote. Tekan OK untuk memunculkan tombol pemutar.
- **Memasang di Android TV**: pakai file manager atau aplikasi Downloader, atau salin APK lewat flashdisk.

## OBS

Tambahkan **Browser Source** di OBS dengan URL **`http://localhost:8090/overlay`**:

- Isinya hanya video dan suara game, tanpa tombol atau menu.
- Atur **Width 1920** dan **Height 1080**, lalu centang **Control audio via OBS** supaya suara game masuk ke OBS.
- Parameter opsional: `audio=0` (tanpa suara), `pad=1` (tampilkan juga tombol yang ditekan), `video=0&pad=1` (hanya tombol, latar transparan).

## Mencoba tanpa konsol

```bash
npm run simulate      # konsol palsu: gambar uji 720p60 + nada, mencetak input kontrol yang diterima
node tools/simulate-console.js --jitter 45   # meniru WiFi yang tersendat, untuk menguji kelancaran
node tools/simulate-console.js --audio-burst 300 --audio-drift 0.3   # meniru audio yang datang bersemburan dan clock yang meleset
npm start             # di terminal lain
```

`npm test` menjalankan self-test (parser protokol, format pesan kontrol, dan rekaman MP4 lewat ffmpeg).

## Cara kerja singkat

```
Switch (sysmodule) --TCP 9950 / USB--> NXBeam hub (Node.js) --WebSocket--> browser (WebCodecs + WebGL + Web Audio)
                                          |-- ffmpeg --> MP4 (rekaman, klip)
                                          '-- ffmpeg --> RTMP (siaran, video tanpa encode ulang)
```

- Video H.264 dari encoder hardware Switch diteruskan apa adanya. Tidak ada encode ulang di hub, sehingga CPU tetap ringan.
- Penonton baru langsung mendapat gambar dari cache GOP terakhir, tanpa menunggu keyframe berikutnya.
- Penonton yang lambat (misalnya ponsel di WiFi lemah) otomatis melompat ke keyframe berikutnya tanpa mengganggu penonton lain.
- Selama merekam atau siaran, hub meminta konsol mengunci ukuran gambar agar file tidak terpotong.

## Catatan

- **USB** (koneksi kabel, jeda paling kecil, tanpa fluktuasi WiFi):
  1. Di aplikasi Switch Frame Tap, set **Connection** ke **USB viewer**, lalu restart konsol. Konsol hanya melayani satu jenis koneksi per boot: kalau setting-nya Network, USB tidak akan mengirim apa-apa.
  2. Switch dalam **mode genggam**. Saat di dock, port USB-nya dipakai dock.
  3. Gunakan kabel USB-C yang mendukung data.
  4. **Windows:** pasang driver WinUSB sekali dengan [Zadig](https://zadig.akeo.ie/). Klik **Options** lalu **List All Devices**, kemudian pilih **NXBeam** (USB ID `1209 5F1E`; dengan paket Switch sebelum v1.15 namanya **Switch Frame Tap**), pilih WinUSB, lalu klik Install Driver.
  5. **Linux:** `sudo cp tools/70-nxbeam.rules /etc/udev/rules.d/ && sudo udevadm control --reload && sudo udevadm trigger`.
  6. Di NXBeam, pilih **Pengaturan > Koneksi > Mode: USB saja** (atau Otomatis), lalu klik Simpan. Kalau ada masalah, layar NXBeam menampilkan penyebabnya: tidak terdeteksi, driver, izin, atau sedang dipakai program lain.
- Konsol hanya melayani satu koneksi. Tutup viewer bawaan sebelum menjalankan NXBeam.
- Jalur USB sudah diuji dengan perangkat USB tiruan (`npm test`), belum dengan konsol asli. Jalur jaringan sudah diuji end-to-end dengan simulator dan konsol.

## Lisensi

NXBeam: MIT © Haris DevLab. NXBeam berkomunikasi dengan sysmodule Switch Frame Tap (GPL-2.0, © Tomas Uribe) lewat protokol jaringan/USB-nya, sebagai program terpisah. Terima kasih kepada Tomas Uribe atas sysmodule dan dokumentasi protokolnya.
