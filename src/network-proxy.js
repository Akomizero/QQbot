import { spawnSync } from "node:child_process";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { loadEnvironment } from "./config.js";

loadEnvironment();

function readWindowsProxyUrl() {
  if (process.platform !== "win32") return "";
  const script = String.raw`$p=Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue; if($p.ProxyEnable -eq 1){$s=[string]$p.ProxyServer;if($s -match '(?:^|;)https=([^;]+)'){$s=$Matches[1]}elseif($s -match '(?:^|;)http=([^;]+)'){$s=$Matches[1]}if($s -and $s -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://'){$s="http://$s"};if($s){[Console]::Out.Write($s)}}`;
  const result = spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3000,
  });
  if (result.error || result.status !== 0) return "";
  const proxyUrl = result.stdout.trim();
  if (!proxyUrl || proxyUrl.length > 2048) return "";
  try {
    const parsed = new URL(proxyUrl);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname ? parsed.href : "";
  } catch {
    return "";
  }
}

const configuredProxy = process.env.HTTPS_PROXY?.trim()
  || process.env.https_proxy?.trim()
  || process.env.HTTP_PROXY?.trim()
  || process.env.http_proxy?.trim()
  || readWindowsProxyUrl();

export function createModelDispatcher() {
  return configuredProxy ? new ProxyAgent(configuredProxy) : undefined;
}

// Internal only: public-page requests use their own pinned CONNECT transport.
export function getConfiguredProxyUrl() { return configuredProxy || null; }

if (configuredProxy) {
  try {
    setGlobalDispatcher(new ProxyAgent(configuredProxy));
  } catch {
    // If the local proxy setting is malformed, keep the standard direct-fetch behavior.
  }
}
