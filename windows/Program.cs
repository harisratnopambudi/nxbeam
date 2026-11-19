/*
 * NXBeam for Windows.
 *
 * A native window for the NXBeam viewer: it starts the NXBeam server (Node.js,
 * bundled in runtime\) without a console, shows the viewer in WebView2 (the
 * Edge engine built into Windows 10/11) tuned for streaming, keeps running in
 * the tray for the phones and OBS that watch through this PC, applies online
 * updates (the server exits with 75) and installs the Switch's USB driver
 * (WinUSB, through libwdi's wdi-simple, the engine of Zadig) - also before the
 * Switch was ever plugged in.
 *
 * Made by Haris DevLab.
 */
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace NXBeam
{
    static class Program
    {
        public static readonly string AppDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        public static readonly string DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NXBeam");
        public static readonly bool Indonesian = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "id";
        public static string T(string en, string id) => Indonesian ? id : en;

        public static Icon AppIcon
        {
            get
            {
                using (var s = typeof(Program).Assembly.GetManifestResourceStream("nxbeam.ico"))
                {
                    return s != null ? new Icon(s) : SystemIcons.Application;
                }
            }
        }

        public static string Arg(string[] args, string name)
        {
            int i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }

        [STAThread]
        static int Main(string[] args)
        {
            Directory.CreateDirectory(DataDir);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (args.Contains("--install-driver")) { return Driver.Install(args.Contains("--quiet")); }

            string selftest = Arg(args, "--selftest");
            bool created;
            using (var mutex = new Mutex(true, "Local\\NXBeam.App", out created))
            using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\NXBeam.App.Show"))
            {
                if (!created)
                {
                    // after an update the old copy is still closing: wait for it
                    if (args.Contains("--after-update"))
                    {
                        try { created = mutex.WaitOne(15000); } catch (AbandonedMutexException) { created = true; }
                    }
                    if (!created) { show.Set(); return 0; }
                }
                var host = new Host(selftest, args.Contains("--minimized"), show);
                Application.Run(host.Form);
                try { mutex.ReleaseMutex(); } catch { }
                return host.ExitCode;
            }
        }
    }

    /* ---- the window, the tray and the server's life ------------------------ */
    sealed class Host
    {
        public readonly Form Form;
        public int ExitCode;

        readonly WebView2 web;
        readonly NotifyIcon tray;
        readonly ToolStripMenuItem autostartItem;
        readonly Server server = new Server();
        VeyraEmbed veyra;
        readonly string selftest;
        bool webReady, webFailed, exiting, hintShown, fullscreen, openedInBrowser;
        string url;
        FormWindowState savedState;
        Rectangle savedBounds;

        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

        public Host(string selftest, bool minimized, EventWaitHandle show)
        {
            this.selftest = selftest;
            Form = new Form
            {
                Text = "NXBeam",
                Icon = Program.AppIcon,
                BackColor = Color.FromArgb(0x15, 0x1b, 0x24),
                MinimumSize = new Size(640, 400),
                StartPosition = FormStartPosition.Manual,
            };
            RestoreWindow();
            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(0x15, 0x1b, 0x24) };
            Form.Controls.Add(web);

            var menu = new ContextMenuStrip();
            menu.Items.Add(Program.T("Open NXBeam", "Buka NXBeam"), null, (s, e) => ShowWindow());
            menu.Items.Add(Program.T("Open in browser", "Buka di browser"), null, (s, e) => { if (url != null) { OpenExternal(url); } });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(Program.T("Install USB driver", "Pasang driver USB"), null, (s, e) => Driver.Install(false));
            autostartItem = new ToolStripMenuItem(Program.T("Start with Windows", "Jalan saat Windows mulai")) { Checked = Autostart };
            autostartItem.Click += (s, e) => { Autostart = !Autostart; autostartItem.Checked = Autostart; };
            menu.Items.Add(autostartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(Program.T("Exit", "Keluar"), null, (s, e) => Exit());
            tray = new NotifyIcon { Icon = Program.AppIcon, Text = "NXBeam", ContextMenuStrip = menu, Visible = selftest == null };
            tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) { ShowWindow(); } };

            Form.FormClosing += OnClosing;
            Form.Shown += (s, e) => { if (minimized) { Form.Hide(); } };
            Form.Load += (s, e) => { InitWebView(); StartServer(); };
            if (minimized) { Form.WindowState = FormWindowState.Minimized; Form.ShowInTaskbar = false; }

            // a second NXBeam.exe asks this one to come to the front
            var t = new Thread(() =>
            {
                while (true)
                {
                    show.WaitOne();
                    try { Form.BeginInvoke(new Action(ShowWindow)); } catch { return; }
                }
            }) { IsBackground = true };
            t.Start();

            server.Ready += u => Ui(() => { url = u; Navigate(); });
            server.Exited += code => Ui(() => OnServerExit(code));
            if (selftest != null) { Task.Delay(120000).ContinueWith(_ => Ui(() => FinishSelftest("timeout"))); }
        }

        void Ui(Action a) { try { if (Form.IsHandleCreated) { Form.BeginInvoke(a); } } catch (ObjectDisposedException) { } }

        /* ---- the server ---- */
        void StartServer()
        {
            try { server.Start(); }
            catch (Exception e) { ShowError(Program.T("NXBeam could not start: ", "NXBeam gagal berjalan: ") + e.Message); }
        }

        void OnServerExit(int code)
        {
            if (exiting) { return; }
            if (code == 75)
            {
                // an update was downloaded and checked: copy it in, then start again
                server.ApplyUpdate();
                if (File.Exists(Path.Combine(Program.AppDir, "NXBeam.exe.old")))
                {
                    // this program itself was updated: hand over to the new one
                    Process.Start(Path.Combine(Program.AppDir, "NXBeam.exe"), "--after-update");
                    Exit();
                    return;
                }
                url = null;
                StartServer();
                return;
            }
            // another NXBeam already serves the port (the portable one): use it
            if (code == 0 && server.Url != null) { return; }
            ShowError(Program.T("NXBeam stopped (code ", "NXBeam berhenti (kode ") + code + ").");
        }

        /* ---- the window ---- */
        static readonly string BrowserArgs = string.Join(" ", new[]
        {
            "--ignore-gpu-blocklist",              // frame generation on GPUs a browser would refuse
            "--force_high_performance_gpu",        // the discrete GPU on laptops with two
            "--enable-gpu-rasterization",
            "--enable-zero-copy",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            "--disable-features=CalculateNativeWinOcclusion",  // keep drawing behind other windows (OBS window capture)
            "--autoplay-policy=no-user-gesture-required",      // sound at once, no click first
        });

        async void InitWebView()
        {
            try
            {
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.DataDir, "WebView2"),
                    new CoreWebView2EnvironmentOptions(BrowserArgs));
                await web.EnsureCoreWebView2Async(env);
            }
            catch (Exception e)
            {
                webFailed = true;
                Server.Log("WebView2: " + e.Message);
                if (selftest != null) { FinishSelftest("webview2 failed: " + e.Message); return; }
                MessageBox.Show(Form, Program.T(
                    "The Microsoft Edge WebView2 Runtime is missing, so NXBeam opens in your browser instead.\n\nInstall it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 to use the NXBeam window.",
                    "Microsoft Edge WebView2 Runtime belum terpasang, jadi NXBeam dibuka di browser.\n\nPasang dari https://go.microsoft.com/fwlink/p/?LinkId=2124703 agar NXBeam tampil di jendelanya sendiri."),
                    "NXBeam", MessageBoxButtons.OK, MessageBoxIcon.Information);
                Form.Hide();
                Navigate();
                return;
            }
            var core = web.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDevToolsEnabled = true;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.ContainsFullScreenElementChanged += (s, e) => SetFullscreen(core.ContainsFullScreenElement);
            core.DocumentTitleChanged += (s, e) => { Form.Text = string.IsNullOrEmpty(core.DocumentTitle) || core.DocumentTitle.StartsWith("http") ? "NXBeam" : core.DocumentTitle; };
            // links to other sites (GitHub, Saweria) open in the browser
            core.NewWindowRequested += (s, e) => { e.Handled = true; OpenExternal(e.Uri); };
            core.NavigationStarting += (s, e) =>
            {
                if (url != null && !e.Uri.StartsWith(url) && !e.Uri.StartsWith("data:") && !e.Uri.StartsWith("about:"))
                {
                    e.Cancel = true;
                    OpenExternal(e.Uri);
                }
            };
            core.WebMessageReceived += (s, e) =>
            {
                string m = e.TryGetWebMessageAsString();
                if (m != null && m.StartsWith("{")) { OnPageMessage(m); return; }
                if (m == "restart") { url = null; ShowLoading(); StartServer(); }
                if (m == "log") { OpenExternal(Server.LogPath); }
                if (m == "f11") { SetFullscreen(!fullscreen); }
            };
            // F11: the whole window, as in a browser (the page tells us; WebView2 itself ignores F11)
            await core.AddScriptToExecuteOnDocumentCreatedAsync(
                "addEventListener('keydown', e => { if (e.key === 'F11') { e.preventDefault(); chrome.webview.postMessage('f11'); } }, true);");
            core.NavigationCompleted += (s, e) =>
            {
                if (selftest != null && url != null && core.Source.StartsWith(url)) { RunSelftest(); }
            };
            webReady = true;
            if (url != null) { Navigate(); } else { ShowLoading(); }
        }

        /* ---- Veyra inside the NXBeam window ---- */
        void OnPageMessage(string json)
        {
            string type = VeyraEmbed.Field(json, "type");
            if (type == "veyraRect") { veyra?.Move(VeyraEmbed.Rect(json)); return; }
            if (type != "veyra") { return; }
            if (VeyraEmbed.Field(json, "on") == "true")
            {
                veyra?.Stop();
                veyra = new VeyraEmbed(Form, state => Ui(() => ToPage("{\"type\":\"veyra\",\"state\":\"" + state.Item1 + "\",\"msg\":" + VeyraEmbed.Json(state.Item2) + "}")));
                veyra.Start(VeyraEmbed.Field(json, "url"), VeyraEmbed.Rect(json));
            }
            else { veyra?.Stop(); veyra = null; ToPage("{\"type\":\"veyra\",\"state\":\"off\",\"msg\":\"\"}"); }
        }

        void ToPage(string json) { try { web.CoreWebView2?.PostWebMessageAsString(json); } catch { } }

        void Navigate()
        {
            if (url == null) { return; }
            if (webReady) { web.CoreWebView2.Navigate(url); return; }
            if (webFailed && !openedInBrowser) { openedInBrowser = true; OpenExternal(url); }
        }

        void ShowLoading()
        {
            if (!webReady) { return; }
            web.CoreWebView2.NavigateToString(Page(Program.T("Starting NXBeam...", "Menjalankan NXBeam..."), ""));
        }

        void ShowError(string msg)
        {
            Server.Log(msg);
            if (selftest != null) { FinishSelftest(msg); return; }
            if (!webReady) { MessageBox.Show(msg + "\n\n" + Server.Tail(), "NXBeam", MessageBoxButtons.OK, MessageBoxIcon.Error); return; }
            string body = "<pre>" + WebUtility.HtmlEncode(Server.Tail()) + "</pre>" +
                "<p><button onclick=\"chrome.webview.postMessage('restart')\">" + Program.T("Try again", "Coba lagi") + "</button> " +
                "<button class=\"ghost\" onclick=\"chrome.webview.postMessage('log')\">" + Program.T("Open the log", "Buka log") + "</button></p>";
            web.CoreWebView2.NavigateToString(Page(msg, body));
            ShowWindow();
        }

        static string Page(string title, string body) =>
            "<!doctype html><html><head><meta charset=\"utf-8\"><style>" +
            "html,body{margin:0;height:100%;background:#151b24;color:#e4eaf2;font:15px 'Segoe UI',sans-serif}" +
            "main{max-width:760px;margin:0 auto;padding:12vh 32px}h1{font-size:22px;font-weight:600}" +
            "pre{background:#0e131a;border:1px solid #263142;border-radius:10px;padding:14px;white-space:pre-wrap;max-height:40vh;overflow:auto;font-size:12px;color:#aab6c6}" +
            "button{font:inherit;border:0;border-radius:10px;padding:9px 18px;background:#f2b84b;color:#151b24;font-weight:600;cursor:pointer}" +
            "button.ghost{background:#263142;color:#e4eaf2}" +
            "</style></head><body><main><h1>" + WebUtility.HtmlEncode(title) + "</h1>" + body + "</main></body></html>";

        void SetFullscreen(bool on)
        {
            if (on == fullscreen) { return; }
            fullscreen = on;
            if (on)
            {
                savedState = Form.WindowState;
                savedBounds = Form.WindowState == FormWindowState.Normal ? Form.Bounds : Form.RestoreBounds;
                Form.FormBorderStyle = FormBorderStyle.None;
                Form.WindowState = FormWindowState.Normal;
                Form.Bounds = Screen.FromControl(Form).Bounds;
            }
            else
            {
                Form.FormBorderStyle = FormBorderStyle.Sizable;
                Form.Bounds = savedBounds;
                Form.WindowState = savedState;
            }
        }

        void ShowWindow()
        {
            if (webFailed) { if (url != null) { OpenExternal(url); } return; }
            Form.ShowInTaskbar = true;
            Form.Show();
            if (Form.WindowState == FormWindowState.Minimized) { Form.WindowState = FormWindowState.Normal; }
            Form.Activate();
        }

        void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (exiting || e.CloseReason != CloseReason.UserClosing) { Shutdown(); return; }
            // the server keeps serving phones, TVs and OBS: hide to the tray
            e.Cancel = true;
            SaveWindow();
            if (fullscreen) { SetFullscreen(false); }
            Form.Hide();
            if (!hintShown)
            {
                hintShown = true;
                tray.ShowBalloonTip(4000, "NXBeam", Program.T(
                    "NXBeam keeps running here for your other devices. Right-click the icon > Exit to close it.",
                    "NXBeam tetap berjalan di sini untuk perangkat lain. Klik kanan ikon > Keluar untuk menutupnya."), ToolTipIcon.Info);
            }
        }

        void Exit()
        {
            exiting = true;
            SaveWindow();
            Form.Close();
        }

        void Shutdown()
        {
            exiting = true;
            veyra?.Stop();
            tray.Visible = false;
            server.Stop();
            tray.Dispose();
        }

        static void OpenExternal(string target)
        {
            try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); } catch { }
        }

        /* ---- start with Windows ---- */
        static bool Autostart
        {
            get { using (var k = Registry.CurrentUser.OpenSubKey(RunKey)) { return k?.GetValue("NXBeam") != null; } }
            set
            {
                using (var k = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (value) { k.SetValue("NXBeam", "\"" + Application.ExecutablePath + "\" --minimized"); }
                    else { k.DeleteValue("NXBeam", false); }
                }
            }
        }

        /* ---- window size and place, kept between runs ---- */
        static string WindowFile => Path.Combine(Program.DataDir, "window.txt");

        void RestoreWindow()
        {
            var area = Screen.PrimaryScreen.WorkingArea;
            var b = new Rectangle(area.X + area.Width / 10, area.Y + area.Height / 10, area.Width * 8 / 10, area.Height * 8 / 10);
            bool max = false;
            try
            {
                var p = File.ReadAllText(WindowFile).Split(',').Select(int.Parse).ToArray();
                var r = new Rectangle(p[0], p[1], p[2], p[3]);
                if (Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(r)) && r.Width >= 640 && r.Height >= 400) { b = r; }
                max = p[4] == 1;
            }
            catch { }
            Form.Bounds = b;
            if (max) { Form.WindowState = FormWindowState.Maximized; }
        }

        void SaveWindow()
        {
            if (fullscreen || Form.WindowState == FormWindowState.Minimized || !Form.Visible) { return; }
            var r = Form.WindowState == FormWindowState.Normal ? Form.Bounds : Form.RestoreBounds;
            try { File.WriteAllText(WindowFile, $"{r.X},{r.Y},{r.Width},{r.Height},{(Form.WindowState == FormWindowState.Maximized ? 1 : 0)}"); } catch { }
        }

        /* ---- self-test (CI): the window loads the viewer; what the page sees, and a picture ---- */
        bool selftestRan;

        async void RunSelftest()
        {
            if (selftestRan) { return; }
            selftestRan = true;
            await Task.Delay(6000);
            const string probe = @"(() => {
              const c = document.createElement('canvas'); const g = c.getContext('webgl2'); let r = '';
              if (g) { const e = g.getExtension('WEBGL_debug_renderer_info'); r = e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); }
              return { title: document.title, webgl2: !!g, renderer: r, videoDecoder: typeof VideoDecoder, ua: navigator.userAgent,
                       rail: document.querySelectorAll('.rail-btn').length, audio: (() => { try { const a = new AudioContext(); const s = a.state; a.close(); return s; } catch (x) { return 'error ' + x; } })() };
            })()";
            string json = await web.CoreWebView2.ExecuteScriptAsync(probe);
            Directory.CreateDirectory(selftest);
            File.WriteAllText(Path.Combine(selftest, "page.json"), json);
            using (var f = File.Create(Path.Combine(selftest, "window.png")))
            {
                await web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, f);
            }
            if (Environment.GetCommandLineArgs().Contains("--selftest-veyra"))
            {
                // the Veyra button, as a user presses it; then where its window ended up
                await web.CoreWebView2.ExecuteScriptAsync("document.querySelector('#btnVeyra').click()");
                for (int i = 0; i < 90 && !(veyra?.Embedded ?? false); i++) { await Task.Delay(500); }
                await Task.Delay(4000);
                File.WriteAllText(Path.Combine(selftest, "veyra.txt"), (veyra?.Describe() ?? "not started") + "\n");
                try
                {
                    var b = Form.RectangleToScreen(Form.ClientRectangle);
                    using (var bmp = new Bitmap(b.Width, b.Height))
                    {
                        using (var g = Graphics.FromImage(bmp)) { g.CopyFromScreen(b.Location, Point.Empty, b.Size); }
                        bmp.Save(Path.Combine(selftest, "veyra.png"), System.Drawing.Imaging.ImageFormat.Png);
                    }
                }
                catch (Exception e) { File.AppendAllText(Path.Combine(selftest, "veyra.txt"), "screen: " + e.Message + "\n"); }
            }
            FinishSelftest("ok");
        }

        void FinishSelftest(string result)
        {
            if (selftest == null || exiting) { return; }
            try
            {
                Directory.CreateDirectory(selftest);
                File.WriteAllText(Path.Combine(selftest, "result.txt"), result + "\nurl=" + url + "\n\n" + Server.Tail());
            }
            catch { }
            ExitCode = result == "ok" ? 0 : 1;
            Exit();
        }
    }

    /* ---- Veyra, shown inside the NXBeam window ------------------------------------
     * Veyra (https://github.com/Likely7/Veyra-NRVideo, GPL-3.0, its own program)
     * plays NXBeam's /live.mkv with its GPU frame generation and super
     * resolution. NXBeam starts it with the stream's address (veyra://play?url=)
     * and turns its window into a child of the NXBeam window, over the picture
     * area the page reports; it closes it again when switched off. */
    sealed class VeyraEmbed
    {
        const int GWL_STYLE = -16, GWL_EXSTYLE = -20;
        const long WS_CHILD = 0x40000000L, WS_POPUP = 0x80000000L, WS_CAPTION = 0x00C00000L, WS_THICKFRAME = 0x00040000L,
                   WS_SYSMENU = 0x00080000L, WS_MINIMIZEBOX = 0x00020000L, WS_MAXIMIZEBOX = 0x00010000L, WS_VISIBLE = 0x10000000L;
        const long WS_EX_APPWINDOW = 0x00040000L, WS_EX_WINDOWEDGE = 0x100L, WS_EX_CLIENTEDGE = 0x200L, WS_EX_DLGMODALFRAME = 0x1L;
        const uint SWP_NOZORDER = 0x4, SWP_FRAMECHANGED = 0x20, SWP_SHOWWINDOW = 0x40, SWP_NOACTIVATE = 0x10;
        static readonly IntPtr HWND_TOP = IntPtr.Zero;

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
        [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
        delegate bool EnumProc(IntPtr h, IntPtr l);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

        readonly Form host;
        readonly Action<Tuple<string, string>> report;
        Process proc;
        IntPtr win;
        Rectangle rect;
        bool stopping;

        public VeyraEmbed(Form host, Action<Tuple<string, string>> report) { this.host = host; this.report = report; }

        static string PathFile => Path.Combine(Program.DataDir, "veyra-path.txt");

        /* Veyra.exe: bundled, remembered, in the usual places, or picked once */
        string FindExe()
        {
            try { var p = File.ReadAllText(PathFile).Trim(); if (File.Exists(p)) { return p; } } catch { }
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            foreach (var c in new[] {
                Path.Combine(Program.AppDir, "veyra", "Veyra.exe"),
                Path.Combine(local, "Programs", "Veyra", "Veyra.exe"),
                Path.Combine(pf, "Veyra", "Veyra.exe"),
            })
            {
                if (File.Exists(c)) { return c; }
            }
            using (var d = new OpenFileDialog
            {
                Title = Program.T("Where is Veyra.exe?", "Di mana Veyra.exe?"),
                Filter = "Veyra|Veyra*.exe;veyra*.exe|Program|*.exe",
                CheckFileExists = true,
            })
            {
                if (d.ShowDialog(host) != DialogResult.OK) { return null; }
                try { File.WriteAllText(PathFile, d.FileName); } catch { }
                return d.FileName;
            }
        }

        public async void Start(string url, Rectangle area)
        {
            rect = area;
            var exe = FindExe();
            if (exe == null) { report(Tuple.Create("off", "")); return; }
            report(Tuple.Create("starting", ""));
            try
            {
                proc = Process.Start(new ProcessStartInfo(exe, "\"veyra://play?url=" + Uri.EscapeDataString(url) + "\"")
                {
                    WorkingDirectory = Path.GetDirectoryName(exe),
                    UseShellExecute = false,
                });
                proc.EnableRaisingEvents = true;
                proc.Exited += (s, e) => { if (!stopping) { report(Tuple.Create("off", "")); } };
            }
            catch (Exception e)
            {
                report(Tuple.Create("error", Program.T("Veyra could not start: ", "Veyra gagal dijalankan: ") + e.Message));
                return;
            }
            Server.Log("veyra: started " + exe);
            // its main window: the largest visible top-level window of the process (Qt makes a few)
            for (int i = 0; i < 100 && !stopping; i++)
            {
                await Task.Delay(200);
                if (proc.HasExited) { report(Tuple.Create("error", Program.T("Veyra closed right after starting.", "Veyra langsung tertutup setelah dijalankan."))); return; }
                var w = MainWindow((uint)proc.Id);
                if (w != IntPtr.Zero) { win = w; break; }
            }
            if (win == IntPtr.Zero)
            {
                if (!stopping) { report(Tuple.Create("error", Program.T("Veyra's window did not appear.", "Jendela Veyra tidak muncul."))); }
                return;
            }
            await Task.Delay(600);   // let it finish its own layout first
            Embed();
            report(Tuple.Create("on", ""));
        }

        static IntPtr MainWindow(uint pid)
        {
            IntPtr best = IntPtr.Zero;
            long bestArea = 0;
            EnumWindows((h, l) =>
            {
                GetWindowThreadProcessId(h, out uint p);
                if (p != pid || !IsWindowVisible(h) || GetWindow(h, 4 /* GW_OWNER */) != IntPtr.Zero) { return true; }
                GetWindowRect(h, out RECT r);
                long a = (long)(r.R - r.L) * (r.B - r.T);
                if (a > bestArea) { bestArea = a; best = h; }
                return true;
            }, IntPtr.Zero);
            return bestArea >= 200 * 150 ? best : IntPtr.Zero;
        }

        void Embed()
        {
            long st = GetWindowLongPtr(win, GWL_STYLE).ToInt64();
            st = (st & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)) | WS_CHILD | WS_VISIBLE;
            SetWindowLongPtr(win, GWL_STYLE, new IntPtr(st));
            long ex = GetWindowLongPtr(win, GWL_EXSTYLE).ToInt64();
            ex &= ~(WS_EX_APPWINDOW | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_DLGMODALFRAME);
            SetWindowLongPtr(win, GWL_EXSTYLE, new IntPtr(ex));
            SetParent(win, host.Handle);
            Place(SWP_FRAMECHANGED | SWP_SHOWWINDOW);
            Server.Log("veyra: embedded");
        }

        void Place(uint extra)
        {
            if (win == IntPtr.Zero || !IsWindow(win)) { return; }
            // above the WebView2 page, inside the NXBeam window
            SetWindowPos(win, HWND_TOP, rect.X, rect.Y, Math.Max(1, rect.Width), Math.Max(1, rect.Height), SWP_NOACTIVATE | extra);
        }

        public void Move(Rectangle r) { rect = r; Place(0); }

        [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
        public bool Embedded => win != IntPtr.Zero && IsWindow(win) && GetParent(win) == host.Handle;
        public string Describe()
        {
            if (win == IntPtr.Zero) { return "no window"; }
            GetWindowRect(win, out RECT r);
            return $"window={win} parentOk={Embedded} rect={r.L},{r.T},{r.R - r.L}x{r.B - r.T} target={rect}";
        }

        public void Stop()
        {
            stopping = true;
            try
            {
                if (proc != null && !proc.HasExited)
                {
                    if (win != IntPtr.Zero && IsWindow(win)) { SetParent(win, IntPtr.Zero); }
                    proc.CloseMainWindow();
                    if (!proc.WaitForExit(3000)) { proc.Kill(); }
                }
            }
            catch { }
            win = IntPtr.Zero;
        }

        /* the page's tiny JSON messages: {"type":"veyra","on":true,"url":"...","x":..,"y":..,"w":..,"h":..,"dpr":..} */
        public static string Field(string json, string name)
        {
            var m = Regex.Match(json, "\"" + name + "\"\\s*:\\s*(\"((?:[^\"\\\\]|\\\\.)*)\"|[-0-9.eE]+|true|false)");
            if (!m.Success) { return null; }
            return m.Groups[2].Success && m.Groups[1].Value.StartsWith("\"") ? Regex.Unescape(m.Groups[2].Value) : m.Groups[1].Value;
        }

        static double Num(string json, string name) =>
            double.TryParse(Field(json, name), NumberStyles.Float, CultureInfo.InvariantCulture, out double v) ? v : 0;

        public static Rectangle Rect(string json)
        {
            double d = Num(json, "dpr"); if (d <= 0) { d = 1; }
            return new Rectangle((int)Math.Round(Num(json, "x") * d), (int)Math.Round(Num(json, "y") * d),
                                 (int)Math.Round(Num(json, "w") * d), (int)Math.Round(Num(json, "h") * d));
        }

        public static string Json(string s) => "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    /* ---- the NXBeam server (Node.js) ----------------------------------------- */
    sealed class Server
    {
        public event Action<string> Ready;
        public event Action<int> Exited;
        public string Url;

        Process proc;
        bool stopping;
        static readonly object LogLock = new object();
        static readonly System.Collections.Generic.Queue<string> tail = new System.Collections.Generic.Queue<string>();
        public static readonly string LogPath = Path.Combine(Program.DataDir, "nxbeam.log");
        static readonly IntPtr Job = JobObject.Create();

        static string Node => Path.Combine(Program.AppDir, "runtime", "node.exe");

        public static void Log(string line)
        {
            if (line == null) { return; }
            lock (LogLock)
            {
                tail.Enqueue(line);
                while (tail.Count > 60) { tail.Dequeue(); }
                try { File.AppendAllText(LogPath, line + Environment.NewLine); } catch { }
            }
        }

        public static string Tail() { lock (LogLock) { return string.Join(Environment.NewLine, tail); } }

        public void Start()
        {
            Url = null;
            stopping = false;
            Cleanup();
            try { if (new FileInfo(LogPath).Length > 2_000_000) { File.Delete(LogPath); } } catch { }
            var next = Path.Combine(Program.AppDir, "runtime", "node.next.exe");
            if (File.Exists(next)) { try { File.Delete(Node); File.Move(next, Node); } catch (Exception e) { Log("node.next: " + e.Message); } }
            if (!File.Exists(Node)) { throw new FileNotFoundException(Program.T("runtime\\node.exe is missing - reinstall NXBeam.", "runtime\\node.exe tidak ada - pasang ulang NXBeam.")); }

            var psi = new ProcessStartInfo(Node, "src\\index.js --no-open")
            {
                WorkingDirectory = Program.AppDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            psi.EnvironmentVariables["NXBEAM_LAUNCHER"] = "2";   // this program applies online updates
            psi.EnvironmentVariables["NXBEAM_APP"] = "windows";
            psi.EnvironmentVariables["NXBEAM_NO_OPEN"] = "1";
            proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            proc.OutputDataReceived += (s, e) => Line(e.Data);
            proc.ErrorDataReceived += (s, e) => Line(e.Data);
            var me = proc;
            proc.Exited += (s, e) =>
            {
                int code = 0;
                try { me.WaitForExit(); code = me.ExitCode; } catch { }
                if (!stopping) { Exited?.Invoke(code); }
            };
            Log("---- " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " starting NXBeam");
            proc.Start();
            JobObject.Assign(Job, proc.Handle);   // the server (and its ffmpeg) end with this program
            try { proc.PriorityClass = ProcessPriorityClass.AboveNormal; } catch { }
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
        }

        void Line(string l)
        {
            if (l == null) { return; }
            Log(l);
            if (Url != null) { return; }
            var m = Regex.Match(l, @"http://localhost:(\d+)");
            if (m.Success) { Url = "http://localhost:" + m.Groups[1].Value + "/"; Ready?.Invoke(Url); }
        }

        /* ask the server to stop (it finishes a recording), then make sure */
        public void Stop()
        {
            stopping = true;
            if (proc == null) { return; }
            try
            {
                if (!proc.HasExited)
                {
                    proc.StandardInput.WriteLine("quit");
                    proc.StandardInput.Flush();
                    if (!proc.WaitForExit(5000)) { proc.Kill(); }
                }
            }
            catch { }
        }

        /* the launcher's job after exit code 75: copy the staged update in */
        public void ApplyUpdate()
        {
            Log("---- applying the update");
            var psi = new ProcessStartInfo(Node, "tools\\apply-update.js")
            {
                WorkingDirectory = Program.AppDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using (var p = Process.Start(psi))
            {
                Log(p.StandardOutput.ReadToEnd());
                Log(p.StandardError.ReadToEnd());
                p.WaitForExit();
            }
        }

        /* files an update replaced while they were in use */
        static void Cleanup()
        {
            try
            {
                foreach (var f in Directory.GetFiles(Program.AppDir, "*.old", SearchOption.AllDirectories)) { try { File.Delete(f); } catch { } }
            }
            catch { }
        }
    }

    /* the server and everything it starts close with this program, even if it crashes */
    static class JobObject
    {
        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters { public ulong a, b, c, d, e, f; }

        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref ExtendedLimits info, int size);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        public static IntPtr Create()
        {
            var job = CreateJobObject(IntPtr.Zero, null);
            var info = new ExtendedLimits();
            info.Basic.LimitFlags = 0x2000;   // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(ExtendedLimits)));
            return job;
        }

        public static void Assign(IntPtr job, IntPtr process) { try { AssignProcessToJobObject(job, process); } catch { } }
    }

    /* ---- the Switch's USB driver ------------------------------------------------ */
    static class Driver
    {
        /*
         * WinUSB for USB\VID_1209&PID_5F1E (the Switch with NXBeam), named
         * "NXBeam", through libwdi's wdi-simple. When the Switch is not plugged
         * in, libwdi stages the driver in Windows' driver store, and Windows
         * picks it the first time the Switch is connected.
         */
        public static int Install(bool quiet)
        {
            var exe = Path.Combine(Program.AppDir, "driver", "wdi-simple.exe");
            if (!File.Exists(exe))
            {
                MessageBox.Show(Program.T("driver\\wdi-simple.exe is missing - reinstall NXBeam.", "driver\\wdi-simple.exe tidak ada - pasang ulang NXBeam."),
                    "NXBeam", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 2;
            }
            var dest = Path.Combine(Path.GetTempPath(), "NXBeam-driver");
            var psi = new ProcessStartInfo(exe,
                "--vid 0x1209 --pid 0x5F1E --type 0 --name \"NXBeam\" --manufacturer \"Haris DevLab\" " +
                "--inf \"nxbeam.inf\" --dest \"" + dest + "\" --progressbar --timeout 120000 --log 2")
            {
                UseShellExecute = true,
                Verb = "runas",                       // installing a driver needs the administrator's yes
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Path.GetDirectoryName(exe),
            };
            int code;
            try
            {
                using (var p = Process.Start(psi)) { p.WaitForExit(); code = p.ExitCode; }
            }
            catch (Win32Exception)
            {
                MessageBox.Show(Program.T(
                    "The USB driver was not installed: Windows asked for permission and it was not given.\n\nInstall it later from the NXBeam tray icon > Install USB driver.",
                    "Driver USB tidak terpasang: Windows meminta izin dan izinnya tidak diberikan.\n\nPasang nanti dari ikon NXBeam di tray > Pasang driver USB."),
                    "NXBeam", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return 3;
            }
            if (code == 0)
            {
                if (!quiet)
                {
                    MessageBox.Show(Program.T(
                        "The USB driver is installed. Connect the Switch (USB mode) and NXBeam finds it.",
                        "Driver USB terpasang. Colok Switch (mode USB) dan NXBeam langsung menemukannya."),
                        "NXBeam", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                return 0;
            }
            MessageBox.Show(Program.T(
                "The USB driver could not be installed (code " + code + ").\n\nYou can still install it with Zadig: see the NXBeam guide.",
                "Driver USB gagal dipasang (kode " + code + ").\n\nMasih bisa dipasang dengan Zadig: lihat panduan NXBeam."),
                "NXBeam", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
