import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { connect as tlsConnect, checkServerIdentity } from "node:tls";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { isPublicAddress } from "./image-input.js";
import { getConfiguredProxyUrl } from "./network-proxy.js";

const limit = 2 * 1024 * 1024;

export function publicPageUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("请提供完整的公开 HTTPS 网页链接。"); }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.href.length > 1800
    || hostname === "localhost" || (!hostname.includes(".") && !isIP(hostname)) || (isIP(hostname) && !isPublicAddress(hostname))) throw new Error("只能读取公开的 HTTPS 网页。");
  url.hash = "";
  return url;
}

export async function publicPageAddress(value) {
  const url = value instanceof URL ? publicPageUrl(value.href) : publicPageUrl(value);
  let timer;
  try {
    const records = await Promise.race([lookup(url.hostname.replace(/^\[|\]$/gu, ""), { all: true, verbatim: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("网页地址解析超时。")), 3000); })]);
    if (!records.length || records.some(({address}) => !isPublicAddress(address))) throw new Error("网页地址不是公开网络地址。");
    const record = records.find((item) => item.family === 4) ?? records[0];
    return { url, record };
  } finally { clearTimeout(timer); }
}

function proxyTunnel(proxy, record, signal) {
  const target = `${record.family === 6 ? `[${record.address}]` : record.address}:443`;
  return new Promise((resolve, reject) => {
    const request = (proxy.protocol === "https:" ? https : http).request({ hostname: proxy.hostname, port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
      method: "CONNECT", path: target, agent: false, signal, maxHeaderSize: 8192,
      headers: { host: target, ...(proxy.username ? { "proxy-authorization": "Basic " + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64") } : {}) } });
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200 || head.length || signal.aborted) { socket.destroy(); reject(new Error("网页代理连接失败。")); }
      else resolve(socket);
    });
    request.once("response", (response) => { response.destroy(); reject(new Error("网页代理拒绝连接。")); });
    request.once("error", reject); request.end();
  });
}

function pageAgent(url, record, signal) {
  const proxyValue = getConfiguredProxyUrl();
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
  if (!proxyValue) return agent;
  const proxy = new URL(proxyValue);
  if (!["http:", "https:"].includes(proxy.protocol)) throw new Error("网页代理配置不可用。");
  agent.createConnection = (_options, callback) => {
    let done = false;
    const complete = (error, socket) => { if (done) { socket?.destroy(); return; } done = true; callback(error, socket); };
    proxyTunnel(proxy, record, signal).then((tunnel) => {
      if (signal.aborted) { tunnel.destroy(); complete(new Error("读取网页超时。")); return; }
      const socket = tlsConnect({ socket: tunnel, servername: url.hostname, rejectUnauthorized: true,
        checkServerIdentity: (_host, certificate) => checkServerIdentity(url.hostname, certificate) });
      const abort = () => socket.destroy(new Error("读取网页超时。"));
      signal.addEventListener("abort", abort, { once: true });
      socket.once("secureConnect", () => { signal.removeEventListener("abort", abort); complete(null, socket); });
      socket.once("error", (error) => { signal.removeEventListener("abort", abort); complete(error); });
    }).catch((error) => complete(error));
    return undefined;
  };
  return agent;
}

async function requestPage(url, record) {
  const signal = AbortSignal.timeout(15000);
  const agent = pageAgent(url, record, signal);
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: url.hostname, port: 443, servername: url.hostname, path: url.pathname + url.search,
      agent, signal, maxHeaderSize: 16384, rejectUnauthorized: true, checkServerIdentity: (_host, cert) => checkServerIdentity(url.hostname, cert),
      lookup: (_host, options, callback) => {
        if (typeof options === "function") { callback = options; options = {}; }
        if (options?.all) callback(null, [record]); else callback(null, record.address, record.family);
      }, headers: { host: url.hostname, "user-agent": "Mozilla/5.0 (compatible; QQBotSummary/1.0)", accept: "text/html,application/xhtml+xml,text/plain;q=0.9", "accept-encoding": "identity" } }, (response) => {
      const status = response.statusCode ?? 0;
      if ([301,302,303,307,308].includes(status)) {
        const location = response.headers.location;
        response.destroy(); agent.destroy();
        if (location) resolve({ redirect: location }); else reject(new Error("网页跳转缺少目标地址。"));
        return;
      }
      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300 || !/^(?:text\/|application\/(?:xhtml\+xml|json))/iu.test(contentType) || Number(response.headers["content-length"]) > limit) {
        response.destroy(); agent.destroy(); reject(new Error("网页需要登录、限制访问或不是可读文字页面。")); return;
      }
      const chunks = []; let size = 0;
      response.on("data", (chunk) => { size += chunk.length; if (size > limit) { response.destroy(new Error("网页内容过大。")); return; } chunks.push(chunk); });
      response.once("error", (error) => { agent.destroy(); reject(error); });
      response.once("end", () => {
        agent.destroy();
        try {
          let bytes = Buffer.concat(chunks);
          const encoding = response.headers["content-encoding"];
          if (encoding === "gzip") bytes = gunzipSync(bytes, {maxOutputLength:limit});
          else if (encoding === "deflate") bytes = inflateSync(bytes, {maxOutputLength:limit});
          else if (encoding === "br") bytes = brotliDecompressSync(bytes, {maxOutputLength:limit});
          const charset = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/iu)?.[1]
            ?? bytes.subarray(0,4096).toString("ascii").match(/charset\s*=\s*["']?([a-z0-9_-]+)/iu)?.[1] ?? "utf-8";
          let text; try { text = new TextDecoder(charset).decode(bytes); } catch { text = bytes.toString("utf8"); }
          resolve({ text, url:url.href, contentType });
        } catch { reject(new Error("网页正文无法解码。")); }
      });
    });
    request.once("error", (error) => { agent.destroy(); reject(error); }); request.end();
  });
}

async function readPublicPageOnce(value) {
  let next = value;
  for (let hop = 0; hop <= 3; hop += 1) {
    const {url,record} = await publicPageAddress(next);
    const response = await requestPage(url,record);
    if (!response.redirect) return response;
    next = new URL(response.redirect,url).href;
  }
  throw new Error("网页跳转过多，请发送最终页面链接。");
}

export async function readPublicPage(value) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await readPublicPageOnce(value); }
    catch (error) {
      if (attempt || !["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ABORT_ERR"].includes(error.code)) throw error;
      // Public GET only: create a fresh validated connection after a transient disconnect.
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
