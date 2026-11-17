/*
 * NXBeam overlay: pick how the Switch connects to NXBeam (USB or network)
 * and restart. The streaming sysmodule reads the mode from
 * sdmc:/NXBeam/console-settings/config.ini at boot.
 *
 * It also talks to the sysmodule's "sftap" control service (the same calls
 * as the Switch Frame Tap overlay, GPL-2.0): whether the running app is
 * streamed. The sysmodule skips an app for good when it closes itself right
 * after the stream attached (anti-debug protection, or a crash); without this
 * switch such an app, often a homebrew forwarder, never streamed again.
 */
#define TESLA_INIT_IMPL
#include <tesla.hpp>

#include <cstdio>
#include <cstring>
#include <string>
#include <sys/stat.h>

namespace {

constexpr const char *ConfigDir = "sdmc:/NXBeam/console-settings";
constexpr const char *ExcludedPath = "sdmc:/NXBeam/console-settings/excluded.txt";

/* ---- sftap: the streaming sysmodule's control service ------------------ */

struct StreamStatus {
    u32 version, state, enabled, width, height, fps_x10, game_fps_x10, sessions;
    u32 shot_enabled, shots, shot_fails, reserved;
    u64 app_tid; u32 app_excluded, reserved3;
};
static_assert(sizeof(StreamStatus) == 64);

Service g_sftap;
bool g_sftap_open = false;

/* sm defers GetService for a name nobody registered, and the overlay would
 * hang without the sysmodule: registering the name ourselves fails when it is
 * already registered, which is the answer */
bool IsServiceRunning(const char *name) {
    Handle h;
    const SmServiceName sn = smEncodeName(name);
    if (R_FAILED(smRegisterService(&h, sn, false, 1))) { return true; }
    svcCloseHandle(h);
    smUnregisterService(sn);
    return false;
}

bool SftapConnect() {
    if (g_sftap_open) { return true; }
    tsl::hlp::doWithSmSession([] {
        if (IsServiceRunning("sftap")) {
            g_sftap_open = R_SUCCEEDED(smGetService(&g_sftap, "sftap"));
        }
    });
    return g_sftap_open;
}

bool SftapStatus(StreamStatus *st) {
    if (!SftapConnect()) { return false; }
    if (R_FAILED(serviceDispatchOut(&g_sftap, 0, *st))) {
        serviceClose(&g_sftap);
        g_sftap_open = false;
        return false;
    }
    return true;
}

void SftapSetAppExcluded(u64 tid, bool excluded) {
    if (!SftapConnect()) { return; }
    const struct { u64 tid; u8 excluded; u8 pad[7]; } in = { tid, static_cast<u8>(excluded ? 1 : 0), {} };
    serviceDispatchIn(&g_sftap, 3, in);
}

/* re-reads config.ini and excluded.txt */
void SftapReload() {
    if (!SftapConnect()) { return; }
    serviceDispatch(&g_sftap, 2);
}

void SftapSetScreenOff(bool on) {
    if (!SftapConnect()) { return; }
    const u8 v = on ? 1 : 0;
    serviceDispatchIn(&g_sftap, 4, v);
}
constexpr const char *ConfigPath = "sdmc:/NXBeam/console-settings/config.ini";

/* what the pack ships, for a card that has no config.ini yet */
constexpr const char *Defaults =
    "# NXBeam - streaming settings for the Switch\n"
    "connection = network\n"
    "quality = medium\n"
    "max_resolution = 1080\n"
    "memory_boost = 1\n"
    "audio = 1\n"
    "viewer_input = 1\n"
    "screen_off = 0\n";

std::string ReadConfig() {
    FILE *f = std::fopen(ConfigPath, "rb");
    if (f == nullptr) { return Defaults; }
    std::string s;
    char buf[512];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) { s.append(buf, n); }
    std::fclose(f);
    return s;
}

/* the value of `key = value`, or def when the key is not there */
std::string GetKey(const char *key, const char *def) {
    const std::string s = ReadConfig();
    const size_t klen = std::strlen(key);
    size_t pos = 0;
    while (pos < s.size()) {
        size_t end = s.find('\n', pos);
        if (end == std::string::npos) { end = s.size(); }
        std::string line = s.substr(pos, end - pos);
        pos = end + 1;
        size_t k = line.find_first_not_of(" \t");
        if (k == std::string::npos || line[k] == '#') { continue; }
        if (line.compare(k, klen, key) != 0) { continue; }
        size_t eq = line.find('=', k);
        if (line.find_first_not_of(" \t", k + klen) != eq) { continue; }
        if (eq == std::string::npos) { continue; }
        std::string v = line.substr(eq + 1);
        v.erase(0, v.find_first_not_of(" \t"));
        v.erase(v.find_last_not_of(" \t\r") + 1);
        return v;
    }
    return def;
}

