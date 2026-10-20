import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { Agent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";
import { getGlobalDispatcher } from "undici";
import sharp from "sharp";

const imageTimeoutMs = 12_000;
const dnsTimeoutMs = 3_000;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_GIF_BYTES = 20 * 1024 * 1024;
export const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_SOURCE_IMAGE_BYTES = 24 * 1024 * 1024;
export const MAX_IMAGE_COUNT = 2;
// Keep public global references only as a baseline; routing is selected explicitly per image request.
const initialGlobalHttpAgent = http.globalAgent;
const initialGlobalHttpsAgent = https.globalAgent;
const initialGlobalFetch = globalThis.fetch;
const initialGlobalDispatcher = getGlobalDispatcher();
const allowedImageHostnames = new Set([
  // Exact host in an observed QQ image attachment example:
  // https://github.com/LagrangeDev/Lagrange.Core/issues/315
  // Keep this exact-match allowlist narrow; do not widen it to a parent suffix.
  "multimedia.nt.qq.com.cn",
]);

const nonPublicIpv4Ranges = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const nonPublicIpv6Ranges = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

// Explicitly assigned global-unicast allocations from the IANA IPv6 Global Unicast
// Address Space registry. The broad 2000::/3 block is intentionally not sufficient:
// every address must also fall inside one of these currently assigned prefixes.
const assignedPublicIpv6Ranges = [
  ["2001:200::", 23],
  ["2001:400::", 23],
  ["2001:600::", 23],
  ["2001:800::", 22],
  ["2001:c00::", 23],
  ["2001:e00::", 23],
  ["2001:1200::", 23],
  ["2001:1400::", 22],
  ["2001:1800::", 23],
  ["2001:1a00::", 23],
  ["2001:1c00::", 22],
  ["2001:2000::", 19],
  ["2001:4000::", 23],
  ["2001:4200::", 23],
  ["2001:4400::", 23],
  ["2001:4600::", 23],
  ["2001:4800::", 23],
  ["2001:4a00::", 23],
  ["2001:4c00::", 23],
  ["2001:5000::", 20],
  ["2001:8000::", 19],
  ["2001:a000::", 20],
  ["2001:b000::", 20],
  ["2003::", 18],
  ["2400::", 12],
  ["2410::", 12],
  ["2600::", 12],
  ["2610::", 23],
  ["2620::", 23],
  ["2630::", 12],
  ["2800::", 12],
  ["2a00::", 12],
  ["2a10::", 12],
  ["2c00::", 12],
];

const imageFormats = new Map([
  ["image/jpeg", (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ["image/png", (bytes) => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))],
  ["image/webp", (bytes) => bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"],
]);

export class ImageInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImageInputError";
  }
}

function isImageAttachment(attachment) {
  const mime = typeof attachment?.content_type === "string" ? attachment.content_type.split(";", 1)[0].trim().toLowerCase() : "";
  if (mime.startsWith("image/")) return true;
  const genericMime = !mime || ["file", "application/octet-stream", "binary/octet-stream"].includes(mime);
  return genericMime && /\.(?:jpe?g|png|webp)$/iu.test(attachment?.filename ?? "");
}

export function hasImageAttachment(attachments) {
  return Array.isArray(attachments) && attachments.some(isImageAttachment);
}

export function validateImageBytes(input, declaredMime = "") {
  const bytes = Buffer.isBuffer(input) ? input : input instanceof Uint8Array ? Buffer.from(input) : null;
  if (!bytes?.length) throw new ImageInputError("这张图片暂时无法读取，请重新发送后再试。");
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageInputError("这张图片超过 4 MB，请压缩后重新发送。");

  const format = [...imageFormats].find(([, signature]) => signature(bytes));
  if (!format) throw new ImageInputError("目前只支持 JPG、PNG 或 WebP 图片，请用这几种格式重新发送。");
  const [mime] = format;
  const normalizedDeclaredMime = typeof declaredMime === "string"
    ? declaredMime.split(";", 1)[0].trim().toLowerCase()
    : "";
  if (normalizedDeclaredMime.startsWith("image/") && normalizedDeclaredMime !== mime) {
    throw new ImageInputError("图片类型校验未通过，请重新发送 JPG、PNG 或 WebP 图片。");
  }

  return { mime, bytes };
}

