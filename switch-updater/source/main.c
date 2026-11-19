/*
 * NXBeam Update: brings the NXBeam files on the SD card up to the latest
 * release, from the Switch itself.
 *
 *   1. reads the installed version from sdmc:/NXBeam/versi.txt
 *   2. reads latest.json from the latest GitHub release (version, build,
 *      SHA-256 of NXBeam-Switch.zip)
 *   3. on A: downloads NXBeam-Switch.zip, checks its SHA-256, unpacks it over
 *      the SD card, keeping the user's NXBeam/console-settings/config.ini
 *   4. restarts the Switch so the new sysmodule and overlay load
 *
 * HTTPS through libcurl + mbedTLS, with the CA list in romfs.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <switch.h>
#include <curl/curl.h>
#include <zlib.h>

#define REPO      "harisratnopambudi/nxbeam"
#define LATEST    "https://github.com/" REPO "/releases/latest/download/latest.json"
#define ASSET     "NXBeam-Switch.zip"
#define VERSION_FILE "sdmc:/NXBeam/versi.txt"
#define ZIP_PATH  "sdmc:/NXBeam/update.zip"
#define KEEP_IF_PRESENT "NXBeam/console-settings/config.ini"

static PadState g_pad;

/* ------------------------------------------------------------ screen */
static void title(void) {
    consoleClear();
    printf("\x1b[1;33mNXBeam Update\x1b[0m\n");
    printf("Memperbarui file NXBeam di SD card dari GitHub.\n");
    printf("--------------------------------------------------------------------------------\n\n");
}

static void flush(void) { consoleUpdate(NULL); }

/* waits for one of the buttons; returns the one pressed */
static u64 wait_for(u64 mask) {
    while (appletMainLoop()) {
        padUpdate(&g_pad);
        u64 k = padGetButtonsDown(&g_pad) & mask;
        if (k) return k;
        consoleUpdate(NULL);
    }
    return HidNpadButton_Plus;
}

/* ------------------------------------------------------------ intro */
/*
 * A short "terminal login" before the download, for show: the login, the
 * password and the lines are typed out (about 4 s; B skips to the end). The
 * real work (HTTPS, the SHA-256 check) happens after it, as before.
 */
static int g_fast = 0;

static void pause_ms(int ms) {
    if (g_fast || ms <= 0) return;
    const u64 end = armGetSystemTick() + armNsToTicks((u64)ms * 1000000ULL);
    while (armGetSystemTick() < end) {
        padUpdate(&g_pad);
        if (padGetButtonsDown(&g_pad) & HidNpadButton_B) { g_fast = 1; return; }
        svcSleepThread(4000000);
    }
}

static void type(const char *s, int ms) {
    for (; *s; s++) { putchar(*s); flush(); pause_ms(ms); }
}

static void type_masked(const char *s, int ms) {
    for (; *s; s++) { putchar('*'); flush(); pause_ms(ms); }
}

static void step(const char *label) {
    printf("  %-34s", label);
    for (int i = 0; i < 12; i++) { putchar('.'); flush(); pause_ms(45); }
    printf(" \x1b[1;32mOK\x1b[0;32m\n"); flush();
    pause_ms(120);
}

static void intro(const char *version, int build) {
    g_fast = 0;
    printf("\x1b[2m  (B: lewati)\x1b[0m\n\n\x1b[32m");
    printf("  nxbeam@switch:~$ "); flush(); pause_ms(300);
    type("connect --release latest\n", 35);
    pause_ms(250);
    printf("  login: "); flush(); pause_ms(200);
    type("haris.devlab\n", 70);
    printf("  password: "); flush(); pause_ms(250);
    type_masked("nxbeam-update", 75);
    printf("\n\n"); flush(); pause_ms(300);
    step("Resolving github.com");
    step("Connecting to server :443");
    step("Opening secure channel (TLS)");
    step("Authenticating haris.devlab");
    printf("\n  \x1b[1;32mACCESS GRANTED\x1b[0;32m\n"); flush();
    pause_ms(600);
    printf("  Fetching NXBeam %s (build %d)...\x1b[0m\n", version, build); flush();
    pause_ms(300);
}

/* ------------------------------------------------------------ version */
typedef struct { char version[32]; int build; } Ver;

