/*
 * NXBeam overlay: pick how the Switch connects to NXBeam (USB or network)
 * and restart. The streaming sysmodule reads the mode from
 * sdmc:/NXBeam/console-settings/config.ini at boot.
 *
 * "Screen off while streaming" and the resolution apply at once through the
 * sysmodule's "sftap" control service (the calls the Switch Frame Tap overlay
 * makes, GPL-2.0): screen off directly, the resolution by a config reload.
 *
 * "Game display" is ReverseNX-RT (masagrator, MIT): with SaltyNX installed, the
 * running game is told it is docked or handheld, at the resolution picked here,
 * through the shared memory SaltyNX gives its plugin. The choice is saved per
 * game in sdmc:/SaltySD/plugins/ReverseNX-RT/<title id>.dat, the file
 * ReverseNX-RT itself reads, so both overlays agree.
 */
#define TESLA_INIT_IMPL
#include <tesla.hpp>

#include <cstdio>
#include <cstring>
#include <string>
#include <sys/stat.h>

/* SaltyNX's IPC, from ReverseNX-RT by masagrator (MIT, include/ReverseNX-RT-LICENSE.txt) */
#include "SaltyNX.h"

namespace {

constexpr const char *ConfigDir = "sdmc:/NXBeam/console-settings";

/* ---- sftap: the streaming sysmodule's control service ------------------ */

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

/* the sysmodule reads config.ini again; a running stream restarts with it (sftap 2) */
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

std::string ResLabel(const std::string &v) { return v == "720" ? "720p (smoothest)" : "1080p"; }

/*
 * Settings version 2 (NXBeam 1.18.1): streaming the HOME menu and the system
 * overlays is beta and slowed the HOME button in some games (EA FC): both go
 * back to off once, as in 1.14.3. Turning them on again is kept.
 */
void MigrateConfig() {
    if (GetKey("config_version", "1") >= "2") { return; }
    SetKey("home_menu", "0");
    SetKey("overlays", "0");
    SetKey("config_version", "2");
}

/* "1.17.0 (build 48)" from sdmc:/NXBeam/versi.txt, written into every Switch pack */
std::string InstalledVersion() {
    FILE *f = std::fopen("sdmc:/NXBeam/versi.txt", "r");
    if (f == nullptr) { return "-"; }
    char v[32] = {}, b[16] = {};
    if (std::fgets(v, sizeof(v), f) != nullptr) { v[std::strcspn(v, "\r\n")] = 0; }
    if (std::fgets(b, sizeof(b), f) != nullptr) { b[std::strcspn(b, "\r\n")] = 0; }
    std::fclose(f);
    std::string out = v;
    if (b[0] != 0) { out += std::string(" (build ") + b + ")"; }
    return out;
}

/* the console's address on the network, or a note when it has none */
std::string SwitchIp() {
    u32 ip = 0;
    if (R_FAILED(nifmGetCurrentIpAddress(&ip)) || ip == 0) { return "Not connected"; }
    char b[24];
    std::snprintf(b, sizeof(b), "%u.%u.%u.%u", ip & 0xff, (ip >> 8) & 0xff, (ip >> 16) & 0xff, (ip >> 24) & 0xff);
    return b;
}

const char *Label(const std::string &mode) {
    return mode == "network" ? "Network" : mode == "usb" ? "USB" : "Other";
}

/* ---- ReverseNX-RT: docked / handheld and the game's display resolution ---- */
namespace rnx {

enum ResMode : u8 { ResDefault = 0, Res480, Res540, Res630, Res720, Res810, Res900, Res1080, ResCount };
constexpr const char *ResName[] = { "Game default", "854x480", "960x540", "1120x630", "1280x720", "1440x810", "1600x900", "1920x1080" };

/* the plugin's block in SaltyNX's shared memory, "NXRT" */
struct Shared {
    uint32_t MAGIC;
    bool isDocked;
    bool def;              /* true: the system decides (no change) */
    bool pluginActive;     /* the game asked for the mode at least once */
    struct {
        u8 handheld_res: 4;
        u8 docked_res: 4;
    } NX_PACKED res;
    bool wasDDRused;       /* the game asks for the default display resolution */
} NX_PACKED;
static_assert(sizeof(Shared) == 9);

enum class State { NoSaltyNX, NoGame, NotRunning, Waiting, Ready };

bool g_salty = false;
bool g_mapped = false;
SharedMemory g_shm = {};
Shared *g_rt = nullptr;

bool PortUp() {
    Handle h;
    for (int i = 0; i < 67; i++) {
        if (R_SUCCEEDED(svcConnectToNamedPort(&h, "InjectServ"))) { svcCloseHandle(h); return true; }
        svcSleepThread(1'000'000);
    }
    return false;
}

/* with an sm session: is SaltyNX there, is a game running, is the plugin in it */
void Init() {
    g_salty = PortUp();
    if (!g_salty) { return; }
    u64 pid = 0;
    if (R_FAILED(pmdmntGetApplicationProcessId(&pid))) { return; }
    if (SaltySD_Connect()) { return; }
    Handle shm = INVALID_HANDLE;
    SaltySD_GetSharedMemoryHandle(&shm);
    SaltySD_Term();
    shmemLoadRemote(&g_shm, shm, 0x1000, Perm_Rw);
    if (R_FAILED(shmemMap(&g_shm))) { return; }
    g_mapped = true;
    const uintptr_t base = reinterpret_cast<uintptr_t>(shmemGetAddr(&g_shm));
    for (ptrdiff_t off = 0; off < 0x1000 - static_cast<ptrdiff_t>(sizeof(Shared)); off += 4) {
        if (*reinterpret_cast<uint32_t *>(base + off) == 0x5452584E) { g_rt = reinterpret_cast<Shared *>(base + off); break; }
    }
}

void Exit() {
    if (g_mapped) { shmemClose(&g_shm); g_mapped = false; }
    g_rt = nullptr;
}

State Get() {
    if (!g_salty) { return State::NoSaltyNX; }
    u64 pid = 0;
    if (R_FAILED(pmdmntGetApplicationProcessId(&pid))) { return State::NoGame; }
    if (g_rt == nullptr) { return State::NotRunning; }
    if (!g_rt->pluginActive) { return State::Waiting; }
    return State::Ready;
}

const char *StateText(State st) {
    switch (st) {
        case State::NoSaltyNX: return "Needs SaltyNX";
        case State::NoGame: return "Start a game first";
        case State::NotRunning: return "Not available in this game";
        case State::Waiting: return "The game has not asked yet";
        default: return "";
    }
}

/* the per-game file ReverseNX-RT reads at the game's start (format 2) */
bool Save() {
    u64 pid = 0, tid = 0;
    if (g_rt == nullptr || R_FAILED(pmdmntGetApplicationProcessId(&pid)) || R_FAILED(pmdmntGetProgramId(&tid, pid))) { return false; }
    mkdir("sdmc:/SaltySD", 0777);
    mkdir("sdmc:/SaltySD/plugins", 0777);
    mkdir("sdmc:/SaltySD/plugins/ReverseNX-RT", 0777);
    char path[96];
    std::snprintf(path, sizeof(path), "sdmc:/SaltySD/plugins/ReverseNX-RT/%016lX.dat", tid);
    if (g_rt->def) { remove(path); return true; }
    FILE *f = std::fopen(path, "wb");
    if (f == nullptr) { return false; }
    const u8 data[] = { 'N', 'X', 'R', 'T', 2, static_cast<u8>(g_rt->isDocked ? 1 : 0),
                        static_cast<u8>(g_rt->res.handheld_res), static_cast<u8>(g_rt->res.docked_res) };
    const bool ok = std::fwrite(data, 1, sizeof(data), f) == sizeof(data);
    std::fclose(f);
    return ok;
}

const char *ModeText() {
    if (g_rt == nullptr || g_rt->def) { return "Auto (system)"; }
    return g_rt->isDocked ? "Docked" : "Handheld";
}

}  // namespace rnx

class GuiMain : public tsl::Gui {
public:
    tsl::elm::Element *createUI() override {
        MigrateConfig();
        auto frame = new tsl::elm::OverlayFrame("NXBeam", std::string(APP_VERSION) + "  by Haris DevLab");
        auto list = new tsl::elm::List();

        this->saved = CurrentMode();
        this->header = new tsl::elm::CategoryHeader(std::string("Current mode: ") + Label(this->saved));
        list->addItem(this->header);

        auto usb = new tsl::elm::ListItem("USB mode");
        auto net = new tsl::elm::ListItem("Network mode");
        this->usbItem = usb;
        this->netItem = net;
        this->Mark();
        usb->setClickListener([this](u64 keys) { return this->Pick(keys, "usb"); });
        net->setClickListener([this](u64 keys) { return this->Pick(keys, "network"); });
        list->addItem(usb);
        list->addItem(net);

        /* for Network mode: the address to type in NXBeam when it does not find the Switch */
        auto ipItem = new tsl::elm::ListItem("Switch IP");
        ipItem->setValue(SwitchIp(), true);
        list->addItem(ipItem);

        list->addItem(new tsl::elm::CategoryHeader("Picture (applies right away)"));
        /* max_resolution: 720 keeps the copy light, steadier 60 fps; NXBeam upscales it */
        auto res = new tsl::elm::ListItem("Resolution");
        res->setValue(ResLabel(GetKey("max_resolution", "1080")));
        res->setClickListener([this, res](u64 keys) {
            if ((keys & HidNpadButton_A) == 0) { return false; }
            const std::string next = GetKey("max_resolution", "1080") == "720" ? "1080" : "720";
            if (!SetKey("max_resolution", next)) { this->header->setText("Could not save to the SD card"); return true; }
            SftapReload();
            res->setValue(ResLabel(next));
            return true;
        });
        list->addItem(res);

        auto screen = new tsl::elm::ToggleListItem("Screen off while streaming", GetKey("screen_off", "0") == "1", "On", "Off");
        screen->setStateChangedListener([this](bool on) {
            if (!SetKey("screen_off", on ? "1" : "0")) { this->header->setText("Could not save to the SD card"); }
            SftapSetScreenOff(on);
        });
        list->addItem(screen);

        /* ReverseNX-RT: the running game as if docked or handheld, at a chosen resolution */
        list->addItem(new tsl::elm::CategoryHeader("Game display (ReverseNX-RT)"));
        const rnx::State st = rnx::Get();
        if (st != rnx::State::Ready) {
            auto info = new tsl::elm::ListItem("Status");
            info->setValue(rnx::StateText(st), true);
            list->addItem(info);
        } else {
            auto mode = new tsl::elm::ListItem("Mode");
            mode->setValue(rnx::ModeText());
            list->addItem(mode);
            tsl::elm::ListItem *dres = nullptr, *hres = nullptr;
            if (rnx::g_rt->wasDDRused) {
                dres = new tsl::elm::ListItem("Docked resolution");
                hres = new tsl::elm::ListItem("Handheld resolution");
                list->addItem(dres);
                list->addItem(hres);
            }
            /* the resolutions count only when NXBeam, not the system, sets the mode */
            auto show = [dres, hres] {
                if (dres == nullptr) { return; }
                const bool on = !rnx::g_rt->def;
                dres->setValue(on ? rnx::ResName[rnx::g_rt->res.docked_res] : "Pick a mode first", !on);
                hres->setValue(on ? rnx::ResName[rnx::g_rt->res.handheld_res] : "Pick a mode first", !on);
            };
            show();
            auto saved = [this] { if (!rnx::Save()) { this->header->setText("Could not save the game setting"); } };
            mode->setClickListener([mode, show, saved](u64 keys) {
                if ((keys & HidNpadButton_A) == 0 || rnx::g_rt == nullptr) { return false; }
                /* Auto -> Docked -> Handheld -> Auto */
                if (rnx::g_rt->def) { rnx::g_rt->def = false; rnx::g_rt->isDocked = true; }
                else if (rnx::g_rt->isDocked) { rnx::g_rt->isDocked = false; }
                else { rnx::g_rt->def = true; }
                mode->setValue(rnx::ModeText());
                show();
                saved();
                return true;
            });
            if (dres != nullptr) {
                auto cycle = [show, saved](bool docked) {
                    if (rnx::g_rt == nullptr || rnx::g_rt->def) { return; }
                    if (docked) { rnx::g_rt->res.docked_res = (rnx::g_rt->res.docked_res + 1) % rnx::ResCount; }
                    else { rnx::g_rt->res.handheld_res = (rnx::g_rt->res.handheld_res + 1) % rnx::ResCount; }
                    show();
                    saved();
                };
                dres->setClickListener([cycle](u64 keys) { if ((keys & HidNpadButton_A) == 0) { return false; } cycle(true); return true; });
                hres->setClickListener([cycle](u64 keys) { if ((keys & HidNpadButton_A) == 0) { return false; } cycle(false); return true; });
            }
        }

        /* the sysmodule's beta switches: everything on the console, not only the game */
        list->addItem(new tsl::elm::CategoryHeader("Full mirroring (beta, may slow HOME)"));
        auto home = new tsl::elm::ToggleListItem("HOME menu", GetKey("home_menu", "0") == "1", "On", "Off");
        home->setStateChangedListener([this](bool on) {
            if (!SetKey("home_menu", on ? "1" : "0")) { this->header->setText("Could not save to the SD card"); }
        });
        list->addItem(home);
        auto ovl = new tsl::elm::ToggleListItem("System overlays", GetKey("overlays", "0") == "1", "On", "Off");
        ovl->setStateChangedListener([this](bool on) {
            if (!SetKey("overlays", on ? "1" : "0")) { this->header->setText("Could not save to the SD card"); }
        });
        list->addItem(ovl);

        list->addItem(new tsl::elm::CategoryHeader("Changes apply after a restart"));
        auto restart = new tsl::elm::ListItem("Restart Switch");
        restart->setClickListener([](u64 keys) {
            if (!(keys & HidNpadButton_A)) { return false; }
            spsmShutdown(true);
            return true;
        });
        list->addItem(restart);

        list->addItem(new tsl::elm::CategoryHeader("About"));
        auto ver = new tsl::elm::ListItem("Version");
        ver->setValue(InstalledVersion(), true);
        list->addItem(ver);
        auto upd = new tsl::elm::ListItem("Update");
        upd->setValue("NXBeam Update app", true);
        list->addItem(upd);
        auto by = new tsl::elm::ListItem("Made by");
        by->setValue("Haris DevLab", true);
        list->addItem(by);

        frame->setContent(list);
        return frame;
    }

private:
    std::string saved;
    tsl::elm::CategoryHeader *header = nullptr;
    tsl::elm::ListItem *usbItem = nullptr;
    tsl::elm::ListItem *netItem = nullptr;

    void Mark() {
        this->usbItem->setValue(this->saved == "usb" ? "Active" : "", this->saved != "usb");
        this->netItem->setValue(this->saved == "network" ? "Active" : "", this->saved != "network");
    }

    bool Pick(u64 keys, const char *mode) {
        if (!(keys & HidNpadButton_A)) { return false; }
        if (SetMode(mode)) {
            this->saved = mode;
            this->header->setText(std::string("Saved: ") + Label(this->saved) + " - restart to apply");
        } else {
            this->header->setText("Could not save to the SD card");
        }
        this->Mark();
        return true;
    }
};

class NXBeamOverlay : public tsl::Overlay {
public:
    void initServices() override {
        fsdevMountSdmc();
        tsl::hlp::doWithSmSession([] {
            spsmInitialize();
            nifmInitialize(NifmServiceType_User);
            pmdmntInitialize();
            rnx::Init();
        });
    }
    void exitServices() override {
        rnx::Exit();
        pmdmntExit();
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
