using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Feiyu.Desktop;

internal sealed partial class MainWindow
{
    readonly WebView2 loginWeb = new() { Dock = DockStyle.Fill };
    readonly TabControl loginViews = new() { Dock = DockStyle.Fill };
    readonly TabPage napcatTab = new("NapCat 网页");
    readonly TabPage qrTab = new("备用二维码");
    readonly Label napcatHint = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter,
        Text = "等待专用 NapCat 网页服务启动。登录状态会自动检测。" };
    Task<CoreWebView2Environment>? browserEnvironment;
    bool loginWebInitializing, loginWebReady, loginPageLoaded;
    string loginOrigin = "", attemptedLoginOrigin = "", credentialScriptId = "";

    void SetupNapCatPage(Control qrLayout)
    {
        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 44, Padding = new Padding(10, 5, 0, 0) };
        var reload = new Button { Text = "刷新 NapCat 网页", AutoSize = true };
        reload.Click += async (_, _) => await ReloadNapCatPage();
        bar.Controls.Add(reload);
        napcatTab.Controls.Add(napcatHint);
        qrTab.Controls.Add(qrLayout);
        loginViews.TabPages.AddRange([napcatTab, qrTab]);
        loginTab.Controls.Add(loginViews); loginTab.Controls.Add(bar); loginTab.Controls.Add(loginText);
        tabs.SelectedIndexChanged += async (_, _) => { if (tabs.SelectedTab == loginTab) await EnsureNapCatPage(); };
    }

    async Task ReloadNapCatPage()
    {
        if (busy || stopping || loginWebInitializing) return;
        await RefreshState();
        attemptedLoginOrigin = "";
        await EnsureNapCatPage();
    }

    Task<CoreWebView2Environment> BrowserEnvironment()
    {
        var profile = Path.Combine(appRoot, "webview", Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(project)))[..20]);
        return browserEnvironment ??= CoreWebView2Environment.CreateAsync(null, profile);
    }

    void TrackBrowser(CoreWebView2 core)
    {
        // Both controls share the same environment/profile and browser process.
        if (browserPid != 0) return;
        using var browser = Process.GetProcessById((int)core.BrowserProcessId);
        browserPid = browser.Id; browserCreated = browser.StartTime.ToUniversalTime().Ticks; browserPath = browser.MainModule?.FileName ?? "";
        try { webJob.Attach(browser); }
        catch (System.ComponentModel.Win32Exception ex) { RecordDiagnostic("webview-receipt-fallback", "runtime-job-error=" + ex.NativeErrorCode); }
    }

    bool IsNapCatUri(string address)
    {
        return loginOrigin.Length > 0 && Uri.TryCreate(address, UriKind.Absolute, out var uri)
            && uri.GetLeftPart(UriPartial.Authority) == loginOrigin
            && uri.Scheme == "http" && uri.Host == "127.0.0.1" && string.IsNullOrEmpty(uri.UserInfo);
    }

    void UpdateNapCatPage(JsonElement status, JsonElement login)
    {
        string origin = Flag(status, "managed") && !Flag(status, "needsTakeover") ? Field(login, "webOrigin") : "";
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri) || uri.Scheme != "http" || uri.Host != "127.0.0.1"
            || uri.AbsolutePath != "/" || uri.Query.Length > 0 || uri.Fragment.Length > 0 || uri.UserInfo.Length > 0) origin = "";
        if (loginOrigin != origin)
        {
            loginOrigin = origin; attemptedLoginOrigin = ""; loginPageLoaded = false;
            if (loginWebReady) loginWeb.CoreWebView2.Navigate("about:blank");
            napcatHint.Text = "等待专用 NapCat 网页服务启动；也可查看备用二维码。"; napcatHint.BringToFront();
        }
        if (!stopping && tabs.SelectedTab == loginTab) _ = EnsureNapCatPage();
    }

    async Task EnsureNapCatPage()
    {
        if (stopping || loginWebInitializing || loginOrigin.Length == 0 || attemptedLoginOrigin == loginOrigin) return;
        string origin = loginOrigin;
        loginWebInitializing = true; attemptedLoginOrigin = origin;
        try
        {
            // The controller verifies the listener belongs to the dedicated QQ.
            // Only an authenticated session credential enters this private pipe;
            // no raw WebUI token is placed in URLs, status snapshots or logs.
            var access = await Control("LoginWeb");
            if (stopping || origin != loginOrigin || Field(access, "origin") != origin) { attemptedLoginOrigin = ""; return; }
            if (!loginWebReady)
            {
                napcatTab.Controls.Add(loginWeb); loginWeb.CreateControl();
                await loginWeb.EnsureCoreWebView2Async(await BrowserEnvironment());
                TrackBrowser(loginWeb.CoreWebView2);
                var core = loginWeb.CoreWebView2;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.AreHostObjectsAllowed = false;
                core.Settings.IsWebMessageEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsPasswordAutosaveEnabled = false;
                core.Settings.IsGeneralAutofillEnabled = false;
                core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
                core.NavigationStarting += (_, e) => { if (e.Uri != "about:blank" && !IsNapCatUri(e.Uri)) e.Cancel = true; };
                core.NewWindowRequested += (_, e) => e.Handled = true;
                core.DownloadStarting += (_, e) => e.Cancel = true;
                core.NavigationCompleted += (_, e) => {
                    loginPageLoaded = e.IsSuccess && e.HttpStatusCode is >= 200 and < 400 && IsNapCatUri(core.Source);
                    if (loginPageLoaded && credentialScriptId.Length > 0)
                    {
                        core.RemoveScriptToExecuteOnDocumentCreated(credentialScriptId); credentialScriptId = "";
                    }
                    if (loginPageLoaded) loginWeb.BringToFront();
                    else if (core.Source != "about:blank") {
                        napcatHint.Text = $"NapCat 网页加载失败（HTTP {e.HttpStatusCode}，{e.WebErrorStatus}）。请刷新网页或使用备用二维码。";
                        napcatHint.BringToFront();
                        RecordDiagnostic("napcat-webview-navigation", $"http={e.HttpStatusCode} error={e.WebErrorStatus}");
                    }
                };
                loginWebReady = true;
            }
            if (stopping || origin != loginOrigin) { attemptedLoginOrigin = ""; return; }
            var view = loginWeb.CoreWebView2;
            if (credentialScriptId.Length > 0) { view.RemoveScriptToExecuteOnDocumentCreated(credentialScriptId); credentialScriptId = ""; }
            string credential = Field(access, "credential");
            if (credential.Length > 0)
            {
                // Guard every document/frame by origin. The credential never
                // reaches the bot management page, a redirect or an external URL.
                string script = "if(location.origin===" + JsonSerializer.Serialize(origin) + "){localStorage.setItem('token',JSON.stringify(" + JsonSerializer.Serialize(credential) + "));}";
                credentialScriptId = await view.AddScriptToExecuteOnDocumentCreatedAsync(script);
            }
            // NapCat serves the SPA at /webui/. Its client router then selects
            // QQ login or the dashboard. Root /qq_login returns HTTP 404; deep
            // /webui/qq_login is also broken in some installed shell builds.
            // Always load the real HTML entry, including on explicit refresh.
            view.Navigate(origin + "/webui/");
            loginWeb.BringToFront();
        }
        catch
        {
            napcatHint.Text = "NapCat 网页暂时无法打开，请刷新网页或使用备用二维码。"; napcatHint.BringToFront();
            RecordDiagnostic("napcat-webview-failed", "local-page-unavailable");
        }
        finally { loginWebInitializing = false; }
    }
}