static Ver read_installed(void) {
    Ver v = { "belum diketahui", 0 };
    FILE *f = fopen(VERSION_FILE, "r");
    if (!f) return v;
    char line[64];
    if (fgets(line, sizeof line, f)) { line[strcspn(line, "\r\n")] = 0; snprintf(v.version, sizeof v.version, "%s", line); }
    if (fgets(line, sizeof line, f)) v.build = atoi(line);
    fclose(f);
    return v;
}

/* a tiny lookup in latest.json: the value after "key": */
static const char *after(const char *json, const char *from, const char *key) {
    const char *p = strstr(from ? from : json, key);
    if (!p) return NULL;
    p = strchr(p + strlen(key), ':');
    if (!p) return NULL;
    p++;
    while (*p == ' ' || *p == '"') p++;
    return p;
}

static void copy_str(char *dst, size_t n, const char *src) {
    size_t i = 0;
    while (src && src[i] && src[i] != '"' && i + 1 < n) { dst[i] = src[i]; i++; }
    dst[i] = 0;
}

/* ------------------------------------------------------------ download */
typedef struct { char *data; size_t len, cap; } Mem;

static size_t to_mem(void *p, size_t sz, size_t n, void *u) {
    Mem *m = (Mem *)u;
    size_t add = sz * n;
    if (m->len + add + 1 > m->cap) {
        size_t cap = m->cap ? m->cap : 4096;
        while (cap < m->len + add + 1) cap *= 2;
        char *d = realloc(m->data, cap);
        if (!d) return 0;
        m->data = d; m->cap = cap;
    }
    memcpy(m->data + m->len, p, add);
    m->len += add;
    m->data[m->len] = 0;
    return add;
}

static int progress_cb(void *u, curl_off_t total, curl_off_t now, curl_off_t ut, curl_off_t un) {
    (void)u; (void)ut; (void)un;
    static int last = -1;
    if (total > 0) {
        int p = (int)(now * 100 / total);
        if (p != last) { last = p; printf("\r  Mengunduh... %3d%%  (%lld KB)", p, (long long)(now / 1024)); flush(); }
    }
    return appletMainLoop() ? 0 : 1;
}

static CURLcode fetch(const char *url, Mem *out, int show_progress) {
    CURL *c = curl_easy_init();
    if (!c) return CURLE_FAILED_INIT;
    curl_easy_setopt(c, CURLOPT_URL, url);
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(c, CURLOPT_USERAGENT, "NXBeam-Update");
    curl_easy_setopt(c, CURLOPT_CAINFO, "romfs:/cacert.pem");
    curl_easy_setopt(c, CURLOPT_FAILONERROR, 1L);
    curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT, 15L);
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, to_mem);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, out);
    if (show_progress) {
        curl_easy_setopt(c, CURLOPT_NOPROGRESS, 0L);
        curl_easy_setopt(c, CURLOPT_XFERINFOFUNCTION, progress_cb);
    }
    CURLcode r = curl_easy_perform(c);
    curl_easy_cleanup(c);
    return r;
}

/* ------------------------------------------------------------ zip */
static u16 rd16(const u8 *p) { return p[0] | (p[1] << 8); }
static u32 rd32(const u8 *p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((u32)p[3] << 24); }

static void mkdirs(const char *path) {
    char tmp[512];
    snprintf(tmp, sizeof tmp, "%s", path);
    for (char *p = tmp + strlen("sdmc:/"); *p; p++) {
        if (*p == '/') { *p = 0; mkdir(tmp, 0777); *p = '/'; }
    }
}

static int file_exists(const char *path) { struct stat st; return stat(path, &st) == 0; }

