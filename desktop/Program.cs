using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Feiyu.Desktop;

internal static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var userRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FeiyuBot");
        Directory.CreateDirectory(userRoot);
        string? project = null;
        for (int i = 0; i + 1 < args.Length; i++) if (args[i] == "--project") project = args[i + 1];
        var preferences = Path.Combine(userRoot, "desktop.json");
        try { project ??= JsonDocument.Parse(File.ReadAllText(preferences)).RootElement.GetProperty("projectRoot").GetString(); } catch { }
        if (project is null || !File.Exists(Path.Combine(project, "src", "main.js")))
        {
            using var picker = new FolderBrowserDialog { Description = "选择已有肥鱼项目目录（包含 src/main.js）。密钥和记忆保留在原目录。", UseDescriptionForTitle = true };
            if (picker.ShowDialog() != DialogResult.OK) return;
            project = picker.SelectedPath;
        }
        project = Path.GetFullPath(project).TrimEnd(Path.DirectorySeparatorChar);
        if (!File.Exists(Path.Combine(project, "src", "main.js"))) { MessageBox.Show("此目录没有肥鱼运行文件。", "肥鱼"); return; }
        File.WriteAllText(preferences, JsonSerializer.Serialize(new { projectRoot = project }));
        string identity = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(project.ToLowerInvariant())))[..20];
        using var mutex = new Mutex(false, @"Local\FeiyuBot-Desktop-" + identity);
        bool owns;
        try { owns = mutex.WaitOne(0); } catch (AbandonedMutexException) { owns = true; }
        if (!owns) { MessageBox.Show("此项目的肥鱼窗口已经打开，请使用已有窗口。", "肥鱼"); return; }
        bool fixtureMode = args.Contains("--verify-fixture")
            && System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(project), "^desktop-acceptance-[a-f0-9]{32}$")
            && File.Exists(Path.Combine(project, ".local", "desktop-fixture.marker"))
            && File.ReadAllText(Path.Combine(project, ".local", "desktop-fixture.marker")) == "feiyu-desktop-isolated-v1"
            && (!Directory.Exists(Path.Combine(project, ".local", "napcat"))
                || File.Exists(Path.Combine(project,".local","napcat","bot-workdir","fixture.marker")) && File.ReadAllText(Path.Combine(project,".local","napcat","bot-workdir","fixture.marker"))=="fake-napcat-only");
        if (args.Contains("--verify-fixture") && !fixtureMode) { MessageBox.Show("隔离验收目录验证失败。"); return; }
        try { Application.Run(new MainWindow(project, userRoot, fixtureMode, !args.Contains("--no-start"))); }
        catch (Exception ex) { MessageBox.Show("桌面窗口出现错误：" + ex.Message + "\n若已启动服务，请重新打开程序并接管后停止。", "肥鱼", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        finally { mutex.ReleaseMutex(); }
    }
}

internal sealed partial class MainWindow : Form
{
    readonly string project, appRoot, controlScript;
    readonly Label headline = new() { AutoSize = false, Dock = DockStyle.Top, Height = 64, Padding = new Padding(18, 12, 10, 0) };
    readonly Label footer = new() { Dock = DockStyle.Bottom, Height = 52, Padding = new Padding(16, 7, 10, 0) };
    readonly DataGridView grid = new() { Dock = DockStyle.Fill, ReadOnly = true, AllowUserToAddRows = false, AllowUserToDeleteRows = false, AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCells, RowHeadersVisible = false, BackgroundColor = Color.White, BorderStyle = BorderStyle.None, SelectionMode = DataGridViewSelectionMode.FullRowSelect };
    readonly TabControl tabs = new() { Dock = DockStyle.Fill };
    readonly TabPage panelTab = new("管理面板");
    readonly TabPage loginTab = new("QQ 登录");
    readonly PictureBox loginQr = new() { SizeMode = PictureBoxSizeMode.Zoom, BackColor = Color.White, Width = 340, Height = 340, Anchor = AnchorStyles.Top };
    readonly Label loginText = new() { AutoSize = false, Height = 100, Dock = DockStyle.Top, Padding = new Padding(20), TextAlign = ContentAlignment.MiddleCenter };
    readonly WebView2 web = new() { Dock = DockStyle.Fill };
    readonly Label panelHint = new() { Text = "启动并接管本项目服务后，管理面板会在这里打开。无需外部浏览器。", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter };
    readonly FlowLayoutPanel buttons = new() { Dock = DockStyle.Top, Height = 56, Padding = new Padding(12, 8, 8, 0) };
    Button takeoverButton = null!;
    readonly FlowLayoutPanel troubleshooting = new() { AutoSize=true, Visible=false, WrapContents=false };
    readonly System.Windows.Forms.Timer poll = new() { Interval = 5000 };
    readonly ProcessJob job = new();
    readonly ProcessJob webJob = new();
    JsonElement? snapshot;
    bool busy, stopping, allowClose, webReady, webInitializing, firstRun = true;
    string loadedOrigin = "";
    readonly List<Stream> responseStreams = [];
    readonly HashSet<int> receiptFallback = [];
    readonly bool fixtureMode;
    readonly System.Windows.Forms.Timer fixtureTimer = new() { Interval = 400 };
    int fixtureSequence;
    bool fixtureCancel;
    int browserPid;
    long browserCreated;
    string browserPath = "";
    bool controllerJobFallback;
    bool startupActive, loginShown, dashboardShown, lastReady;
    long qrVersion;

