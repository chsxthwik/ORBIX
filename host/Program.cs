// ORBIX native Windows host: a small WinForms window that embeds WebView2 and shows the
// ORBIX UI served by the local Node server (src/main.mjs). No browser window, no browser profile.
//
// Written for the C# 5 compiler that ships with Windows (no build tools needed): see tools/build-host.ps1, which also
// stamps the version from package.json.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: System.Reflection.AssemblyTitle("ORBIX")]
[assembly: System.Reflection.AssemblyProduct("ORBIX")]
[assembly: System.Reflection.AssemblyDescription("ORBIX - Unified ADE")]

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        string sfx = InstanceSuffix(args);
        bool first;
        using (var mutex = new Mutex(true, "ORBIX.SingleInstance" + sfx, out first))
        {
            if (!first)
            {
                // Another window already exists: ask it to come to the front and exit.
                try { EventWaitHandle.OpenExisting("ORBIX.Activate" + sfx).Set(); } catch { }
                return 0;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm(args));
            return 0;
        }
    }

    /// <summary>
    /// --offscreen starts an invisible, independent instance (for automated testing); it never touches a real window.
    /// Each data folder (ORBIX_DATA) gets its own offscreen instance, so parallel test runs do not meet.
    /// </summary>
    public static string InstanceSuffix(string[] args)
    {
        if (Array.IndexOf(args, "--offscreen") < 0) return "";
        var data = (Environment.GetEnvironmentVariable("ORBIX_DATA") ?? "").ToLowerInvariant();
        uint h = 2166136261;
        foreach (char c in data) { h ^= c; h *= 16777619; }
        return ".offscreen." + h.ToString("x8");
    }
}

class MainForm : Form
{
    const string AppTitle = "ORBIX - Unified ADE";

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    [StructLayout(LayoutKind.Sequential)]
    struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
    [DllImport("user32.dll")]
    static extern bool FlashWindowEx(ref FLASHWINFO info);

    readonly string root;
    readonly bool debug;
    readonly bool offscreen;
    readonly string sfx;
    readonly Label status = new Label();
    readonly PictureBox logo = new PictureBox();
    readonly System.Windows.Forms.Timer dots = new System.Windows.Forms.Timer();
    int dotCount;
    readonly WebView2 web = new WebView2();
    Process server;
    readonly StringBuilder serverErr = new StringBuilder();
    string origin = "";
    EventWaitHandle activate;
    System.Threading.Timer watch;
    int pingFailures;
    volatile bool closing, lostShown;

    public MainForm(string[] args)
    {
        debug = Array.IndexOf(args, "--devtools") >= 0;
        offscreen = Array.IndexOf(args, "--offscreen") >= 0;
        sfx = Program.InstanceSuffix(args);
        root = FindRoot();
        Text = AppTitle;
        BackColor = Color.FromArgb(13, 14, 16);
        ForeColor = Color.FromArgb(176, 182, 190);
        MinimumSize = new Size(720, 480);
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1440, 920);
        if (offscreen) { StartPosition = FormStartPosition.Manual; Location = new Point(-32000, -32000); ShowInTaskbar = false; }
        try
        {
            var ico = Path.Combine(root, "assets", "icon.ico");
            Icon = File.Exists(ico) ? new Icon(ico) : Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch { try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { } }

        // Splash: logo + animated "Starting…" until the page is ready.
        logo.Size = new Size(96, 96);
        logo.SizeMode = PictureBoxSizeMode.Zoom;
        logo.BackColor = Color.Transparent;
        try { logo.Image = Image.FromFile(Path.Combine(root, "assets", "icon.png")); } catch { }
        status.AutoSize = false;
        status.TextAlign = ContentAlignment.MiddleCenter;
        status.Font = new Font("Segoe UI", 11f);
        status.Size = new Size(320, 28);
        status.Text = "Starting ORBIX";
        Controls.Add(logo);
        Controls.Add(status);
        Resize += delegate { CenterSplash(); };
        CenterSplash();
        dots.Interval = 380;
        dots.Tick += delegate { dotCount = (dotCount + 1) % 4; status.Text = "Starting ORBIX" + new string('.', dotCount); };
        dots.Start();

        web.Dock = DockStyle.Fill;
        web.Visible = false;
        web.DefaultBackgroundColor = Color.FromArgb(13, 14, 16);
        Controls.Add(web);

        activate = new EventWaitHandle(false, EventResetMode.AutoReset, "ORBIX.Activate" + sfx);
        var t = new Thread(delegate ()
        {
            while (activate.WaitOne()) { try { BeginInvoke(new Action(Bring)); } catch { return; } }
        });
        t.IsBackground = true;
        t.Start();

        Load += delegate { Boot(); };
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try
        {
            int dark = 1; // match the dark UI: dark title bar (Windows 10 20H1+ / 11)
            DwmSetWindowAttribute(Handle, 20, ref dark, 4);
        }
        catch { }
    }

