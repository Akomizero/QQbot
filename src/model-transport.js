import { createModelConnectionPool } from "./model-connection-pool.js";
import { withModelOperation, recordModelDiagnostic } from "./model-diagnostics.js";

const retryableCodes = new Set(["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
let requestSequence = 0;
const connections = createModelConnectionPool();
export const closeModelConnections = () => connections.close();
const logTime = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ") + " +08:00";

export async function fetchModel(endpoint, options) {
  return withModelOperation(() => fetchModelInternal(endpoint, options));
}

async function fetchModelInternal(endpoint, { modelRetries = true, modelAttempt = 1, ...options }) {
  const requestId = ++requestSequence;
  const attempts = modelRetries ? 3 : 1;
  const firstAttempt = Number.isInteger(modelAttempt) && modelAttempt > 0 && modelAttempt < 100 ? modelAttempt : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const startedAt = Date.now();
    const { entry, reused } = await connections.acquire(endpoint, { attempt: firstAttempt + attempt, signal: options.signal });
    const { dispatcher, route } = entry;
    try {
      recordModelDiagnostic("start", { attempt: firstAttempt + attempt, route, connection: entry.id, reused: reused ? 1 : 0 });
      const response = await fetch(endpoint, { ...options, ...(dispatcher ? { dispatcher } : {}) });
      recordModelDiagnostic("http", { attempt: firstAttempt + attempt, route, status: response.status, elapsedMs: Date.now() - startedAt });
      if ([500, 502, 503, 504].includes(response.status)) connections.invalidate(entry);
      if ([500, 502, 503, 504].includes(response.status) && attempt < attempts - 1 && !options.signal?.aborted) {
        await response.body?.cancel();
        console.warn(`${logTime()} 模型请求 ${requestId}（第${firstAttempt + attempt}次）HTTP ${response.status}，稍后重试。`);
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1000 : 4000));
        continue;
      }
      return response;
    }
    catch (error) {
      connections.invalidate(entry);
      const rawCode = error?.cause?.code ?? error?.cause?.errors?.[0]?.code ?? error?.code;
      const code = retryableCodes.has(rawCode) ? rawCode : "FETCH_FAILED";
      const retry = attempt < attempts - 1 && retryableCodes.has(code) && !options.signal?.aborted;
      const timeout = options.signal?.aborted || error?.name === "TimeoutError";
      const tlsHandshake = /before secure TLS connection|TLS handshake/iu.test(String(error?.cause?.message ?? ""));
      const phase = timeout ? "timeout" : tlsHandshake || /CERT|TLS|SSL/u.test(String(rawCode)) ? "tls" : /EAI_|ENOTFOUND/u.test(String(rawCode)) ? "dns" : "connect";
      recordModelDiagnostic("transport", { code: timeout ? "TIMEOUT" : code, phase, route, attempt: firstAttempt + attempt, elapsedMs: Date.now() - startedAt });
      // Log only a fixed error code, never URLs, headers, keys, image data or prompts.
      console.warn(`${logTime()} 模型请求 ${requestId}（第${firstAttempt + attempt}次）连接失败：${code}，耗时${Date.now() - startedAt}ms${retry ? "，稍后重试。" : "。"}`);
      if (!retry) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1000 : 4000));
    }
  }
}
