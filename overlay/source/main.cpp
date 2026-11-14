/*
 * NXBeam overlay: pick how the Switch connects to NXBeam (USB or network)
 * and restart. The streaming sysmodule reads the mode from
 * sdmc:/NXBeam/console-settings/config.ini at boot.
 */
#define TESLA_INIT_IMPL
#include <tesla.hpp>

#include <cstdio>
#include <cstring>
#include <string>
#include <sys/stat.h>

namespace {

constexpr const char *ConfigDir = "sdmc:/NXBeam/console-settings";
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

/* "usb" or "network" from the connection = ... line */
std::string CurrentMode() {
    const std::string s = ReadConfig();
    size_t pos = 0;
    while (pos < s.size()) {
        size_t end = s.find('\n', pos);
        if (end == std::string::npos) { end = s.size(); }
        std::string line = s.substr(pos, end - pos);
        pos = end + 1;
        size_t k = line.find_first_not_of(" \t");
        if (k == std::string::npos || line[k] == '#') { continue; }
        if (line.compare(k, 10, "connection") != 0) { continue; }
        size_t eq = line.find('=', k);
        if (eq == std::string::npos) { continue; }
        std::string v = line.substr(eq + 1);
        v.erase(0, v.find_first_not_of(" \t"));
        v.erase(v.find_last_not_of(" \t\r") + 1);
        return v;
    }
    return "usb";   /* the sysmodule's own default */
}

/* rewrite only the connection line, keep every other setting */
bool SetMode(const char *mode) {
    const std::string s = ReadConfig();
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
        if (k != std::string::npos && line[k] != '#' && line.compare(k, 10, "connection") == 0) {
            const bool cr = !line.empty() && line.back() == '\r';
            line = std::string("connection = ") + mode + (cr ? "\r" : "");
            done = true;
        }
        out += line;
        if (!last) { out += '\n'; }
    }
    if (!done) {
        if (!out.empty() && out.back() != '\n') { out += '\n'; }
        out += std::string("connection = ") + mode + "\n";
    }
    mkdir("sdmc:/NXBeam", 0777);
    mkdir(ConfigDir, 0777);
    FILE *f = std::fopen(ConfigPath, "wb");
    if (f == nullptr) { return false; }
    const bool ok = std::fwrite(out.data(), 1, out.size(), f) == out.size();
    std::fclose(f);
    return ok;
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

        list->addItem(new tsl::elm::CategoryHeader("Mode berlaku setelah restart"));
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

private:
    std::string saved;
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
        tsl::hlp::doWithSmSession([] { spsmInitialize(); });
    }
    void exitServices() override {
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