/* unpacks every file of the zip under sdmc:/; returns files written or -1 */
static int unpack(const u8 *z, size_t len, int *kept) {
    size_t eocd = 0;
    for (size_t i = len - 22; i + 1 > 0 && i + 65557 >= len; i--) {
        if (rd32(z + i) == 0x06054b50) { eocd = i; break; }
        if (i == 0) break;
    }
    if (!eocd) return -1;
    u16 count = rd16(z + eocd + 10);
    size_t p = rd32(z + eocd + 16);
    int written = 0;
    for (u16 n = 0; n < count; n++) {
        if (p + 46 > len || rd32(z + p) != 0x02014b50) return -1;
        u16 method = rd16(z + p + 10);
        u32 csize = rd32(z + p + 20), size = rd32(z + p + 24);
        u16 nlen = rd16(z + p + 28), xlen = rd16(z + p + 30), clen = rd16(z + p + 32);
        u32 local = rd32(z + p + 42);
        char name[384];
        if (nlen >= sizeof name) return -1;
        memcpy(name, z + p + 46, nlen); name[nlen] = 0;
        p += 46 + nlen + xlen + clen;
        if (nlen == 0 || name[nlen - 1] == '/' || strstr(name, "..")) continue;

        char out[512];
        snprintf(out, sizeof out, "sdmc:/%s", name);
        if (strcmp(name, KEEP_IF_PRESENT) == 0 && file_exists(out)) { (*kept)++; continue; }

        size_t data = local + 30 + rd16(z + local + 26) + rd16(z + local + 28);
        if (data + csize > len) return -1;
        u8 *buf = malloc(size ? size : 1);
        if (!buf) return -1;
        if (method == 0) memcpy(buf, z + data, size);
        else if (method == 8) {
            z_stream s = {0};
            s.next_in = (Bytef *)(z + data); s.avail_in = csize;
            s.next_out = buf; s.avail_out = size;
            if (inflateInit2(&s, -MAX_WBITS) != Z_OK) { free(buf); return -1; }
            int r = inflate(&s, Z_FINISH);
            inflateEnd(&s);
            if (r != Z_STREAM_END || s.total_out != size) { free(buf); return -1; }
        } else { free(buf); return -1; }

        mkdirs(out);
        FILE *f = fopen(out, "wb");
        if (!f) { free(buf); return -1; }
        size_t w = fwrite(buf, 1, size, f);
        fclose(f);
        free(buf);
        if (w != size) return -1;
        written++;
        printf("\r  Memasang... %d file", written); flush();
    }
    return written;
}

/*
 * Settings version 2 (1.18.1): the beta HOME-menu and overlay streaming go back
 * to off once (they slowed the HOME button in some games). The user's
 * config.ini is kept by the update, so it is changed here, line by line.
 */
static void migrate_config(void) {
    const char *path = "sdmc:/" KEEP_IF_PRESENT;
    FILE *f = fopen(path, "rb");
    if (!f) return;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    if (n <= 0 || n > 65536) { fclose(f); return; }
    char *in = malloc(n + 1);
    if (!in) { fclose(f); return; }
    fread(in, 1, n, f); in[n] = 0; fclose(f);
    if (strstr(in, "config_version")) { free(in); return; }
    const int crlf = strstr(in, "\r\n") != NULL;
    char *out = malloc(n + 256);
    if (!out) { free(in); return; }
    size_t o = 0;
    for (char *line = in; *line; ) {
        char *end = strchr(line, '\n');
        size_t len = end ? (size_t)(end - line + 1) : strlen(line);
        const char *k = line; while (*k == ' ' || *k == '\t') k++;
        if (strncmp(k, "home_menu", 9) == 0 && strchr(k, '=')) o += sprintf(out + o, "home_menu = 0%s", crlf ? "\r\n" : "\n");
        else if (strncmp(k, "overlays", 8) == 0 && strchr(k, '=')) o += sprintf(out + o, "overlays = 0%s", crlf ? "\r\n" : "\n");
        else { memcpy(out + o, line, len); o += len; }
        line += len;
    }
    if (o && out[o - 1] != '\n') o += sprintf(out + o, crlf ? "\r\n" : "\n");
    o += sprintf(out + o, "config_version = 2%s", crlf ? "\r\n" : "\n");
    f = fopen(path, "wb");
    if (f) { fwrite(out, 1, o, f); fclose(f); }
    free(in); free(out);
}