export function isNapCatImageFile(value) {
  return typeof value === "string" && /^(?:[a-f\d]{32}|\{[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\})\.(?:jpe?g|png|webp|gif)$/iu.test(value);
}

function isGifBytes(bytes) {
  return ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6));
}

export function readNapCatImageBytes(value, remainingBytes = MAX_TOTAL_SOURCE_IMAGE_BYTES, { allowGif = true, allowLargeImages = false } = {}) {
  if (typeof value !== "string" || !value) {
    throw new ImageInputError("QQ 暂未返回这张图片或表情的内容，请重新发送；若持续出现，请管理员检查 NapCat 的 enableLocalFile2Url 配置。");
  }
  const largestSource = allowGif || allowLargeImages ? MAX_SOURCE_IMAGE_BYTES : MAX_IMAGE_BYTES;
  const rawLimit = Math.ceil(Math.min(largestSource, remainingBytes) / 3) * 4;
  if (remainingBytes <= 0 || value.length > Math.ceil(rawLimit * 1.1) + 256) {
    throw new ImageInputError(allowGif || allowLargeImages ? "图片或 GIF 每张最多 20 MB，原始图片总量最多 24 MB，请压缩或减少图片后再试。" : "这张图片超过 4 MB，请压缩后重新发送。");
  }
  const encoded = value.replace(/^data:image\/(?:jpeg|jpg|png|webp|gif);base64,/iu, "")
    .replace(/^base64:\/\//u, "").replace(/[\r\n\t ]/gu, "");
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 === 1) {
    throw new ImageInputError("图片或表情的数据格式不正确，请重新发送。");
  }
  const gif = allowGif && isGifBytes(Buffer.from(encoded.slice(0, 16), "base64"));
  const perImageLimit = gif ? MAX_GIF_BYTES : allowLargeImages ? MAX_SOURCE_IMAGE_BYTES : MAX_IMAGE_BYTES;
  const byteLimit = Math.min(perImageLimit, remainingBytes);
  if (encoded.length > Math.ceil(byteLimit / 3) * 4) {
    throw new ImageInputError(remainingBytes < perImageLimit
      ? "原始图片总量超过限制，请减少图片数量后再试。"
      : perImageLimit > MAX_IMAGE_BYTES ? "这张图片或 GIF 超过 20 MB，请压缩后重新发送。" : "这张图片超过 4 MB，请压缩后重新发送。");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")) {
    throw new ImageInputError("图片或表情的数据校验未通过，请重新发送。");
  }
  if (bytes.length > byteLimit) {
    throw new ImageInputError("图片或表情超过大小限制，请压缩或减少图片数量后再试。");
  }

  return bytes;
}

export function decodeNapCatImageBase64(value, remainingBytes = MAX_TOTAL_IMAGE_BYTES) {
  const bytes = readNapCatImageBytes(value, remainingBytes, { allowGif: false });
  const { mime } = validateImageBytes(bytes);
  return {
    mime,
    byteLength: bytes.length,
    dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
  };
}

