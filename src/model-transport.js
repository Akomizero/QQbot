import { createModelConnectionPool } from "./model-connection-pool.js";
import { withModelOperation, recordModelDiagnostic } from "./model-diagnostics.js";

const retryableCodes = new Set(["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
const maxAttempts = 2;
const maxRetryDelayMs = 15_000;
let requestSequence = 0;
const connections = createModelConnectionPool();
export const closeModelConnections = () => connections.close();
const logTime = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ") + " +08:00";

function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : null;
}

function statusRetryDelay(response, attempt) {
  if (response.status === 429) {
    const requested = retryAfterMs(response.headers.get("retry-after"));
    if (requested === null) return 1000;
    // If the provider asks for a longer wait than this request budget permits,
    // return its 429 rather than retrying earlier than requested.
    return requested <= maxRetryDelayMs ? Math.max(1000, requested) : null;
  }
  return attempt === 0 ? 1000 : 4000;
}

function waitForRetry(delayMs, signal) {
  signal?.throwIfAborted();
  if (!signal) return new Promise(resolve => setTimeout(resolve, delayMs));
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer); cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    timer = setTimeout(() => { cleanup(); resolve(); }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function fetchModel(endpoint, options) {
  return withModelOperation(() => fetchModelInternal(endpoint, options));
}

async function fetchModelInternal(endpoint, { modelRetries = true, modelAttempt = 1, ...options }) {
  const requestId = ++requestSequence;
  const attempts = modelRetries ? maxAttempts : 1;
  const firstAttempt = Number.isInteger(modelAttempt) && modelAttempt > 0 && modelAttempt < 100 ? modelAttempt : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const startedAt = Date.now();
    let entry, route = "unknown";
    try {
      const acquired = await connections.acquire(endpoint, { attempt: firstAttempt + attempt, signal: options.signal });
      ({ entry } = acquired);
      const { dispatcher } = entry;
      route = entry.route ?? "direct";
      recordModelDiagnostic("start", { attempt: firstAttempt + attempt, route, connection: entry.id, reused: acquired.reused ? 1 : 0 });
      const response = await fetch(endpoint, { ...options, ...(dispatcher ? { dispatcher } : {}) });
      recordModelDiagnostic("http", { attempt: firstAttempt + attempt, route, status: response.status, elapsedMs: Date.now() - startedAt });
      if ([408, 500, 502, 503, 504].includes(response.status)) connections.invalidate(entry);
      if (retryableStatuses.has(response.status) && attempt < attempts - 1 && !options.signal?.aborted) {
        const delayMs = statusRetryDelay(response, attempt);
        if (delayMs === null) return response;
        await response.body?.cancel().catch(() => {});
        recordModelDiagnostic("retry", { code: `HTTP_${response.status}`, attempt: firstAttempt + attempt });
        console.warn(`${logTime()} 模型请求 ${requestId}（第${firstAttempt + attempt}次）HTTP ${response.status}，稍后重试。`);
        try { await waitForRetry(delayMs, options.signal); }
        catch (waitError) {
          if (options.signal?.aborted) recordModelDiagnostic("transport", { code: "TIMEOUT", phase: "timeout", route, attempt: firstAttempt + attempt, elapsedMs: Date.now() - startedAt });
          throw waitError;
        }
        continue;
      }
      return response;
    }
    catch (error) {
      connections.invalidate(entry);
      const rawCode = error?.cause?.code ?? error?.cause?.errors?.[0]?.code ?? error?.code;
      const timeout = options.signal?.aborted || error?.name === "TimeoutError";
      const code = timeout ? "TIMEOUT" : retryableCodes.has(rawCode) ? rawCode : entry ? "FETCH_FAILED" : "POOL_SETUP_FAILED";
      const retry = attempt < attempts - 1 && retryableCodes.has(rawCode) && !options.signal?.aborted;
      const tlsHandshake = /before secure TLS connection|TLS handshake/iu.test(String(error?.cause?.message ?? ""));
      const phase = timeout ? "timeout" : tlsHandshake || /CERT|TLS|SSL/u.test(String(rawCode)) ? "tls" : /EAI_|ENOTFOUND/u.test(String(rawCode)) ? "dns" : "connect";
      recordModelDiagnostic("transport", { code, phase, route, attempt: firstAttempt + attempt, elapsedMs: Date.now() - startedAt });
      // Log only a fixed error code, never URLs, headers, keys, image data or prompts.
      console.warn(`${logTime()} 模型请求 ${requestId}（第${firstAttempt + attempt}次）连接失败：${code}，耗时${Date.now() - startedAt}ms${retry ? "，稍后重试。" : "。"}`);
      if (!retry) throw error;
      try { await waitForRetry(attempt === 0 ? 1000 : 4000, options.signal); }
      catch (waitError) {
        if (options.signal?.aborted) recordModelDiagnostic("transport", { code: "TIMEOUT", phase: "timeout", route, attempt: firstAttempt + attempt, elapsedMs: Date.now() - startedAt });
        throw waitError;
      }
    }
  }
}