    void CenterSplash()
    {
        int cx = ClientSize.Width / 2, cy = ClientSize.Height / 2;
        logo.Location = new Point(cx - logo.Width / 2, cy - logo.Height - 6);
        status.Location = new Point(cx - status.Width / 2, cy + 14);
    }

    void Flash()
    {
        if (ActiveForm == this || !IsHandleCreated) return;
        var f = new FLASHWINFO();
        f.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO));
        f.hwnd = Handle;
        f.dwFlags = 3 | 12; // flash caption + taskbar until the window comes to the foreground
        f.uCount = 5;
        FlashWindowEx(ref f);
    }

    void Bring()
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
        TopMost = true; TopMost = false;
    }

    static string FindRoot()
    {
        var d = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
        for (int i = 0; i < 4 && d != null; i++, d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "src", "main.mjs"))) return d.FullName;
        return AppDomain.CurrentDomain.BaseDirectory;
    }

    string FindNode()
    {
        // A release ships its own Node runtime next to the app; a developer checkout uses the installed one.
        var bundled = Path.Combine(root, "runtime", "node.exe");
        if (File.Exists(bundled)) return bundled;
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            try { var p = Path.Combine(dir.Trim().Trim('"'), "node.exe"); if (File.Exists(p)) return p; } catch { }
        }
        var pf = Environment.GetEnvironmentVariable("ProgramFiles") ?? @"C:\Program Files";
        var guess = Path.Combine(pf, "nodejs", "node.exe");
        return File.Exists(guess) ? guess : null;
    }

    void Fail(string message)
    {
        MessageBox.Show(this, message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
        Close();
    }

    /// <summary>Starts (or attaches to) the Node server and returns its handshake lines.</summary>
    bool StartServer(out string url, out string data, out string error)
    {
        url = null; data = null; error = null;
        var node = FindNode();
        if (node == null) { error = "Node.js 20 or newer is required.\r\nInstall it from https://nodejs.org and start ORBIX again."; return false; }
        var entry = Path.Combine(root, "src", "main.mjs");
        if (!File.Exists(entry)) { error = "Cannot find src\\main.mjs next to the app:\r\n" + root; return false; }

        // --watch-stdin: the server keeps running while this window lives; when our end of its stdin closes
        // (window closed, crashed or killed) it finishes running work and exits.
        var psi = new ProcessStartInfo(node, "\"" + entry + "\" --serve --watch-stdin");
        psi.WorkingDirectory = root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        if (server != null) { try { server.Dispose(); } catch { } } // the previous server process, after a restart
        server = Process.Start(psi);
        var err = serverErr;
        lock (err) err.Clear();
        server.ErrorDataReceived += delegate (object s, DataReceivedEventArgs a) { if (a.Data != null) lock (err) { err.AppendLine(a.Data); if (err.Length > 8000) err.Remove(0, err.Length - 8000); } };
        server.BeginErrorReadLine();

        var deadline = DateTime.UtcNow.AddSeconds(45);
        string u = null, d = null;
        var done = new ManualResetEvent(false);
        server.OutputDataReceived += delegate (object s, DataReceivedEventArgs a)
        {
            if (a.Data == null) { done.Set(); return; }
            if (a.Data.StartsWith("ORBIX-URL ")) u = a.Data.Substring(9).Trim();
            else if (a.Data.StartsWith("ORBIX-DATA ")) d = a.Data.Substring(10).Trim();
            if (u != null && d != null) done.Set();
        };
        server.BeginOutputReadLine();
        done.WaitOne(deadline - DateTime.UtcNow > TimeSpan.Zero ? deadline - DateTime.UtcNow : TimeSpan.Zero);
        if (u == null)
        {
            try { if (!server.HasExited) server.Kill(); } catch { }
            lock (err) error = "The ORBIX server did not start.\r\n\r\n" + err.ToString().Trim();
            return false;
        }
        url = u; data = d ?? "";
        return true;
    }

    async void Boot()
    {
        try
        {
            // Start WebView2 and the Node server at the same time: whichever is slower sets the startup time.
            var dataGuess = Environment.GetEnvironmentVariable("ORBIX_DATA");
            if (string.IsNullOrEmpty(dataGuess)) dataGuess = Path.Combine(root, "data");
            var envTask = CoreWebView2Environment.CreateAsync(null, Path.Combine(dataGuess, "webview"));
            var serverTask = Task.Run(delegate ()
            {
                string u, d, e;
                bool ok = StartServer(out u, out d, out e);
                return new string[] { ok ? u : null, d, e };
            });
            var res = await serverTask;
            if (res[0] == null) { Fail(res[2]); return; }
            string url = res[0];
            var uri = new Uri(url);
            origin = uri.GetLeftPart(UriPartial.Authority);

            var env = await envTask;
            await web.EnsureCoreWebView2Async(env);
            var core = web.CoreWebView2;

            var s = core.Settings;
            s.AreDevToolsEnabled = debug;
            s.AreBrowserAcceleratorKeysEnabled = debug;
            s.IsStatusBarEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            s.IsSwipeNavigationEnabled = false;
            s.IsBuiltInErrorPageEnabled = false;
            core.NewWindowRequested += delegate (object o, CoreWebView2NewWindowRequestedEventArgs a)
            {
                a.Handled = true;
                OpenExternal(a.Uri);
            };
            core.NavigationStarting += delegate (object o, CoreWebView2NavigationStartingEventArgs a)
            {
                // The window only shows our own pages; any other link opens in the default browser (http/https only).
                if (!a.Uri.StartsWith(origin + "/", StringComparison.OrdinalIgnoreCase) && a.Uri != origin && !a.Uri.Equals("about:blank", StringComparison.OrdinalIgnoreCase))
                {
                    a.Cancel = true;
                    OpenExternal(a.Uri);
                }
            };
            core.PermissionRequested += delegate (object o, CoreWebView2PermissionRequestedEventArgs a)
            {
                // Only our own origin may read the clipboard and show notifications; everything else keeps the default.
                if ((a.PermissionKind == CoreWebView2PermissionKind.ClipboardRead || a.PermissionKind == CoreWebView2PermissionKind.Notifications) && (a.Uri.StartsWith(origin + "/", StringComparison.OrdinalIgnoreCase) || a.Uri.Equals(origin, StringComparison.OrdinalIgnoreCase)))
                    a.State = CoreWebView2PermissionState.Allow;
            };
            core.WebMessageReceived += delegate (object o, CoreWebView2WebMessageReceivedEventArgs a)
            {
                string m = null;
                try { m = a.TryGetWebMessageAsString(); } catch { }
                if (m == "quit") Close();
                else if (m == "attention") Flash();
            };
            core.ProcessFailed += delegate { try { core.Reload(); } catch { } };

            web.Visible = true;
            dots.Stop();
            status.Visible = false;
            logo.Visible = false;
            core.Navigate(url);
            StartWatch();
        }
        catch (Exception ex)
        {
            var hint = ex is WebView2RuntimeNotFoundException
                ? "The Microsoft Edge WebView2 Runtime is missing.\r\nInstall it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and start ORBIX again."
                : ex.Message;
            Fail(hint);
        }
    }

    /// <summary>Pings the server every few seconds; if it stops answering, say so instead of showing a dead page.</summary>
    void StartWatch()
    {
        if (watch != null) return;
        watch = new System.Threading.Timer(delegate
        {
            if (closing || lostShown) return;
            bool ok = false;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(origin + "/api/ping");
                req.Timeout = 3000;
                req.ReadWriteTimeout = 3000;
                req.Proxy = null;
                req.KeepAlive = false;
                using (var r = (HttpWebResponse)req.GetResponse()) ok = r.StatusCode == HttpStatusCode.OK;
            }
            catch { }
            if (ok) { pingFailures = 0; return; }
            if (++pingFailures < 3 || closing) return;
            lostShown = true;
            try { BeginInvoke(new Action(ServerLost)); } catch { }
        }, null, 4000, 4000);
    }

    void ServerLost()
    {
        if (closing) return;
        string tail;
        lock (serverErr) tail = serverErr.ToString().Trim();
        if (tail.Length > 600) tail = "..." + tail.Substring(tail.Length - 600);
        var msg = "The ORBIX background server stopped, so this window cannot work any more. Running agents were stopped."
            + (tail.Length > 0 ? "\r\n\r\nLast server output:\r\n" + tail : "")
            + "\r\n\r\nRestart the server now?";
        if (MessageBox.Show(this, msg, AppTitle, MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes) Restart();
        else Close();
    }

    async void Restart()
    {
        web.Visible = false;
        logo.Visible = true;
        status.Visible = true;
        dots.Start();
        var res = await Task.Run(delegate ()
        {
            string u, d, e;
            bool ok = StartServer(out u, out d, out e);
            return new string[] { ok ? u : null, d, e };
        });
        if (closing) return;
        if (res[0] == null) { Fail(res[2]); return; }
        origin = new Uri(res[0]).GetLeftPart(UriPartial.Authority);
        pingFailures = 0;
        lostShown = false;
        web.Visible = true;
        dots.Stop();
        status.Visible = false;
        logo.Visible = false;
        try { web.CoreWebView2.Navigate(res[0]); } catch (Exception ex) { Fail(ex.Message); }
    }

    static void OpenExternal(string url)
    {
        // Only web links, handed to the default browser via the shell (no arguments are interpreted).
        if (url == null || !(url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))) return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        base.OnFormClosing(e);
        if (e.Cancel) return;
        closing = true;
        try { if (watch != null) watch.Dispose(); } catch { }
        try
        {
            // Release the page. Our end of the server's stdin closes with this process, and the server then exits
            // as soon as no agent is working.
            if (web != null && !web.IsDisposed) web.Dispose();
        }
        catch { }
    }
}