// Large sources become bounded model inputs; GIFs use one frame. No URL or path is opened.
export async function prepareNapCatImageBase64(value, remainingBytes = MAX_TOTAL_IMAGE_BYTES, { remainingSourceBytes = MAX_TOTAL_SOURCE_IMAGE_BYTES, includeSourceBytes = false } = {}) {
  const bytes = readNapCatImageBytes(value, remainingSourceBytes, { allowLargeImages: true });
  const source = { sourceByteLength: bytes.length, ...(includeSourceBytes ? { sourceBytes: bytes } : {}) };
  if (!isGifBytes(bytes)) {
    const format = [...imageFormats].find(([, signature]) => signature(bytes));
    if (!format) throw new ImageInputError("目前只支持 JPG、PNG、WebP 或 GIF 图片，请用这些格式重新发送。");
    if (remainingBytes <= 0) throw new ImageInputError("送入识图的图片总量最多 6 MB，请减少图片数量后再试。");
    if (bytes.length <= Math.min(MAX_IMAGE_BYTES, remainingBytes)) {
      return { mime: format[0], byteLength: bytes.length, dataUrl: `data:${format[0]};base64,${bytes.toString("base64")}`, ...source };
    }
    try {
      const output = await sharp(bytes, { pages: 1, limitInputPixels: 40_000_000, failOn: "warning" }).rotate()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      if (output.length > Math.min(MAX_IMAGE_BYTES, remainingBytes)) throw new ImageInputError("压缩后的图片仍然过大，请减少图片数量后再试。");
      return { mime: "image/webp", byteLength: output.length, dataUrl: `data:image/webp;base64,${output.toString("base64")}`, ...source };
    } catch (error) {
      if (error instanceof ImageInputError) throw error;
      throw new ImageInputError("这张图片暂时无法缩小读取，请降低分辨率或重新发送。");
    }
  }
  try {
    if (bytes.length < 10 || bytes.readUInt16LE(6) < 1 || bytes.readUInt16LE(8) < 1
      || bytes.readUInt16LE(6) * bytes.readUInt16LE(8) > 16_000_000) throw new Error("Invalid GIF dimensions");
    if (remainingBytes <= 0) throw new ImageInputError("送入识图的图片总量最多 6 MB，请减少图片数量后再试。");
    const frame = sharp(bytes, { animated: false, pages: 1, limitInputPixels: 16_000_000, failOn: "warning" })
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true });
    let output = await frame.clone().png().toBuffer();
    let mime = "image/png";
    if (output.length > Math.min(MAX_IMAGE_BYTES, remainingBytes)) {
      output = await frame.clone().webp({ quality: 82 }).toBuffer();
      mime = "image/webp";
    }
    if (output.length > Math.min(MAX_IMAGE_BYTES, remainingBytes)) throw new ImageInputError("转换后的图片仍然过大，请减少图片数量后再试。");
    return { mime, byteLength: output.length, ...source, firstFrameOnly: true, dataUrl: `data:${mime};base64,${output.toString("base64")}` };
  } catch (error) {
    if (error instanceof ImageInputError) throw error;
    throw new ImageInputError("这个动态表情暂时无法读取，请换一个表情或发送它的截图。");
  }
}

function invalidImageUrl() {
  return new ImageInputError("这张图片来源无法安全读取，请重新从 QQ 群里发送图片。");
}

function validateAttachmentUrl(value) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    value !== value.trim() ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    throw new ImageInputError("我没能读取这张图片，请重新发送一张 JPG、PNG 或 WebP 图片。\n图片每张最多 4 MB，一次最多 2 张。");
  }

  const authority = value.match(/^https:\/\/([^/?#]*)/iu)?.[1]?.toLowerCase();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ImageInputError("我没能读取这张图片，请重新发送一张 JPG、PNG 或 WebP 图片。\n图片每张最多 4 MB，一次最多 2 张。");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port !== "" ||
    url.hash ||
    !authority ||
    !allowedImageHostnames.has(hostname) ||
    ![hostname, `${hostname}:443`].includes(authority) ||
    isIP(hostname) !== 0
  ) {
    throw invalidImageUrl();
  }

  return url;
}

function ipv4ToBigInt(address) {
  return address.split(".").reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n);
}