/* ------------------------------------------------------------ main */
static int run(void) {
    Ver cur = read_installed();
    title();
    printf("Versi terpasang : %s", cur.version);
    if (cur.build) printf(" (build %d)", cur.build);
    printf("\nMengecek versi terbaru...\n"); flush();

    Mem j = {0};
    CURLcode r = fetch(LATEST, &j, 0);
    if (r != CURLE_OK || !j.data) {
        printf("\n\x1b[31mGagal mengecek update: %s\x1b[0m\n", curl_easy_strerror(r));
        printf("Pastikan Switch tersambung ke internet.\n\nTekan + untuk keluar.\n");
        free(j.data);
        wait_for(HidNpadButton_Plus);
        return 0;
    }
    char version[32] = {0}, sha[80] = {0};
    copy_str(version, sizeof version, after(j.data, NULL, "\"version\""));
    const char *b = after(j.data, NULL, "\"build\"");
    int build = b ? atoi(b) : 0;
    const char *asset = strstr(j.data, "\"" ASSET "\"");
    copy_str(sha, sizeof sha, asset ? after(j.data, asset, "\"sha256\"") : NULL);
    free(j.data);

    printf("Versi terbaru   : %s (build %d)\n\n", version, build);
    if (strlen(sha) != 64) {
        printf("\x1b[31mRilis terbaru tidak memuat paket Switch.\x1b[0m\n\nTekan + untuk keluar.\n");
        wait_for(HidNpadButton_Plus);
        return 0;
    }
    int newer = build > cur.build;
    if (newer) printf("\x1b[1;32mUpdate tersedia.\x1b[0m Tekan A untuk update, + untuk keluar.\n");
    else printf("NXBeam sudah versi terbaru.\nTekan Y untuk memasang ulang, + untuk keluar.\n");
    flush();
    u64 k = wait_for(HidNpadButton_Plus | (newer ? HidNpadButton_A : HidNpadButton_Y));
    if (k & HidNpadButton_Plus) return 0;

    intro(version, build);
    Mem zip = {0};
    char url[256];
    snprintf(url, sizeof url, "https://github.com/" REPO "/releases/download/v%s/" ASSET, version);
    r = fetch(url, &zip, 1);
    printf("\n");
    if (r != CURLE_OK || !zip.data) {
        printf("\x1b[31mUnduhan gagal: %s\x1b[0m\n\nTekan + untuk keluar.\n", curl_easy_strerror(r));
        free(zip.data);
        wait_for(HidNpadButton_Plus);
        return 0;
    }
    u8 hash[32];
    sha256CalculateHash(hash, zip.data, zip.len);
    char hex[65];
    for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", hash[i]);
    if (strcmp(hex, sha) != 0) {
        printf("\x1b[31mFile unduhan rusak (checksum tidak cocok). Tidak ada yang diubah.\x1b[0m\n\nTekan + untuk keluar.\n");
        free(zip.data);
        wait_for(HidNpadButton_Plus);
        return 0;
    }
    printf("  Checksum cocok.\n"); flush();

    /* the running NRO's romfs is no longer needed: let its file be replaced */
    romfsExit();
    int kept = 0;
    int n = unpack((const u8 *)zip.data, zip.len, &kept);
    free(zip.data);
    printf("\n");
    if (n < 0) {
        printf("\x1b[31mGagal memasang file. Salin NXBeam-Switch.zip versi %s ke SD card secara manual.\x1b[0m\n\nTekan + untuk keluar.\n", version);
        wait_for(HidNpadButton_Plus);
        return 0;
    }
    migrate_config();
    printf("\n\x1b[1;32mSelesai.\x1b[0m %d file diperbarui", n);
    if (kept) printf(", pengaturan Anda (config.ini) tetap");
    printf(".\n\nSwitch perlu di-restart agar versi baru aktif.\nTekan A untuk restart sekarang, + untuk keluar.\n");
    k = wait_for(HidNpadButton_A | HidNpadButton_Plus);
    if (k & HidNpadButton_A) {
        if (R_SUCCEEDED(spsmInitialize())) { spsmShutdown(true); spsmExit(); }
    }
    return 0;
}

int main(int argc, char **argv) {
    (void)argc; (void)argv;
    consoleInit(NULL);
    padConfigureInput(1, HidNpadStyleSet_NpadStandard);
    padInitializeDefault(&g_pad);
    romfsInit();
    socketInitializeDefault();
    curl_global_init(CURL_GLOBAL_DEFAULT);

    run();

    curl_global_cleanup();
    socketExit();
    romfsExit();
    consoleExit(NULL);
    return 0;
}
