import { createModelConnectionPool } from "./model-connection-pool.js";
import { recordModelDiagnostic, withModelOperation } from "./model-diagnostics.js";
const serperConnections = createModelConnectionPool();
export const closeSearchConnections = () => serperConnections.close();
const endpoint = "https://api.tavily.com/search";
const timeoutMs = 12_000;
const maxResponseBytes = 512 * 1024;
const maxResults = 5;
const maxExcerptLength = 1400;
export const CHINESE_COMMUNITY_DOMAINS = ["bilibili.com", "zhihu.com", "tieba.baidu.com", "baike.baidu.com", "zh.moegirl.org.cn", "nga.cn", "gcores.com"];
const providerCooldowns = new Map();
const resultCache = new Map();
const cacheTtlMs = 5 * 60_000;

const requestSerper = (apiKey, body) => withModelOperation(() => requestSerperInternal(apiKey, body));
async function requestSerperInternal(apiKey, body) {
  const target = "https://google.serper.dev/search", deadline = AbortSignal.timeout(40_000);
  let finalError, attempts = 0;
  for (let attempt = 1; attempt <= 3 && !deadline.aborted; attempt++) {
    attempts = attempt;
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(timeoutMs)]);
    let entry, response, retryable = false, delay = attempt === 1 ? 1000 : 3000;
    const started = Date.now();
    try {
      ({ entry } = await serperConnections.acquire(target, { attempt, signal }));
      recordModelDiagnostic("tools", { code: "SERPER_REQUEST", phase: "serper_search", attempt, route: entry.route });
      response = await fetch(target, { method: "POST", headers: { "X-API-KEY": apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body), signal, redirect: "error", ...(entry.dispatcher ? { dispatcher: entry.dispatcher } : {}) });
      if (!response.ok) {
        retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
        let exhausted = response.status === 402;
        if (response.status === 429 || response.status === 403) {
          try { exhausted ||= /(?:not enough|insufficient|exhausted).{0,30}credits|credits.{0,30}(?:exhausted|insufficient)|账户额度不足|余额不足/iu.test(await readTextLimited(response)); } catch {}
          if (exhausted) retryable = false;
        }
        const after = Number(response.headers.get("retry-after"));
        if (Number.isFinite(after) && after > 0) delay = Math.min(6000, Math.max(delay, after * 1000));
        const message = exhausted ? "Serper 账户额度不足，请管理员检查账户。"
          : [401, 403].includes(response.status) ? "Serper 拒绝了请求，请管理员检查密钥和账户额度。"
          : response.status === 429 ? "Serper 达到请求或额度限制，请稍后再试并检查账户额度。" : "Serper 搜索服务暂时出错，请稍后再试。";
        throw new SearchRequestError(message, { code: exhausted ? "SERPER_QUOTA" : `SERPER_HTTP_${response.status}` });
      }
      const payload = await readJsonLimited(response);
      recordModelDiagnostic("tools", { code: "SERPER_SUCCESS", phase: "serper_search", attempt, status: response.status, elapsedMs: Date.now()-started });
      return payload;
    } catch (error) {
      if (!(error instanceof SearchRequestError)) {
        retryable = true;
        finalError = new SearchRequestError("暂时无法连接 Serper 搜索服务，请稍后再试。", { code: signal.aborted ? "SERPER_TIMEOUT" : "SERPER_CONNECTION" });
      } else {
        finalError = error;
        if (["SEARCH_BODY_INTERRUPTED", "SEARCH_EMPTY", "SEARCH_INVALID_JSON"].includes(error.code)) retryable = true;
      }
      if (entry && (!response || response.status >= 500)) serperConnections.invalidate(entry);
      recordModelDiagnostic("tools", { code: finalError.code || "SERPER_FAILED", phase: "serper_search", attempt, status: response?.status, elapsedMs: Date.now()-started });
      if (!retryable || attempt === 3 || deadline.aborted) break;
      recordModelDiagnostic("tools", { code: "SERPER_RETRY", phase: "serper_search", attempt: attempt+1 });
    } finally { try { await response?.body?.cancel(); } catch {} }
    try { await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error("Search deadline")); };
      const timer = setTimeout(() => { deadline.removeEventListener("abort", abort); resolve(); }, delay);
      deadline.addEventListener("abort", abort, { once: true });
      if (deadline.aborted) abort();
    }); } catch { break; }
  }
  if (attempts > 1 && finalError) finalError.message += `（已自动重试${attempts-1}次）`;
  if (finalError) finalError.retryable = /^(?:SERPER_CONNECTION|SERPER_TIMEOUT|SERPER_HTTP_(?:408|429|500|502|503|504)|SEARCH_BODY_INTERRUPTED|SEARCH_EMPTY|SEARCH_INVALID_JSON)$/u.test(finalError.code);
  throw finalError ?? new SearchRequestError("Serper 搜索超时，请稍后再试。", { code: "SERPER_TIMEOUT" });
}