function ipv6ToBigInt(address) {
  if (address.includes("%")) return null;

  let source = address.toLowerCase();
  if (source.includes(".")) {
    const separator = source.lastIndexOf(":");
    const ipv4 = source.slice(separator + 1);
    if (separator < 0 || isIP(ipv4) !== 4) return null;
    const ipv4Value = ipv4ToBigInt(ipv4);
    const firstHextet = Number((ipv4Value >> 16n) & 0xffffn).toString(16);
    const secondHextet = Number(ipv4Value & 0xffffn).toString(16);
    source = `${source.slice(0, separator)}:${firstHextet}:${secondHextet}`;
  }

  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missingGroups = 8 - left.length - right.length;
  if ((halves.length === 1 && missingGroups !== 0) || (halves.length === 2 && missingGroups < 1)) return null;

  const groups = [...left, ...Array(missingGroups).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/u.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function isWithinCidr(addressValue, network, prefix, bitLength) {
  const networkValue = isIP(network) === 4 ? ipv4ToBigInt(network) : ipv6ToBigInt(network);
  if (networkValue === null) return false;
  const shift = BigInt(bitLength - prefix);
  return (addressValue >> shift) === (networkValue >> shift);
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToBigInt(address);
    return !nonPublicIpv4Ranges.some(([network, prefix]) => isWithinCidr(value, network, prefix, 32));
  }

  if (family === 6) {
    const value = ipv6ToBigInt(address);
    if (value === null || (value >> 125n) !== 1n) return false;
    return assignedPublicIpv6Ranges.some(([network, prefix]) => isWithinCidr(value, network, prefix, 128))
      && !nonPublicIpv6Ranges.some(([network, prefix]) => isWithinCidr(value, network, prefix, 128));
  }

  return false;
}

async function assertPublicDns(hostname) {
  let timer;
  let records;
  try {
    records = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS lookup timed out")), dnsTimeoutMs);
      }),
    ]);
  } catch {
    throw invalidImageUrl();
  } finally {
    clearTimeout(timer);
  }

  if (!records.length || records.some(({ address }) => !isPublicAddress(address))) {
    throw invalidImageUrl();
  }

  const pinnedRecord = records.find(({ address }) => isIP(address) === 4) ?? records[0];
  return { address: pinnedRecord.address, family: isIP(pinnedRecord.address) };
}

function hasNonEmptyProxyEnvironmentVariable(names) {
  const normalizedNames = new Set(names);
  return Object.keys(process.env).some((name) => {
    if (!normalizedNames.has(name.toUpperCase())) return false;
    // Use the value only as a boolean; never retain, log, or return it.
    return typeof process.env[name] === "string" && process.env[name].trim().length > 0;
  });
}

function hasNodeProxyFlag() {
  return process.execArgv.some((argument) =>
    argument === "--use-env-proxy" || argument.startsWith("--use-env-proxy="));
}

function hasNodeProxyMarker() {
  return Object.keys(process.env).some((name) =>
    name.toUpperCase() === "NODE_USE_ENV_PROXY" && process.env[name] === "1");
}

function getNonEmptyEnvironmentValue(upperName, lowerName) {
  const upper = process.env[upperName];
  if (typeof upper === "string" && upper.trim()) return upper.trim();
  const lower = process.env[lowerName];
  if (typeof lower === "string" && lower.trim()) return lower.trim();
  return null;
}

function hasUnexpectedGlobalAgent(agent) {
  try {
    return !agent || !(agent instanceof http.Agent);
  } catch {
    return true;
  }
}

function assertImageNetworkingBaseline() {
  try {
    // Image requests always supply their own direct or CONNECT-backed agent. Still
    // fail closed if application code replaces global networking primitives after
    // the image module captured its baseline.
    const httpAgent = http.globalAgent;
    const httpsAgent = https.globalAgent;
    const globalDispatcher = getGlobalDispatcher();
    if (
      httpAgent !== initialGlobalHttpAgent
      || httpsAgent !== initialGlobalHttpsAgent
      || hasUnexpectedGlobalAgent(httpAgent)
      || hasUnexpectedGlobalAgent(httpsAgent)
      || globalThis.fetch !== initialGlobalFetch
      || !initialGlobalDispatcher
      || globalDispatcher !== initialGlobalDispatcher
    ) {
      throw new ImageInputError("这张图片暂时无法安全读取，请联系管理员检查网络配置后再试。");
    }
  } catch {
    throw new ImageInputError("这张图片暂时无法安全读取，请联系管理员检查网络配置后再试。");
  }
}