    public MainWindow(string project, string appRoot, bool fixtureMode = false, bool autoStart = true)
    {
        this.project = project; this.appRoot = appRoot; this.fixtureMode = fixtureMode;
        Text = "肥鱼 · 桌面控制台 0.2.10"; MinimumSize = new Size(1000, 700); Size = new Size(1320, 900); StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 10); BackColor = Color.FromArgb(244, 247, 250);
        var assembly = Assembly.GetExecutingAssembly();
        using (var resource = assembly.GetManifestResourceStream("desktop.control.ps1")!)
        using (var reader = new StreamReader(resource))
        {
            var source = reader.ReadToEnd();
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(source)))[..16];
            var folder = Path.Combine(appRoot, "host", "0.2.10-" + hash); Directory.CreateDirectory(folder);
            controlScript = Path.Combine(folder, "control.ps1");
            File.WriteAllText(controlScript, source, new UTF8Encoding(true)); // PowerShell 5.1 Chinese requires BOM.
        }
        AddButton("启动服务", "Start"); takeoverButton=AddButton("接管旧服务", "Takeover");takeoverButton.Visible=false; AddButton("显示 QQ 登录", "ShowLogin");
        AddButton("重启 bot", "RestartBot"); AddButton("重启专用 QQ", "RestartQQ"); AddButton("停止全部后台", "Stop");
        var troubleshootingToggle = new Button { Text="故障排查 ▸", AutoSize=true };
        troubleshootingToggle.Click += (_,_)=>{troubleshooting.Visible=!troubleshooting.Visible;troubleshootingToggle.Text=troubleshooting.Visible?"故障排查 ▾":"故障排查 ▸";};
        buttons.AutoSize=true;buttons.WrapContents=true;buttons.Controls.Add(troubleshootingToggle);
        foreach(var item in new[]{("刷新状态","Status"),("刷新面板","RefreshPanel"),("手工接管","Takeover")}){var recovery=AddButton(item.Item1,item.Item2);buttons.Controls.Remove(recovery);troubleshooting.Controls.Add(recovery);}
        buttons.Controls.Add(troubleshooting);
        var statusTab = new TabPage("启动与状态") { Padding = new Padding(14) };
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "component", HeaderText = "服务", Width = 205 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "state", HeaderText = "当前状态", Width = 380 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "next", HeaderText = "下一步", AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill });
        grid.DefaultCellStyle.WrapMode = DataGridViewTriState.True; grid.DefaultCellStyle.Padding = new Padding(7);
        statusTab.Controls.Add(grid); panelTab.Controls.Add(panelHint);
        var info = new TabPage("依赖与版本");
        var about = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, BackColor = Color.White, Font = Font, Text =
            "肥鱼桌面原型 0.2.10（Windows x64）\r\n\r\n" +
            "内置：桌面启动/退出控制、现有 HTML/CSS/JS 管理前端、WebView2 SDK、.NET 运行时。\r\n" +
            "外置：Node.js 20.9+、项目 src 和 node_modules、专用 NapCat/QQ、可选 Python/ASR/ffmpeg 及浏览器会话。\r\n" +
            "本机依赖不会因打开窗口自动下载安装。WebView2 Runtime 使用系统已有安装。\r\n\r\n" +
            "项目目录：" + project + "\r\n桌面数据：" + appRoot + "\r\n" +
            "密钥 .env、群配置与记忆 data、NapCat 登录态 .local 保持在选定项目的本机目录；不嵌入或复制到 EXE/分发包。\r\n\r\n" +
            "关闭主窗口＝停止本窗口创建或明确接管的后台。没有托盘后台模式。\r\n" +
            "接管前不会停止旧服务；接管会停用此项目旧的登录启动动作，并记录 PID、创建时间和专用路径。\r\n" +
            "新 Node 先通过本机专用管道优雅退出；超时后只停止已登记且再次核实归属的进程。\r\n" +
            "专用 QQ 需要登录时显示可交互窗口。用户其他 QQ 和共享浏览器不归本程序管理。\r\n\r\n" +
            "首次接管旧 Node 后，点击“重启 bot”加载健康上报与退出管道。\r\n" +
            "源码版本、健康快照与 OneBot 授权会话分别核实；不会把进程存在当成登录或收发成功。\r\n\r\n" +
            "同样源码与固定依赖可重复构建；版本、前端摘要和文件 SHA256 见分发包 build-manifest.json。\r\n" };
        var qrLayout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(20) };
        var refreshQr = new Button { Text = "刷新登录二维码", AutoSize = true };
        refreshQr.Click += async (_, _) => await Execute("RefreshLogin");
        qrLayout.Controls.Add(loginQr); qrLayout.Controls.Add(refreshQr);
        SetupNapCatPage(qrLayout);
        info.Controls.Add(about); tabs.TabPages.AddRange([statusTab, loginTab, panelTab, info]);
        Controls.Add(tabs); Controls.Add(buttons); Controls.Add(headline); Controls.Add(footer);
        headline.Text = "正在读取本机状态；尚未启动或接管后台。";
        footer.Text = "关窗会先停止已管理后台，停止失败时保留窗口。外部现有服务需明确接管。";
        Shown += async (_, _) => { await RefreshState(); poll.Start(); if (autoStart) await Execute("Start"); };
        KeyPreview = true;
        KeyDown += async (_, e) => { if (e.KeyCode == Keys.F5 || (e.Control && e.KeyCode == Keys.R)) { e.Handled = true; e.SuppressKeyPress = true; if (tabs.SelectedTab == loginTab) await ReloadNapCatPage(); else await ReloadPanel(); } };
        poll.Tick += async (_, _) => { if (!busy && !stopping) await RefreshState(); };
        tabs.SelectedIndexChanged += (_, _) => { if (tabs.SelectedTab == panelTab && snapshot is { } value && Flag(value,"panelReady") && Flag(value,"managed") && !Flag(value,"needsTakeover")) _ = EnsurePanel(Field(value,"panelUrl")); };
        FormClosing += OnClosing;
        FormClosed += (_, _) => { fixtureTimer.Dispose(); poll.Dispose(); loginWeb.Dispose(); web.Dispose(); foreach (var stream in responseStreams) stream.Dispose(); webJob.Dispose(); job.Dispose(); };
        if (fixtureMode)
        {
            Text += " · 隔离验收";
            fixtureTimer.Tick += (_, _) => {
                if (stopping) return;
                try
                {
                    var command = JsonDocument.Parse(File.ReadAllText(Path.Combine(project, ".local", "desktop-host-command.json"))).RootElement;
                    int sequence = command.GetProperty("sequence").GetInt32(); if (sequence <= fixtureSequence) return;
                    if (Field(command, "action") == "start")
                    {
                        if (busy) return;
                        fixtureSequence = sequence; _ = Execute("Start"); return;
                    }
                    fixtureSequence = sequence; fixtureCancel = Field(command, "decision") == "cancel";
                    Close(); // Executes the same FormClosing path as the title-bar close button.
                }
                catch (IOException) { } catch (JsonException) { }
            };
            fixtureTimer.Start();
        }
    }

    Button AddButton(string text, string action)
    {
        var button = new Button { Text = text, AutoSize = true, Height = 34, Margin = new Padding(0, 0, 8, 0) };
        button.Click += async (_, _) => await Execute(action); buttons.Controls.Add(button);return button;
    }
    static bool Flag(JsonElement? value, string name) => value is { } x && x.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.True;
    static int Count(JsonElement? value, string name) => value is { } x && x.TryGetProperty(name, out var property) && property.TryGetInt32(out var number) ? number : 0;
    static string Field(JsonElement value, string name) => value.TryGetProperty(name, out var property) ? property.ToString() : "";
    async Task<JsonElement> Control(string action)
    {
        var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"System32\WindowsPowerShell\v1.0\powershell.exe"))
        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = false, StandardOutputEncoding = Encoding.UTF8, WorkingDirectory = project };
        foreach (var argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", controlScript, "-ProjectRoot", project, "-Action", action, "-OwnerPid", Environment.ProcessId.ToString() }) start.ArgumentList.Add(argument);
        using var child = Process.Start(start) ?? throw new InvalidOperationException("无法启动本机控制器。");
        // The script parses and inventories before spawning; its children inherit
        // our job, including short-lived bootstrap descendants missed by polling.
        try { job.Attach(child); }
        catch (System.ComponentModel.Win32Exception ex)
        {
            // Some launch hosts impose an incompatible outer job. The awaited
            // controller still records PID/time/path for every created service;
            // never skip shutdown merely because kernel job attachment failed.
            if (!controllerJobFallback) RecordDiagnostic("controller-receipt-fallback", "job-error=" + ex.NativeErrorCode);
            controllerJobFallback = true;
        }
        using var drain = new CancellationTokenSource();
        // A spawned native child can inherit a duplicate pipe handle. Waiting for
        // EOF would then hang until the bot itself stops. Read the one JSON line,
        // and wait for the controller PID, never for descendant-owned pipe EOF.
        var outputTask = child.StandardOutput.ReadLineAsync(drain.Token).AsTask();
        await child.WaitForExitAsync();
        var output = await outputTask.WaitAsync(TimeSpan.FromSeconds(5)) ?? "";
        drain.Cancel();
        try
        {
            var value = JsonDocument.Parse(output.Trim()).RootElement.Clone();
            if (!Flag(value, "ok")) throw new InvalidOperationException(Field(value, "error"));
            return value;
        }
        catch (JsonException) { throw new InvalidOperationException("本机控制器未返回有效状态。请查看桌面本地日志，窗口不会自动关闭。"); }
    }
    async Task RefreshState()
    {
        if (busy) return; busy = true;
        try { Apply(await Control(startupActive ? "Advance" : "Status")); }
        catch (Exception ex) { headline.Text = "状态读取失败：" + ex.Message; RecordDiagnostic("status-failed", ex.Message); }
        finally { busy = false; }
    }
    void Apply(JsonElement value)
    {
        snapshot = value; takeoverButton.Visible=Flag(value,"needsTakeover");grid.Rows.Clear();
        if (value.TryGetProperty("ownedProcesses", out var receipts)) foreach (var receipt in receipts.EnumerateArray())
        {
            try
            {
                using var process = Process.GetProcessById(receipt.GetProperty("pid").GetInt32());
                if (process.HasExited) continue;
                long created = long.Parse(Field(receipt, "created"));
                if (Math.Abs(process.StartTime.ToUniversalTime().Ticks - created) > TimeSpan.TicksPerMillisecond
                    || !string.Equals(process.MainModule?.FileName, Field(receipt, "path"), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("进程身份已变化，尚未建立退出保护。");
                try { job.Attach(process); }
                catch (System.ComponentModel.Win32Exception ex)
                {
                    // A legacy process can belong to an incompatible existing
                    // job. Keep its verified receipt; normal exit must still
                    // stop and verify it, never silently abandon it.
                    if (receiptFallback.Add(process.Id)) RecordDiagnostic("legacy-receipt-fallback", "pid=" + process.Id + " existing-job-error=" + ex.NativeErrorCode);
                }
            }
            catch (ArgumentException) { /* Already exited between receipt and attachment. */ }
        }
        foreach (var row in value.GetProperty("rows").EnumerateArray()) grid.Rows.Add(Field(row, "name"), Translate(Field(row, "status")), Field(row, "next"));
        if ((receiptFallback.Count > 0 || controllerJobFallback) && Count(value, "ownedCount") > 0) grid.Rows.Add("进程退出保护", "外层任务限制 Job 保护，已保留身份回执", "退出时按 PID、创建时间、路径停止并核实归零");
        string phase = value.TryGetProperty("startup",out var startup) ? Field(startup,"phase") : "starting-node";
        headline.Text = Flag(value,"needsTakeover") ? "发现旧版后台 · 接管后程序将自动完成启动" : Flag(value,"managed") ? StartupText(phase) : "后台尚未启动或已停止";
        footer.Text = "已管理进程 " + Count(value, "ownedCount") + " 个；未接管项目进程 " + Count(value, "externalCount") + " 个。关闭窗口会停止已管理后台。";
        UpdateLogin(value, phase);
        bool panelUsable=Flag(value,"panelReady") && Flag(value,"managed") && !Flag(value,"needsTakeover");
        if (!stopping && panelUsable && (Flag(value,"coreReady") || tabs.SelectedTab == panelTab)) _ = EnsurePanel(Field(value,"panelUrl"));
        else if (!panelUsable && webReady && loadedOrigin.Length > 0) { web.CoreWebView2.Navigate("about:blank"); loadedOrigin=""; }
        if (!stopping && Flag(value,"coreReady") && !dashboardShown) {dashboardShown=true;tabs.SelectedTab=panelTab;}
        if (fixtureMode && Flag(value,"coreReady") && !lastReady) FixtureReceipt("startup-ready");
        lastReady=Flag(value,"coreReady");
        if (firstRun) { firstRun = false; if (Flag(value, "needsTakeover")) tabs.SelectedIndex = 0; }
    }
    static string StartupText(string phase) => phase switch {
        "ready" => "启动完成 · QQ 已登录，OneBot 授权连接已建立",
        "waiting-qr" => "等待 QQ 扫码 · 请在“QQ 登录”扫描二维码，手机确认后会自动继续",
        "waiting-phone-confirmation" => "二维码已扫描 · 请在手机 QQ 确认登录，无需再次启动",
        "initializing-qq" => "手机授权已受理 · QQ 正在初始化，程序会自动等待",
        "waiting-onebot" => "QQ 已登录 · 正在等待 OneBot 实际连接，不需要再次点启动",
        "refreshing-qr" => "登录二维码正在更新 · 程序会自动显示新二维码",
        "login-error" => "QQ 登录尚未完成 · 请查看“QQ 登录”的下一步提示",
        "initializing-node" => "后台正在初始化 · 正在等待本机 API 和新鲜健康回执",
        "starting-napcat" => "正在准备专用 NapCat 登录入口 · 等待登录服务启动",
        _ => "正在启动本机后台服务…" };
    void UpdateLogin(JsonElement value,string phase)
    {
        if (!value.TryGetProperty("login",out var login)) return;
        loginText.Text=StartupText(phase)+"\nNapCat 网页与备用二维码均在本机显示；登录和 OneBot 连接持续独立检测。";
        string error=Field(login,"error");
        if(error=="webui-2fa") loginText.Text="请在下方 NapCat 网页完成 WebUI 二次验证；程序继续独立检测 OneBot 连接。";
        else if(error=="webui-auth") loginText.Text="专用 NapCat 登录接口鉴权未完成，请检查本机 WebUI 配置；程序不会显示密钥。";
        else if(error=="qq-login-error") loginText.Text="QQ 登录未成功。请检查手机上的确认提示，或刷新二维码重新扫描；不需要再次启动 bot。";
        bool fresh=Flag(login,"qrFresh") && !Flag(value,"coreReady") && !Flag(login,"isLogin");
        string path=Field(login,"qrPath");
        var expected=Path.GetFullPath(Path.Combine(project,".local","napcat","bot-workdir","cache","qrcode.png"));
        if(fresh && string.Equals(Path.GetFullPath(path),expected,StringComparison.OrdinalIgnoreCase))
        {
            try {
                long stamp=File.GetLastWriteTimeUtc(path).Ticks;
                if(stamp!=qrVersion){using var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite);if(stream.Length>2*1024*1024)throw new IOException();using var source=Image.FromStream(stream);var old=loginQr.Image;loginQr.Image=new Bitmap(source);old?.Dispose();qrVersion=stamp;}
            }catch(IOException){}catch(ArgumentException){}
        }
        else {var old=loginQr.Image;loginQr.Image=null;old?.Dispose();qrVersion=0;}
        if(!stopping && Flag(value,"managed") && !Flag(value,"coreReady") && !loginShown && (fresh || Flag(login,"available"))){loginShown=true;tabs.SelectedTab=loginTab;}
        UpdateNapCatPage(value, login);
        try {
            string identity=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(project.ToLowerInvariant())))[..20].ToLowerInvariant();
            string folder=Path.Combine(appRoot,"projects",identity);Directory.CreateDirectory(folder);
            File.WriteAllText(Path.Combine(folder,"desktop-ui-status.json"),JsonSerializer.Serialize(new {version="0.2.10",phase,ready=Flag(value,"coreReady"),qrDisplayed=loginQr.Image is not null && tabs.SelectedTab==loginTab && loginViews.SelectedTab==qrTab,napcatPageLoaded=loginPageLoaded,ownedCount=Count(value,"ownedCount"),at=DateTimeOffset.UtcNow}));
        }catch{}
    }
    static string Translate(string state) => state switch {
        "starting" => "初始化中", "ready" => "可用", "listening" => "正在监听", "waiting-qq" => "等待 QQ 连接",
        "started-unverified" => "调度已初始化，执行效果未验收", "configured-unverified" => "配置存在，外部可用性未探测",
        "disabled" => "未启用", "missing-dependency" => "缺少配置或本地依赖", "failed" => "异常", "stopped" => "已停止", _ => state };
    async Task Execute(string action)
    {
        if (busy || stopping) return;
        if(action=="ShowLogin"){tabs.SelectedTab=loginTab;loginShown=true;await RefreshState();return;}
        if(action=="RefreshPanel"){await ReloadPanel();return;}
        if (action == "Takeover" && MessageBox.Show(this,
            "将接管此项目现有 Node、supervisor、专用 NapCat/QQ，并停用本项目旧版开机动作。\n接管后关闭此窗口会停止它们。其他 QQ 不受影响。\n\n旧进程接管后请点击“重启 bot”加载当前代码。确认接管？",
            "确认接管与退出语义", MessageBoxButtons.OKCancel, MessageBoxIcon.Information, MessageBoxDefaultButton.Button2) != DialogResult.OK) return;
        if (action is "RestartQQ" or "RestartBot" or "Stop" && MessageBox.Show(this,
            action == "RestartQQ" ? "仅重启已接管的专用 QQ/NapCat；需要时请在显示的窗口完成登录。" : action == "RestartBot" ? "仅重启已管理的 bot 与辅助进程，专用 QQ 登录保持不动。正在处理的请求可能中断。" : "停止本窗口管理的全部后台，管理页面将断开。",
            "确认操作", MessageBoxButtons.OKCancel, MessageBoxIcon.Information, MessageBoxDefaultButton.Button2) != DialogResult.OK) return;
        busy = true; buttons.Enabled = false; headline.Text = "正在执行：" + action + "，请稍候…";
        try {
            if(action=="Start") {
                _ = CoreWebView2Environment.GetAvailableBrowserVersionString();
                var result=await Control("Preflight");
                if(Flag(result,"needsTakeover")){
                    if(!fixtureMode && MessageBox.Show(this,"启动需要接管本项目现有后台；关闭本窗口时会停止它们。不会处理其他 QQ。是否继续？","接管并自动完成启动",MessageBoxButtons.OKCancel,MessageBoxIcon.Information,MessageBoxDefaultButton.Button1)!=DialogResult.OK){Apply(result);return;}
                    result=await Control("Takeover");
                }
                if(result.GetProperty("workers").GetArrayLength()>0 && !Flag(result,"runtimeCurrent")) await Control("RestartBot");
                Apply(await Control("Start"));startupActive=true;dashboardShown=false;loginShown=false;
            }else {
                if(action=="Stop")startupActive=false;
                var result=await Control(action);if(action=="Stop")await job.StopRemaining();Apply(result);
            }
            if(fixtureMode) FixtureReceipt("operation-complete");
        }
        catch (Exception ex) { headline.Text = "操作未完成：" + ex.Message; if (fixtureMode) FixtureReceipt("operation-failed", error: ex.Message); else MessageBox.Show(this, ex.Message, "肥鱼 · 操作未完成", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        finally { busy = false; buttons.Enabled = true; }
    }
    // The management page is served from EXE resources, so a browser-level reload
    // alone can leave the panel on stale markup. This rebuilds the snapshot the panel
    // gates on and forces a fresh navigation from about:blank.
    async Task ReloadPanel()
    {
        await RefreshState();
        if (snapshot is not { } status || !Flag(status, "panelReady") || !Flag(status, "managed") || Flag(status, "needsTakeover"))
        { headline.Text = "管理面板尚未就绪：请先点击“启动服务”。"; return; }
        string origin = Field(status, "panelUrl");
        if (origin.Length == 0) return;
        tabs.SelectedTab = panelTab;
        if (webReady && web.CoreWebView2 is not null)
        {
            loadedOrigin = "";
            web.CoreWebView2.Navigate("about:blank");
        }
        await EnsurePanel(origin);
    }
    async Task EnsurePanel(string origin)
    {
        if (webInitializing || loadedOrigin == origin) return;
        webInitializing = true;
        try
        {
            if (!webReady)
            {
                tabs.SelectedTab = panelTab;
                panelTab.Controls.Add(web); web.BringToFront();
                web.CreateControl();
                var environment = await BrowserEnvironment();
                await web.EnsureCoreWebView2Async(environment);
                TrackBrowser(web.CoreWebView2);
                web.CoreWebView2.Settings.AreDevToolsEnabled = false;
                web.CoreWebView2.Settings.AreHostObjectsAllowed = false;
                web.CoreWebView2.Settings.IsWebMessageEnabled = false;
                web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                web.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = true;
                web.CoreWebView2.PermissionRequested += (_, args) => args.State = CoreWebView2PermissionState.Deny;
                web.CoreWebView2.NavigationStarting += (_, args) => {
                    if (args.Uri == "about:blank") return;
                    if (!IsPanelUri(args.Uri)) args.Cancel = true;
                };
                web.CoreWebView2.NewWindowRequested += (_, args) => { args.Handled = true; MessageBox.Show(this, "来源链接：\n" + args.Uri + "\n\n此桌面窗口只承载本机管理页。可复制来源地址另行查看。", "外部来源"); };
                web.CoreWebView2.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
                web.CoreWebView2.WebResourceRequested += (_, args) => {
                    if (!IsPanelUri(args.Request.Uri)) return;
                    var uri = new Uri(args.Request.Uri);
                    var asset = uri.AbsolutePath switch { "/" or "/index.html" => ("index.html", "text/html"), "/app.js" => ("app.js", "text/javascript"), "/styles.css" => ("styles.css", "text/css"), _ => ("", "") };
                    if (asset.Item1.Length == 0 || args.Request.Method != "GET") return;
                    var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("frontend." + asset.Item1)!;
                    responseStreams.Add(stream);
                    args.Response = environment.CreateWebResourceResponse(stream, 200, "OK", "Content-Type: " + asset.Item2 + "; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
                };
                webReady = true;
                RecordDiagnostic("webview-initialized", "ok");
            }
            loadedOrigin = origin; web.CoreWebView2.Navigate(origin + "#access");
        }
        catch (Exception ex) { panelHint.Text = "内置网页初始化失败，请检查 WebView2 Runtime。\n" + ex.Message; panelHint.BringToFront(); RecordDiagnostic("webview-failed", ex.Message); }
        finally { webInitializing = false; }
    }
    bool IsPanelUri(string value)
    {
        if (snapshot is not { } status || !Flag(status, "panelReady") || !Flag(status, "managed") || Flag(status, "needsTakeover")) return false;
        return Uri.TryCreate(value, UriKind.Absolute, out var uri) && Uri.TryCreate(Field(status, "panelUrl"), UriKind.Absolute, out var panel)
            && uri.Scheme == "http" && uri.Host == "127.0.0.1" && uri.Port == panel.Port;
    }
    void RecordDiagnostic(string stage, string message)
    {
        try
        {
            var file = Path.Combine(appRoot, "desktop-host.log");
            if (File.Exists(file) && new FileInfo(file).Length > 256 * 1024) File.WriteAllText(file, "");
            File.AppendAllText(file, DateTimeOffset.UtcNow.ToString("o") + " " + stage + " " + message.Replace('\n', ' ').Replace('\r', ' ') + Environment.NewLine);
        }
        catch { }
    }
    async void OnClosing(object? sender, FormClosingEventArgs args)
    {
        if (allowClose) return;
        args.Cancel = true;
        if (stopping) return;
        stopping = true; poll.Stop(); buttons.Enabled = false; headline.Text = "正在核实并停止所管理的全部后台，完成前窗口会保留…";
        try
        {
            for (int i = 0; loginWebInitializing && i < 600; i++) await Task.Delay(100);
            if (loginWebInitializing) throw new InvalidOperationException("NapCat 网页仍在初始化，请稍后重试退出。");
            for (int i = 0; busy && i < 600; i++) await Task.Delay(100);
            if (busy) throw new InvalidOperationException("当前后台操作尚未结束，请稍后重试退出。");
            var current = await Control("Status"); Apply(current);
            if (ExitPolicy.Next(Flag(current, "needsTakeover"), Flag(current, "managed"), Count(current, "ownedCount"), Flag(current, "portsReleased")) == ExitStep.AskTakeoverAndStop)
            {
                var choice = fixtureMode ? (fixtureCancel ? DialogResult.Cancel : DialogResult.OK) : MessageBox.Show(this,
                    "发现仍在运行的本项目旧版后台。关闭程序前需要接管并停止它们，不能把后台留在运行。\n\n“确定”：接管并停止（同时停用本项目旧版登录启动动作）。\n“取消”：留在程序中，不改变现有服务。\n\n只处理已核实的本项目进程，不处理其他 QQ。",
                    "接管并停止 / 留在程序中", MessageBoxButtons.OKCancel, MessageBoxIcon.Question, MessageBoxDefaultButton.Button1);
                if (choice != DialogResult.OK) { FixtureReceipt("cancelled-unowned-close"); stopping = false; buttons.Enabled = true; poll.Start(); return; }
                current = await Control("Takeover"); Apply(current);
                if (Flag(current, "needsTakeover")) throw new InvalidOperationException("仍有无法接管的项目服务，请核实归属后重试。");
            }
            var exitStep = ExitPolicy.Next(Flag(current, "needsTakeover"), Flag(current, "managed"), Count(current, "ownedCount"), Flag(current, "portsReleased"));
            if (exitStep == ExitStep.StopOwned)
            {
                var result = await Control("Stop"); Apply(result);
                if (!Flag(result, "stopped") || !Flag(result, "portsReleased")) throw new InvalidOperationException("仍有后台或端口未释放。");
            }
            else if (exitStep == ExitStep.BlockUnknownPort) throw new InvalidOperationException("目标端口被未核实归属的进程占用。没有终止它，请先处理占用后重试。");
            await job.StopRemaining();
            if (webReady) { web.Dispose(); webReady = false; loadedOrigin = ""; }
            loginWeb.Dispose();
            await StopWebView();
            await webJob.StopRemaining();
            FixtureReceipt("closed-all-owned", job.ActiveCount, webJob.ActiveCount);
            allowClose = true; Close();
        }
        catch (Exception ex)
        {
            stopping = false; buttons.Enabled = true; poll.Start();
            headline.Text = "后台停止失败，窗口已保留：" + ex.Message;
            if (fixtureMode) FixtureReceipt("close-failed", error: ex.Message);
            else MessageBox.Show(this, "没有退出程序。\n" + ex.Message + "\n\n请检查状态后点击“停止全部后台”重试。", "退出未完成", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
    void FixtureReceipt(string stage, uint remaining = 0, uint browserRemaining = 0, string? error = null)
    {
        if (fixtureMode) File.WriteAllText(Path.Combine(project, ".local", "desktop-host-receipt.json"), JsonSerializer.Serialize(new { stage, remaining, browserRemaining, error, sequence = fixtureSequence }));
    }
    async Task StopWebView()
    {
        if (browserPid == 0) return;
        try
        {
            using var browser = Process.GetProcessById(browserPid);
            if (browser.HasExited) return;
            if (browser.StartTime.ToUniversalTime().Ticks != browserCreated || !string.Equals(browser.MainModule?.FileName, browserPath, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("内置网页进程身份变化，无法核实退出。");
            for (int i = 0; i < 30 && !browser.HasExited; i++) await Task.Delay(100);
            if (!browser.HasExited) browser.Kill(entireProcessTree: true);
            await browser.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch (ArgumentException) { /* Already exited. */ }
    }
}