async function searchSerper({ apiKey, query, country, language, scope, timeRange, startDate, endDate }) {
  if (!apiKey) throw new SearchRequestError("Serper API key 尚未配置，请管理员在聊天设置的联网搜索来源中填写。");
  const sites = scope === "bilibili" ? ["bilibili.com"] : scope === "chinese_community" ? CHINESE_COMMUNITY_DOMAINS : [];
  const q = [query, sites.length ? `(${sites.map(domain => `site:${domain}`).join(" OR ")})` : "", startDate ? `after:${startDate}` : "", endDate ? `before:${new Date(Date.parse(endDate) + 86400000).toISOString().slice(0, 10)}` : ""].filter(Boolean).join(" ");
  const gl = ({ china: "cn", "united states": "us", "united kingdom": "gb", japan: "jp", singapore: "sg", taiwan: "tw", "hong kong": "hk" })[country] ?? (/^[a-z]{2}$/u.test(country ?? "") ? country : "cn");
  const hl = /^zh/iu.test(language ?? "") ? (/hant|tw|hk/iu.test(language) ? "zh-tw" : "zh-cn") : language || "zh-cn";
  const tbs = ({ day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" })[timeRange];
  const payload = await requestSerper(apiKey, { q, gl, hl, num: 10, ...(tbs ? { tbs } : {}) });
  const results = normalizeResults({ results: (Array.isArray(payload.organic) ? payload.organic : []).map(item => ({ title: item.title, url: item.link, content: item.snippet, published_date: item.date })) }, sites);
  return { results: results.map(item => ({ ...item, evidence: "search-snippet", ...(scope === "bilibili" ? { kind: "video" } : {}) })), provider: "serper", fallbackUsed: false };
}

export class SearchRequestError extends Error {
  constructor(message, { code = "SEARCH_ERROR" } = {}) {
    super(message);
    this.name = "SearchRequestError";
    this.code = code;
  }
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").trim().slice(0, maxLength);
}

function safeSourceUrl(value) {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if (url.href.length > 500) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function readTextLimited(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw new SearchRequestError("网页搜索服务返回内容过大，请稍后再试。", { code: "SEARCH_RESPONSE_TOO_LARGE" });
  }

  const reader = response.body?.getReader();
  if (!reader) throw new SearchRequestError("网页搜索服务暂时返回了空内容，请稍后再试。", { code: "SEARCH_EMPTY" });
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel();
        throw new SearchRequestError("网页搜索服务返回内容过大，请稍后再试。", { code: "SEARCH_RESPONSE_TOO_LARGE" });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function readJsonLimited(response) {
  try {
    return JSON.parse(await readTextLimited(response));
  } catch (error) {
    if (error instanceof SearchRequestError) throw error;
    throw new SearchRequestError("网页搜索服务返回了无法读取的内容，请稍后再试。", { code: error instanceof SyntaxError ? "SEARCH_INVALID_JSON" : "SEARCH_BODY_INTERRUPTED" });
  }
}

function normalizeResults(payload, allowedDomains = []) {
  if (!Array.isArray(payload?.results)) return [];
  const normalized = [];
  const seen = new Set();

  for (const result of payload.results) {
    if (!result || typeof result !== "object") continue;
    const url = safeSourceUrl(result.url);
    const content = cleanText(result.content, maxExcerptLength);
    if (!url || !content || seen.has(url)) continue;
    const hostname = new URL(url).hostname;
    if (allowedDomains.length && !allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) continue;
    seen.add(url);
    normalized.push({
      title: cleanText(result.title, 180) || new URL(url).hostname,
      url,
      content,
      ...(typeof result.published_date === "string" ? { publishedDate: cleanText(result.published_date, 80) } : {}),
    });
    if (normalized.length >= maxResults) break;
  }

  return normalized;
}

async function searchTavily({ apiKey, provider, query, country, language, scope = "general", timeRange, startDate, endDate }) {
  if (provider !== "tavily") throw new SearchRequestError("当前网页搜索服务配置无效，请管理员检查管理页设置。");
  if (!apiKey) throw new SearchRequestError("网页搜索 API key 尚未配置，请管理员在本机 .env 中设置 TAVILY_API_KEY。");
  const normalizedQuery = cleanText(query, 1000);
  if (!normalizedQuery) return { results: [] };

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        query: normalizedQuery,
        search_depth: "basic",
        topic: "general",
        max_results: maxResults,
        chunks_per_source: 2,
        include_answer: false,
        include_raw_content: false,
        include_published_date: true,
        ...(["day", "week", "month", "year"].includes(timeRange) || startDate || endDate ? { filter_by_published_date: true } : {}),
        ...(startDate ? { start_date: startDate } : {}),
        ...(endDate ? { end_date: endDate } : {}),
        ...(["day", "week", "month", "year"].includes(timeRange) ? { time_range: timeRange } : {}),
        ...(scope === "chinese_community" ? { include_domains: CHINESE_COMMUNITY_DOMAINS } : {}),
        ...(country ? { country } : {}),
        ...(language ? { language } : {}),
        safe_search: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new SearchRequestError("网页搜索超时了，请稍后再试。");
    }
    throw new SearchRequestError("暂时无法连接网页搜索服务，请稍后再试。");
  }

  if (!response.ok) {
    if (response.status === 401) throw new SearchRequestError("网页搜索服务拒绝了 API key，请管理员检查本机 .env 配置。");
    if (response.status === 429) throw new SearchRequestError("网页搜索服务请求过于频繁，请稍后再试。");
    if (response.status === 432 || response.status === 433) {
      throw new SearchRequestError("网页搜索服务额度已用完或达到计划上限，请管理员检查 Tavily 账户额度。");
    }
    if (response.status === 400 || response.status === 422) {
      throw new SearchRequestError("网页搜索请求参数未被服务接受，请管理员检查管理页中的地区和语言设置。");
    }
    throw new SearchRequestError("网页搜索服务暂时出错，请稍后再试。");
  }

  const payload = await readJsonLimited(response);
  return { results: normalizeResults(payload, scope === "chinese_community" ? CHINESE_COMMUNITY_DOMAINS : []) };
}

function plainText(value, maxLength = maxExcerptLength) {
  return cleanText(String(value ?? "").replace(/<[^>]*>/gu, " ")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gu, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " })[entity])
    .replace(/&#(x[0-9a-f]+|\d+);/giu, (_match, code) => {
      const point = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    }).replace(/\s+/gu, " "), maxLength);
}