function isNoProxyMatch(hostname, port) {
  const noProxy = getNonEmptyEnvironmentValue("NO_PROXY", "no_proxy");
  if (!noProxy) return false;

  const normalizedHostname = hostname.toLowerCase().replace(/\.$/u, "");
  return noProxy.split(",").some((rawEntry) => {
    let entry = rawEntry.trim().toLowerCase();
    if (!entry) return false;
    if (entry === "*") return true;

    let entryPort = null;
    const portMatch = entry.match(/:(\d+)$/u);
    if (portMatch) {
      entryPort = Number(portMatch[1]);
      entry = entry.slice(0, -portMatch[0].length);
      if (!Number.isInteger(entryPort) || entryPort < 1 || entryPort > 65535) return false;
    } else if (entry.includes(":")) {
      // IPv6 and malformed tokens are not relevant to this fixed DNS hostname.
      return false;
    }

    if (entryPort !== null && entryPort !== port) return false;
    entry = entry.replace(/^\*\./u, "").replace(/^\./u, "").replace(/\.$/u, "");
    if (!entry || /[^a-z0-9.-]/u.test(entry) || entry.includes("..")) return false;
    return normalizedHostname === entry || normalizedHostname.endsWith(`.${entry}`);
  });
}

function proxyConfigurationError() {
  return new ImageInputError("图片暂时无法通过当前出站代理读取，请联系管理员检查代理配置后再试。");
}

function parseProxyUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw proxyConfigurationError();
  }

  const authorityMatch = value.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)(.*)$/iu);
  const rawAuthority = authorityMatch?.[1] ?? "";
  const rawSuffix = authorityMatch?.[2] ?? "";
  if (
    !authorityMatch
    || rawAuthority.includes("@")
    || !["http:", "https:"].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash
    || !["", "/"].includes(rawSuffix)
    || url.pathname !== "/"
  ) {
    throw proxyConfigurationError();
  }

  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw proxyConfigurationError();
  }

  return { protocol: url.protocol, hostname, port };
}

function resolveProxyRoute(hostname) {
  assertImageNetworkingBaseline();

  // ALL_PROXY is intentionally unsupported; accepting it implicitly would make
  // the route depend on library-specific SOCKS/HTTP semantics.
  if (hasNonEmptyProxyEnvironmentVariable(["ALL_PROXY"])) throw proxyConfigurationError();

  const proxyValue = getNonEmptyEnvironmentValue("HTTPS_PROXY", "https_proxy")
    ?? getNonEmptyEnvironmentValue("HTTP_PROXY", "http_proxy");
  const proxyEnabledWithoutAddress = hasNodeProxyFlag() || hasNodeProxyMarker();
  if (!proxyValue) {
    if (proxyEnabledWithoutAddress) throw proxyConfigurationError();
    return null;
  }

  // NO_PROXY supports '*', exact host/domain suffixes (including leading dot or
  // '*.'), and an optional decimal port. Image origin is always HTTPS on port 443.
  if (isNoProxyMatch(hostname, 443)) return null;
  return parseProxyUrl(proxyValue);
}

function createPinnedLookup(expectedHostname, pinnedAddress) {
  return (hostname, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (hostname.toLowerCase() !== expectedHostname) {
      callback(new Error("Unexpected image hostname lookup"));
      return;
    }

    const record = { address: pinnedAddress.address, family: pinnedAddress.family };
    if (options?.all) callback(null, [record]);
    else callback(null, record.address, record.family);
  };
}

function addressKey(address) {
  const family = isIP(address);
  if (family === 4) return `4:${ipv4ToBigInt(address)}`;
  if (family !== 6) return null;

  const value = ipv6ToBigInt(address);
  if (value === null) return null;
  if (isWithinCidr(value, "::ffff:0:0", 96, 128)) {
    return `4:${value & ((1n << 32n) - 1n)}`;
  }
  return `6:${value}`;
}