/* "usb" or "network"; the sysmodule's own default is usb */
std::string CurrentMode() { return GetKey("connection", "usb"); }

/* rewrite only the key's line, keep every other setting */
bool SetKey(const char *key, const std::string &value) {
    const std::string s = ReadConfig();
    const size_t klen = std::strlen(key);
    std::string out;
    bool done = false;
    size_t pos = 0;
    while (pos < s.size()) {
        size_t end = s.find('\n', pos);
        const bool last = end == std::string::npos;
        if (last) { end = s.size(); }
        std::string line = s.substr(pos, end - pos);
        pos = end + 1;
        size_t k = line.find_first_not_of(" \t");
        if (k != std::string::npos && line[k] != '#' && line.compare(k, klen, key) == 0 &&
            line.find_first_not_of(" \t", k + klen) == line.find('=', k)) {
            const bool cr = !line.empty() && line.back() == '\r';
            line = std::string(key) + " = " + value + (cr ? "\r" : "");
            done = true;
        }
        out += line;
        if (!last) { out += '\n'; }
    }
    if (!done) {
        if (!out.empty() && out.back() != '\n') { out += '\n'; }
        out += std::string(key) + " = " + value + "\n";
    }
    mkdir("sdmc:/NXBeam", 0777);
    mkdir(ConfigDir, 0777);
    FILE *f = std::fopen(ConfigPath, "wb");
    if (f == nullptr) { return false; }
    const bool ok = std::fwrite(out.data(), 1, out.size(), f) == out.size();
    std::fclose(f);
    return ok;
}

bool SetMode(const char *mode) { return SetKey("connection", mode); }

/* the console's address on the network, or a note when it has none */
std::string SwitchIp() {
    u32 ip = 0;
    if (R_FAILED(nifmGetCurrentIpAddress(&ip)) || ip == 0) { return "Belum tersambung"; }
    char b[24];
    std::snprintf(b, sizeof(b), "%u.%u.%u.%u", ip & 0xff, (ip >> 8) & 0xff, (ip >> 16) & 0xff, (ip >> 24) & 0xff);
    return b;
}

const char *Label(const std::string &mode) {
    return mode == "network" ? "Jaringan" : mode == "usb" ? "USB" : "Lainnya";
}