async function searchBilibili(query) {
  const url = new URL("https://api.bilibili.com/x/web-interface/search/type");
  url.search = new URLSearchParams({ search_type: "video", keyword: query, page: "1", page_size: "20" });
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", accept: "application/json", referer: "https://search.bilibili.com/" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new SearchRequestError("B站视频搜索暂时不可用。");
  const payload = await readJsonLimited(response);
  if (payload?.code !== 0) throw new SearchRequestError("B站暂未接受这次搜索，请稍后再试。");
  const results = [];
  for (const video of Array.isArray(payload?.data?.result) ? payload.data.result : []) {
    if (typeof video.bvid !== "string" || !/^BV[a-zA-Z0-9]{10}$/u.test(video.bvid)) continue;
    const title = plainText(video.title, 180);
    if (!title) continue;
    results.push({
      title,
      url: `https://www.bilibili.com/video/${video.bvid}`,
      content: `视频检索信息（仅标题和简介，未观看视频）：UP主 ${plainText(video.author, 80)}；时长 ${plainText(video.duration, 30)}。${plainText(video.description, 1100)}`,
      kind: "video",
    });
    if (results.length >= maxResults) break;
  }
  return { results, provider: "bilibili" };
}

function parseMcpResponse(text) {
  const candidates = [text, ...text.split(/\r?\n\r?\n/u).map((event) => event.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n"))];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value?.id === 1) return value;
    } catch {}
  }
  throw new SearchRequestError("备用搜索返回格式暂时无法读取。");
}