function isSameAddress(left, right) {
  const leftKey = addressKey(left);
  return leftKey !== null && leftKey === addressKey(right);
}

function requestProxyTunnel(proxy, pinnedAddress, signal) {
  const targetHost = isIP(pinnedAddress.address) === 6
    ? `[${pinnedAddress.address}]`
    : pinnedAddress.address;
  const authority = `${targetHost}:443`;
  const requestFunction = proxy.protocol === "https:" ? https.request : http.request;

  return new Promise((resolve, reject) => {
    let settled = false;
    const request = requestFunction({
      hostname: proxy.hostname,
      port: proxy.port,
      method: "CONNECT",
      path: authority,
      headers: { host: authority },
      agent: false,
      signal,
      maxHeaderSize: 8 * 1024,
    });

    request.once("connect", (response, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      if (
        !Number.isInteger(response.statusCode)
        || response.statusCode < 200
        || response.statusCode >= 300
        || (head?.length ?? 0) > 0
        || signal.aborted
      ) {
        socket.destroy();
        reject(new Error("Image proxy CONNECT failed"));
        return;
      }
      resolve(socket);
    });

    request.once("response", (response) => {
      if (settled) return;
      settled = true;
      reject(new Error("Image proxy rejected CONNECT"));
      response.destroy();
    });

    request.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    request.end();
  });
}

function createProxyImageAgent(url, pinnedAddress, proxy, signal) {
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = (_options, callback) => {
    let callbackCalled = false;
    const complete = (error, socket) => {
      if (callbackCalled) {
        socket?.destroy();
        return;
      }
      callbackCalled = true;
      callback(error, socket);
    };

    requestProxyTunnel(proxy, pinnedAddress, signal).then((tunnelSocket) => {
      if (signal.aborted) {
        tunnelSocket.destroy();
        complete(new Error("Image request timed out"));
        return;
      }

      const secureSocket = tlsConnect({
        socket: tunnelSocket,
        servername: url.hostname,
        rejectUnauthorized: true,
        checkServerIdentity: (_hostname, certificate) => checkServerIdentity(url.hostname, certificate),
      });
      const onAbort = () => secureSocket.destroy(new Error("Image request timed out"));
      const removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      secureSocket.once("secureConnect", () => {
        removeAbortListener();
        complete(null, secureSocket);
      });
      secureSocket.once("error", (error) => {
        removeAbortListener();
        complete(error);
      });
    }).catch((error) => complete(error));

    return undefined;
  };
  return agent;
}

function requestPinnedImage(url, pinnedAddress, proxy) {
  // Recheck immediately before creating either a direct request or a CONNECT tunnel.
  assertImageNetworkingBaseline();
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(imageTimeoutMs);
    const agent = proxy
      ? createProxyImageAgent(url, pinnedAddress, proxy, signal)
      : new Agent({ keepAlive: false });
    let settled = false;
    const request = httpsRequest({
      hostname: url.hostname,
      servername: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        accept: "image/jpeg, image/png, image/webp",
        host: url.hostname,
      },
      agent,
      lookup: createPinnedLookup(url.hostname, pinnedAddress),
      rejectUnauthorized: true,
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(url.hostname, certificate),
      signal,
    }, (incoming) => {
      const peerAddress = incoming.socket?.remoteAddress;
      // A tunnel's local socket peer is the configured proxy. TLS authenticates
      // the original image hostname inside CONNECT; the proxy remains a trust boundary.
      if (!proxy && (!peerAddress || !isSameAddress(peerAddress, pinnedAddress.address))) {
        incoming.destroy();
        agent.destroy();
        settled = true;
        reject(new Error("Image connection did not use the validated address"));
        return;
      }

      settled = true;
      const status = incoming.statusCode ?? 0;
      const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming);
      resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: {
          get(name) {
            const value = incoming.headers[name.toLowerCase()];
            return Array.isArray(value) ? value.join(", ") : value ?? null;
          },
        },
        body,
        dispose: () => agent.destroy(),
      });
    });

    request.once("error", (error) => {
      agent.destroy();
      if (settled) return;
      settled = true;
      reject(error);
    });
    request.end();
  });
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best effort; a rejected response must not mask its original error.
  }
}

