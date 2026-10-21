import { spawnSync } from "node:child_process";
import { Pool, ProxyAgent, setGlobalDispatcher } from "undici";
import { resolve4 } from "node:dns/promises";
import { isIP } from "node:net";
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
const modelProxyOverride = process.env.QQBOT_MODEL_PROXY_URL?.trim();
const configuredModelProxy = modelProxyOverride || configuredProxy;

const modelAddressCache = new Map();

export async function resolveModelConnectAddress(endpoint, { resolver = resolve4, attempt = 1, signal } = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || isIP(url.hostname) || url.hostname === "localhost" || url.hostname.endsWith(".invalid")) return null;
  signal?.throwIfAborted();
  let addresses;
  const cached = resolver === resolve4 ? modelAddressCache.get(url.hostname) : null;
  if (cached && cached.until > Date.now()) addresses = cached.addresses;
  else {
    let timer;
    try {
      addresses = await Promise.race([
        resolver(url.hostname),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Model DNS deadline")), 1500); }),
      ]);
      addresses = [...new Set(addresses.filter(address => typeof address === "string" && isIP(address) === 4))];
    } catch { addresses = []; }
    finally { clearTimeout(timer); }
    if (resolver === resolve4) {
      if (modelAddressCache.size >= 128) modelAddressCache.delete(modelAddressCache.keys().next().value);
      modelAddressCache.set(url.hostname, { addresses, until: Date.now() + (addresses.length ? 60_000 : 10_000) });
    }
  }
  signal?.throwIfAborted();
  return addresses.length ? addresses[(Math.max(1, Math.floor(attempt) || 1) - 1) % addresses.length] : null;
}

export function modelProxyOptions(proxyUrl, endpoint, address) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || isIP(address) !== 4 || isIP(url.hostname)) throw new Error("Invalid model tunnel target");
  const authority = address + ":" + (url.port || "443");
  return {
    uri: proxyUrl,
    connections: 2,
    pipelining: 1,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 60_000,
    // Only CONNECT's destination changes. HTTP Host, SNI and certificate checks
    // still use the configured endpoint. Never disable certificate validation.
    requestTls: { servername: url.hostname, rejectUnauthorized: true },
    clientFactory(origin, options) {
      const pool = new Pool(origin, options);
      const connect = pool.connect.bind(pool);
      pool.connect = (options, callback) => connect({ ...options, path: authority, headers: { ...options.headers, host: authority } }, callback);
      return pool;
    },
  };
}

export async function createModelDispatcher(endpoint, options = {}) {
  if (!configuredModelProxy) return { dispatcher: undefined, route: "direct" };
  const address = endpoint ? await resolveModelConnectAddress(endpoint, options) : null;
  const scope = modelProxyOverride ? "model_proxy" : "proxy";
  return { dispatcher: new ProxyAgent(address ? modelProxyOptions(configuredModelProxy, endpoint, address) : { uri: configuredModelProxy, connections: 2, keepAliveTimeout: 60_000, keepAliveMaxTimeout: 60_000 }), route: address ? scope + "_ipv4" : scope };
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