class GuiMain : public tsl::Gui {
public:
    tsl::elm::Element *createUI() override {
        auto frame = new tsl::elm::OverlayFrame("NXBeam", "Mode koneksi");
        auto list = new tsl::elm::List();

        this->saved = CurrentMode();
        this->header = new tsl::elm::CategoryHeader(std::string("Mode sekarang: ") + Label(this->saved));
        list->addItem(this->header);

        auto usb = new tsl::elm::ListItem("Mode USB");
        auto net = new tsl::elm::ListItem("Mode Jaringan");
        this->usbItem = usb;
        this->netItem = net;
        this->Mark();
        usb->setClickListener([this](u64 keys) { return this->Pick(keys, "usb"); });
        net->setClickListener([this](u64 keys) { return this->Pick(keys, "network"); });
        list->addItem(usb);
        list->addItem(net);

        /* for Network mode: the address to type in NXBeam when it does not find
         * the Switch by itself (2.4 GHz and 5 GHz on one router, broadcasts
         * dropped between them) */
        auto ipItem = new tsl::elm::ListItem("IP Switch");
        ipItem->setValue(SwitchIp(), true);
        list->addItem(ipItem);

        /* apps the sysmodule skipped (they closed right after the stream attached) */
        list->addItem(new tsl::elm::CategoryHeader("Aplikasi yang sedang jalan"));
        this->appItem = new tsl::elm::ListItem("Stream aplikasi ini");
        this->appItem->setClickListener([this](u64 keys) {
            if (!(keys & HidNpadButton_A)) { return false; }
            if (this->have && this->st.version >= 3 && this->st.app_tid != 0) {
                SftapSetAppExcluded(this->st.app_tid, this->st.app_excluded == 0);
                this->tick = 0;
            }
            return true;
        });
        list->addItem(this->appItem);
        auto reset = new tsl::elm::ListItem("Stream lagi semua app");
        reset->setClickListener([reset](u64 keys) {
            if (!(keys & HidNpadButton_A)) { return false; }
            std::remove(ExcludedPath);
            SftapReload();
            reset->setValue("Selesai");
            return true;
        });
        list->addItem(reset);

        list->addItem(new tsl::elm::CategoryHeader("Layar"));
        auto screen = new tsl::elm::ToggleListItem("Layar mati saat streaming", GetKey("screen_off", "0") == "1", "On", "Off");
        screen->setStateChangedListener([this](bool on) {
            if (!SetKey("screen_off", on ? "1" : "0")) { this->header->setText("Gagal menyimpan ke SD card"); }
            SftapSetScreenOff(on);
        });
        list->addItem(screen);

        /* the sysmodule's beta switches: everything on the console, not only the game */
        list->addItem(new tsl::elm::CategoryHeader("Tampilkan juga (beta)"));
        auto home = new tsl::elm::ToggleListItem("HOME menu", GetKey("home_menu", "0") == "1", "On", "Off");
        home->setStateChangedListener([this](bool on) {
            if (!SetKey("home_menu", on ? "1" : "0")) { this->header->setText("Gagal menyimpan ke SD card"); }
        });
        list->addItem(home);
        auto ovl = new tsl::elm::ToggleListItem("Overlay sistem", GetKey("overlays", "0") == "1", "On", "Off");
        ovl->setStateChangedListener([this](bool on) {
            if (!SetKey("overlays", on ? "1" : "0")) { this->header->setText("Gagal menyimpan ke SD card"); }
        });
        list->addItem(ovl);

        list->addItem(new tsl::elm::CategoryHeader("Perubahan berlaku setelah restart"));
        auto restart = new tsl::elm::ListItem("Restart Switch");
        restart->setClickListener([](u64 keys) {
            if (!(keys & HidNpadButton_A)) { return false; }
            spsmShutdown(true);
            return true;
        });
        list->addItem(restart);

        frame->setContent(list);
        return frame;
    }

    void update() override {
        if (this->tick-- > 0) { return; }
        this->tick = 30;
        this->have = SftapStatus(&this->st);
        if (this->appItem == nullptr) { return; }
        if (!this->have) { this->appItem->setValue("Sysmodule mati", true); }
        else if (this->st.version < 3 || this->st.app_tid == 0) { this->appItem->setValue("Tidak ada app", true); }
        else { this->appItem->setValue(this->st.app_excluded ? "Off" : "On", this->st.app_excluded != 0); }
    }

private:
    std::string saved;
    StreamStatus st = {};
    bool have = false;
    int tick = 0;
    tsl::elm::ListItem *appItem = nullptr;
    tsl::elm::CategoryHeader *header = nullptr;
    tsl::elm::ListItem *usbItem = nullptr;
    tsl::elm::ListItem *netItem = nullptr;

    void Mark() {
        this->usbItem->setValue(this->saved == "usb" ? "Aktif" : "", this->saved != "usb");
        this->netItem->setValue(this->saved == "network" ? "Aktif" : "", this->saved != "network");
    }

    bool Pick(u64 keys, const char *mode) {
        if (!(keys & HidNpadButton_A)) { return false; }
        if (SetMode(mode)) {
            this->saved = mode;
            this->header->setText(std::string("Mode tersimpan: ") + Label(this->saved) + " - restart untuk menerapkan");
        } else {
            this->header->setText("Gagal menyimpan ke SD card");
        }
        this->Mark();
        return true;
    }
};

class NXBeamOverlay : public tsl::Overlay {
public:
    void initServices() override {
        fsdevMountSdmc();
        tsl::hlp::doWithSmSession([] { spsmInitialize(); nifmInitialize(NifmServiceType_User); });
    }
    void exitServices() override {
        if (g_sftap_open) { serviceClose(&g_sftap); g_sftap_open = false; }
        nifmExit();
        spsmExit();
        fsdevUnmountDevice("sdmc");
    }
    std::unique_ptr<tsl::Gui> loadInitialGui() override {
        return initially<GuiMain>();
    }
};

}  // namespace

int main(int argc, char **argv) {
    return tsl::loop<NXBeamOverlay>(argc, argv);
}