async function readImageBody(response, remainingBytes) {
  const byteLimit = Math.min(MAX_IMAGE_BYTES, remainingBytes);
  const tooLargeMessage = byteLimit < MAX_IMAGE_BYTES
    ? "图片总大小不能超过 6 MB，请压缩或减少图片数量后再试。"
    : "这张图片超过 4 MB，请压缩后重新发送。";
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > byteLimit) {
    await cancelResponseBody(response);
    throw new ImageInputError(tooLargeMessage);
  }

  const mime = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  const signature = imageFormats.get(mime);
  if (!signature) {
    await cancelResponseBody(response);
    throw new ImageInputError("目前只支持 JPG、PNG 或 WebP 图片，请用这几种格式重新发送。");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    await cancelResponseBody(response);
    throw new ImageInputError("这张图片暂时无法读取，请重新发送后再试。");
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > byteLimit) {
        try {
          await reader.cancel();
        } catch {
          // Continue with the size rejection even if the stream cannot be canceled.
        }
        throw new ImageInputError(tooLargeMessage);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks);
  if (!signature(bytes)) throw new ImageInputError("图片格式校验未通过，请重新发送 JPG、PNG 或 WebP 图片。");
  return { mime, bytes };
}

async function downloadImage(attachment, remainingBytes) {
  const url = validateAttachmentUrl(attachment?.url);
  const proxy = resolveProxyRoute(url.hostname);

  let response;
  try {
    const pinnedAddress = await assertPublicDns(url.hostname);
    response = await requestPinnedImage(url, pinnedAddress, proxy);
  } catch (error) {
    if (error instanceof ImageInputError) throw error;
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ImageInputError("读取图片超时了，请重新发送后再试。");
    }
    if (proxy) throw proxyConfigurationError();
    throw new ImageInputError("这张图片暂时无法读取，请重新从 QQ 群里发送后再试。");
  }

  try {
    if (!response.ok) {
      // https.request never follows redirects; this also rejects every 3xx response.
      await cancelResponseBody(response);
      throw new ImageInputError("QQ 图片链接已失效或暂时不可用，请重新发送图片。");
    }
    const { mime, bytes } = await readImageBody(response, remainingBytes);
    const declaredMime = typeof attachment.content_type === "string"
      ? attachment.content_type.split(";", 1)[0].trim().toLowerCase()
      : "";
    if (declaredMime.startsWith("image/") && declaredMime !== mime) {
      throw new ImageInputError("图片类型校验未通过，请重新发送 JPG、PNG 或 WebP 图片。");
    }
    return { mime, bytes };
  } finally {
    response.dispose();
  }
}

export async function loadImageDataUrls(attachments) {
  // Node can globally disable TLS certificate validation, overriding per-request
  // rejectUnauthorized settings. Do not start an image request in that process.
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new ImageInputError("当前无法安全读取图片，请稍后再试。");
  }
  if (!Array.isArray(attachments)) return [];
  const candidates = attachments.filter(isImageAttachment);
  if (candidates.length > MAX_IMAGE_COUNT) {
    throw new ImageInputError("一次最多识别 2 张图片，请减少图片数量后再试。");
  }

  const images = [];
  let totalBytes = 0;
  for (const attachment of candidates) {
    const image = await downloadImage(attachment, MAX_TOTAL_IMAGE_BYTES - totalBytes);
    totalBytes += image.bytes.byteLength;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new ImageInputError("图片总大小不能超过 6 MB，请压缩或减少图片数量后再试。");
    }
    images.push(`data:${image.mime};base64,${image.bytes.toString("base64")}`);
  }
  return images;
}