async function searchExa(query, scope) {
  const response = await fetch("https://mcp.exa.ai/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "web_search_exa",
      arguments: { query: scope === "chinese_community" ? `${query} 中文社区 网梗` : query, numResults: maxResults, contextMaxCharacters: 8000 },
    } }),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new SearchRequestError("Exa 备用搜索暂时不可用或达到使用限额。");
  const payload = parseMcpResponse(await readTextLimited(response));
  if (payload.error || payload.result?.isError) throw new SearchRequestError("Exa 备用搜索暂未返回可用结果。");
  const text = (payload.result?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const entries = text.split(/(?=^Title:)/mu).map((block) => ({
    title: block.match(/^Title:\s*(.+)$/mu)?.[1],
    url: block.match(/^URL:\s*(\S+)/mu)?.[1],
    published_date: block.match(/^Published Date:\s*(.+)$/mu)?.[1],
    content: block.match(/^(?:Text|Content):\s*([\s\S]*)/mu)?.[1] ?? block,
  }));
  // Exa is a broader fallback; preserve provenance instead of claiming a strict domain scope.
  return { results: normalizeResults({ results: entries }), provider: "exa" };
}

// Independent providers: an unavailable Tavily key/service does not stop all search.
export async function searchWeb({ apiKey, provider = "tavily", query, country, language, scope = "general", timeRange, startDate, endDate }) {
  const normalizedQuery = cleanText(query, 400);
  if (!normalizedQuery) return { results: [], provider: "none", fallbackUsed: false };
  if([startDate,endDate].some(value=>value!==undefined&&!/^\d{4}-\d{2}-\d{2}$/u.test(value)))throw new SearchRequestError("搜索日期格式无效。");
  const cacheKey = JSON.stringify([provider, scope, normalizedQuery, country, language, Boolean(apiKey), timeRange, startDate, endDate]);
  const cached = resultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  // Serper mode is strict: no silent switch to Tavily, Exa or native Bilibili search.
  if (provider === "serper") {
    const value = await searchSerper({ apiKey, query: normalizedQuery, country, language, scope, timeRange, startDate, endDate });
    if (resultCache.size >= 100) resultCache.delete(resultCache.keys().next().value);
    resultCache.set(cacheKey, { expiresAt: Date.now() + cacheTtlMs, value });
    return value;
  }
  const providers = scope === "bilibili"
    ? [["bilibili", () => searchBilibili(normalizedQuery)]]
    : [
      ...(apiKey ? [["tavily", () => searchTavily({ apiKey, provider, query: normalizedQuery, country, language, scope, timeRange, startDate, endDate })]] : []),
      ["exa", () => searchExa(normalizedQuery, scope)],
      ["bilibili", () => searchBilibili(normalizedQuery)],
    ];
  let anyProviderReturned = false;
  for (const [name, run] of providers) {
    if ((providerCooldowns.get(name) ?? 0) > Date.now()) continue;
    try {
      const response = await run();
      providerCooldowns.delete(name);
      anyProviderReturned = true;
      if (!response.results.length) continue;
      const value = { ...response, provider: name, fallbackUsed: scope !== "bilibili" && name !== "tavily" };
      if (resultCache.size >= 100) resultCache.delete(resultCache.keys().next().value);
      resultCache.set(cacheKey, { expiresAt: Date.now() + cacheTtlMs, value });
      return value;
    } catch {
      // Avoid repeatedly waiting for the same failed provider; never log keys or queries.
      providerCooldowns.set(name, Date.now() + 60_000);
    }
  }
  if (anyProviderReturned) return { results: [], provider: "none", fallbackUsed: true };
  throw new SearchRequestError("这次网页和备用搜索都暂时不可用，请稍后再试。");
}
