import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const imagegenProxyUrl = (() => {
  const value = process.env.BROWSER_CONTROL_PROXY_URL || "http://127.0.0.1:3456";
  try { const url = new URL(value); if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash) return url.origin; } catch {}
  return "http://127.0.0.1:3456";
})();
const checker = join(homedir(), ".codex", "skills", "web-access", "scripts", "check-deps.mjs");
let ensuring, checkerChild;

export async function browserRuntimeHealth({ proxy = imagegenProxyUrl, fetcher = fetch } = {}) {
  try {
    const response = await fetcher(proxy + "/health", { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { connected: false, state: "proxy-unavailable" };
    const data = await response.json();
    return { connected: data.connected === true, browser: data.browser?.label ?? null, state: data.connected === true ? "connected" : "browser-disconnected" };
  } catch { return { connected: false, state: "proxy-unavailable" }; }
}

function bootstrapBrowserRuntime() {
  if (!existsSync(checker)) return Promise.resolve(false);
  return new Promise(resolve => {
    const child = spawn(process.execPath, [checker], { windowsHide: true, stdio: "ignore", shell: false });
    checkerChild = child; let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); if (checkerChild === child) checkerChild = null; resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(false); }, 30_000);
    child.once("error", () => finish(false)); child.once("close", code => finish(code === 0));
  });
}

export async function ensureBrowserRuntime({ health = browserRuntimeHealth, bootstrap = bootstrapBrowserRuntime } = {}) {
  const state = await health(); if (state.connected) return state;
  // Concurrent startup and image requests share one reconnect/bootstrap attempt.
  if (!ensuring) ensuring = (async () => { await bootstrap(); return health(); })().finally(() => { ensuring = null; });
  return ensuring;
}

export function stopBrowserRuntimeBootstrap() { checkerChild?.kill(); checkerChild = null; }

// Both the older ProseMirror composer and the current role=textbox composer are
// supported. A hidden or disabled editor is not evidence that the page is ready.
export const chatGptPageProbe = `JSON.stringify((()=>{
  const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
  const composer=[...document.querySelectorAll('#prompt-textarea,[contenteditable="true"][role="textbox"],textarea[aria-label*="ChatGPT"],textarea[aria-label*="聊天"]')].some(e=>visible(e)&&!e.disabled&&!e.readOnly&&(e.isContentEditable||e.tagName==='TEXTAREA'));
  const login=[...document.querySelectorAll('button,a')].some(e=>visible(e)&&/^(Log in|Sign in|登录|登入)$/.test(e.textContent.trim()));
  return {composer,login};
})())`;

export async function inspectChatGptPage({ proxy = imagegenProxyUrl, fetcher = fetch } = {}) {
  try {
    const response = await fetcher(proxy + "/targets", { signal: AbortSignal.timeout(3000) }); const value = await response.json();
    const tabs = Array.isArray(value) ? value : value.targets ?? [];
    const tab = tabs.find(t => { try { return new URL(t.url).hostname === "chatgpt.com"; } catch { return false; } });
    if (!tab) return { pageReady: false, pageState: "no-chatgpt-tab" };
    const result = await fetcher(proxy + "/eval?target=" + encodeURIComponent(tab.targetId ?? tab.id), { method: "POST", body: chatGptPageProbe, signal: AbortSignal.timeout(4000) });
    let state = await result.json(); for (let i = 0; i < 4; i++) { if (typeof state === "string") { state = JSON.parse(state); continue; } if (state?.value !== undefined) { state = state.value; continue; } break; }
    return { pageReady: state?.composer === true && state.login !== true, pageState: state?.login ? "login-required" : state?.composer ? "composer-ready" : "page-unavailable" };
  } catch { return { pageReady: false, pageState: "page-unavailable" }; }
}
