import "./network-proxy.js";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getLlmApiKey, getSearchApiKey, loadEnvironment, updateLlmApiKey, updateSerperApiKey, updateTavilyApiKey, validateLlmApiKey } from "./config.js";
import {
  clearAdminSession,
  getAdminAuthState,
  isAdminAuthenticated,
  setAdminSession,
  setupAdminPassword,
  verifyAdminPassword,
} from "./admin-auth.js";
import { readAccessControl, writeAccessControl } from "./access-control-store.js";
import { readCommands, writeCommands } from "./command-store.js";
import { readLlmSettings, writeLlmSettings } from "./llm-settings-store.js";
import { ensureGroupPersonas, saveGroupPersona, personaFields, settingsForGroup } from "./group-personas.js";
import { searchKnowledge, knowledgeRevision, readScopedKnowledge, writeScopedKnowledge } from "./knowledge-base.js";
import { addSticker, deleteSticker, listStickers, readSticker, updateSticker } from "./sticker-store.js";
import { queueStickerDescription, stickerLearningStatus } from "./sticker-learning.js";
import { getKnowledgeLearningStatus, requestDialogueLearning } from "./knowledge-learning.js";
import { readPrivacyHitCounters } from './privacy-hit-counters.js';
import { readModelDiagnostics } from "./model-diagnostics.js";
import { readReplyRecoveryStatus } from "./reply-recovery.js";
import { readChatGptImageStatus } from "./chatgpt-imagegen.js";
import { readVideoDiscoveryStatus } from "./video-discovery.js";
import { readStickerPreferences, saveStickerPreferences } from "./sticker-preferences.js";
import { readMemberImpressions, saveMemberImpression, forgetMemberImpression } from "./member-impressions.js";
import { readVisualMemories, editVisualMemory, usableVisualReferences } from "./visual-memory-store.js";
import { visualLearningStatus } from "./visual-learning.js";
import { memoryMaintenanceSummary, maintainGroupMemory } from "./memory-maintenance.js";
import { readPersonalityGrowth, controlPersonalityGrowth, personalityGrowthBaseline } from "./personality-growth.js";

const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
const maxBodyBytes = 256 * 1024;
const loopbackHosts = new Set(["127.0.0.1", "localhost"]);

function knowledgeScope(value, { useDefault = false } = {}) {
  const groups = readAccessControl().groupIds;
  if (value === undefined && useDefault) return groups[0] ?? null;
  if (value === null || value === "private") return null;
  if (typeof value !== "string" || !/^\d{1,32}$/u.test(value)) throw Object.assign(new Error("请先选择知识库所属群。"), { statusCode: 400 });
  if (!groups.includes(value)) throw Object.assign(new Error("这个群不在授权范围内。"), { statusCode: 404 });
  return value;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request, byteLimit = maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > byteLimit) throw Object.assign(new Error("请求内容过大。"), { statusCode: 413 });
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("请求内容不是有效的 JSON。"), { statusCode: 400 });
  }
}

async function readJsonResponseLimited(response, maxBytes = 1024 * 1024) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("Model list response too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Model list response is empty");
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("Model list response too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizeModelIds(payload) {
  if (!Array.isArray(payload?.data)) return [];
  const ids = [];
  const seen = new Set();
  for (const item of payload.data) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!id || id.length > 120 || /[\u0000-\u001f\u007f]/u.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 500) break;
  }
  return ids;
}

function isLoopbackRequest(request, port) {
  let parsedHost;
  try {
    parsedHost = new URL(`http://${request.headers.host}`);
  } catch {
    return false;
  }
  if (
    !loopbackHosts.has(parsedHost.hostname)
    || parsedHost.username
    || parsedHost.password
    || parsedHost.pathname !== "/"
    || parsedHost.search
    || parsedHost.hash
    || (parsedHost.port || "80") !== String(port)
  ) return false;

  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:"
      && !parsed.username
      && !parsed.password
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash
      && loopbackHosts.has(parsed.hostname)
      && (parsed.port || "80") === String(port);
  } catch {
    return false;
  }
}

function applySecurityHeaders(response) {
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

export async function startManagementServer({
  getOneBotStatus = () => ({ connected: false }),
  onLlmSettingsSaved,
  onGroupPersonaSaved,
  onMemberImpressionChanged,
} = {}) {
  loadEnvironment();
  const rawPort = process.env.QQBOT_WEB_PORT?.trim() || "3000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("QQBOT_WEB_PORT 必须是 1 到 65535 之间的端口号。");
  }

  const server = createServer(async (request, response) => {
    applySecurityHeaders(response);
    if (!isLoopbackRequest(request, port)) {
      sendJson(response, 403, { error: "管理面板只允许从本机访问。" });
      return;
    }

    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/api/auth/state") {
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "此接口只支持 GET。" });
        return;
      }
      try {
        sendJson(response, 200, getAdminAuthState(request));
      } catch {
        sendJson(response, 500, { error: "无法读取本机管理员凭据状态。" });
      }
      return;
    }

    if (url.pathname === "/api/auth/setup") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "此接口只支持 POST。" });
        return;
      }
      try {
        const body = await readJsonBody(request);
        const result = await setupAdminPassword(request, body?.password);
        if (result.ok) {
          setAdminSession(response, result.record);
          sendJson(response, 201, { authenticated: true });
        } else if (result.limited) {
          const retryAfter = result.retryAfter ?? 900;
          response.setHeader("retry-after", String(retryAfter));
          sendJson(response, 429, { error: "尝试次数过多，请稍后再试。" });
        } else if (result.alreadyConfigured) {
          sendJson(response, 409, { error: "管理员密码已设置，请登录。" });
        } else if (result.setupBusy) {
          sendJson(response, 409, { error: "检测到管理员初始化锁。确认所有该项目实例均已停止后，按 README 手动清除残锁，再刷新页面重试。" });
        } else {
          sendJson(response, 400, { error: "管理员密码至少需要 12 个字符，最多 256 个字符。" });
        }
      } catch (error) {
        if (error.code === "ADMIN_SETUP_LOCK_WRITE") {
          sendJson(response, 409, { error: "管理员初始化锁写入失败。确认所有该项目实例均已停止后，按 README 手动清除残锁，再刷新页面重试。" });
        } else {
          sendJson(response, error.statusCode ?? 500, {
            error: error.statusCode ? error.message : "无法保存本机管理员凭据。",
          });
        }
      }
      return;
    }

    if (url.pathname === "/api/auth/login") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "此接口只支持 POST。" });
        return;
      }
      try {
        const body = await readJsonBody(request);
        const result = await verifyAdminPassword(request, body?.password);
        if (result.ok) {
          setAdminSession(response, result.record);
          sendJson(response, 200, { authenticated: true });
        } else if (result.setupRequired) {
          sendJson(response, 409, { setupRequired: true, error: "请先设置管理员密码。" });
        } else if (result.limited) {
          const retryAfter = result.retryAfter ?? 900;
          response.setHeader("retry-after", String(retryAfter));
          sendJson(response, 429, { error: "尝试次数过多，请稍后再试。" });
        } else {
          sendJson(response, 401, { error: "密码不正确。" });
        }
      } catch (error) {
        sendJson(response, error.statusCode ?? 500, {
          error: error.statusCode ? error.message : "无法验证管理员密码。",
        });
      }
      return;
    }

    if (url.pathname === "/api/auth/logout") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "此接口只支持 POST。" });
        return;
      }
      clearAdminSession(response);
      sendJson(response, 200, { authenticated: false });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      let authenticated = false;
      try { authenticated = isAdminAuthenticated(request); } catch {
        sendJson(response, 500, { error: "无法验证本机管理员会话。" });
        return;
      }
      if (!authenticated) {
        sendJson(response, 401, { error: "请先登录管理面板。" });
        return;
      }
    }

    if(url.pathname==='/api/privacy-hit-counters'){
      if(request.method!=='GET'){sendJson(response,405,{error:'此接口只支持 GET。'});return;}
      sendJson(response,200,readPrivacyHitCounters());return;
    }
    if (url.pathname === "/api/model-diagnostics" && request.method === "GET") {
      sendJson(response, 200, { events: readModelDiagnostics() }); return;
    }
    if (url.pathname === "/api/member-impressions" || url.pathname === "/api/member-impressions/learn") {
      try {
        const groups = readAccessControl().groupIds;
        if (request.method === "GET" && url.pathname === "/api/member-impressions") {
          if (!groups.length) { sendJson(response, 200, { groups, groupId: null, members: [], revision: null, learning: null }); return; }
          const groupId = knowledgeScope(url.searchParams.get("groupId") ?? groups[0]);
          if (!groupId) throw new Error("请选择成员印象所属群。");
          const impressions = readMemberImpressions(groupId);
          const lastMemberSavedAt = Math.max(0, ...impressions.members.flatMap(member => member.facts.map(fact => fact.updatedAt ?? 0)));
          sendJson(response, 200, { groups, ...impressions, maintenance: memoryMaintenanceSummary(groupId), learning: {
            ...(getKnowledgeLearningStatus().groups.find(state => state.groupId === groupId) ?? {}), lastMemberSavedAt: lastMemberSavedAt || null,
          } }); return;
        }
        const body = await readJsonBody(request, 2 * 1024 * 1024), groupId = knowledgeScope(body?.groupId);
        if (!groupId) throw new Error("成员印象仅用于群聊，请选择一个群。");
        if (request.method === "POST" && url.pathname.endsWith("/learn")) {
          sendJson(response, 202, requestDialogueLearning(groupId)); return;
        }
        if (url.pathname.endsWith("/learn") || !["PUT", "DELETE"].includes(request.method)) { sendJson(response, 405, { error: "成员印象支持GET、PUT和DELETE。" }); return; }
        if (typeof body?.revision !== "string") throw new Error("缺少修订号，请刷新后再保存。");
        const result = request.method === "DELETE" ? forgetMemberImpression(groupId, body?.userId, body?.revision)
          : saveMemberImpression(groupId, body?.userId, body?.profile, body?.revision);
        try { onMemberImpressionChanged?.(groupId, body.userId); } catch {}
        sendJson(response, 200, { groups, ...result, message: request.method === "DELETE" ? "已清除此成员印象，并暂停继续积累。" : "本群此成员的印象已保存。" });
      } catch (error) { sendJson(response, error.statusCode ?? 400, { error: error.code ? "成员印象文件操作失败。" : error.message }); }
      return;
    }
    if (url.pathname === "/api/sticker-preferences") {
      try {
        if (request.method === "GET") {
          const groups = readAccessControl().groupIds;
          if (!groups.length) { sendJson(response, 200, { groups, groupId: null, rules: [], revision: null }); return; }
          const groupId = knowledgeScope(url.searchParams.get("groupId") ?? groups[0]);
          if (groupId === null) throw new Error("请选择一个群。");
          sendJson(response, 200, { groups, groupId, ...readStickerPreferences(groupId) }); return;
        }
        if (request.method === "PUT") {
          const body = await readJsonBody(request);
          const groupId = knowledgeScope(body?.groupId);
          if (groupId === null) throw new Error("请选择一个群。");
          sendJson(response, 200, { groupId, ...saveStickerPreferences(groupId, body?.rules, body?.revision) }); return;
        }
        sendJson(response, 405, { error: "此接口只支持GET和PUT。" });
      } catch (error) { sendJson(response, error.statusCode ?? 400, { error: error.code ? "无法保存表情偏好。" : error.message }); }
      return;
    }
    if (url.pathname === "/api/onebot-status") {
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "此接口只支持 GET。" });
        return;
      }
      try {
        sendJson(response, 200, { status: getOneBotStatus() });
      } catch {
        sendJson(response, 200, { status: { connected: false } });
      }
      return;
    }

    if (url.pathname === "/api/llm-models") {
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "此接口只支持 GET。" });
        return;
      }
      const apiKey = getLlmApiKey();
      if (!apiKey) {
        sendJson(response, 409, { error: "服务端模型 API key 未配置，无法刷新模型列表。" });
        return;
      }
      try {
        const settings = readLlmSettings();
        const endpoint = new URL(settings.apiEndpoint);
        endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions\/?$/u, "/models");
        const modelResponse = await fetch(endpoint, {
          method: "GET",
          headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        });
        if (!modelResponse.ok) {
          sendJson(response, 502, {
            error: modelResponse.status === 401 || modelResponse.status === 403
              ? "模型服务拒绝了服务端 API key，无法读取模型列表。"
              : `模型服务未能返回模型列表（HTTP ${modelResponse.status}）。`,
          });
          return;
        }
        const payload = await readJsonResponseLimited(modelResponse);
        sendJson(response, 200, { models: normalizeModelIds(payload) });
      } catch {
        sendJson(response, 502, { error: "无法读取模型列表，请检查接口服务和网络后重试。" });
      }
      return;
    }

    if (url.pathname === "/api/personality-growth") {
      try {
        if (!["GET", "POST"].includes(request.method)) { sendJson(response, 405, { error: "成长记录支持GET和POST。" }); return; }
        const body = request.method === "POST" ? await readJsonBody(request) : null;
        const groupId = knowledgeScope(request.method === "GET" ? url.searchParams.get("groupId") : body?.groupId);
        if (!groupId) throw new Error("性格成长仅用于授权群，请选择一个群。");
        const baseline = personalityGrowthBaseline(settingsForGroup(readLlmSettings(), groupId));
        const growth = request.method === "GET" ? readPersonalityGrowth(groupId, baseline) : controlPersonalityGrowth(groupId, body, baseline);
        const state = getKnowledgeLearningStatus().groups.find(state => state.groupId === groupId);
        sendJson(response, 200, { growth, learning: { outcome: state?.lastGrowthOutcome ?? "waiting", buffered: state?.bufferedGrowthMessages ?? 0, lastCount: state?.lastGrowthFeedbackCount ?? 0 },
          message: "本群成长设置已保存，下一次组织回复起生效。" });
      } catch (error) { sendJson(response, error.statusCode ?? 400, { error: error.code ? "无法访问本群成长记录。" : error.message }); }
      return;
    }

    if (url.pathname === "/api/group-personas" && request.method === "GET") {
      try {
        const defaults = readLlmSettings();
        const groups = readAccessControl().groupIds;
        sendJson(response, 200, { profiles: ensureGroupPersonas(groups, defaults), defaults: personaFields(defaults) });
      } catch { sendJson(response, 500, { error: "无法读取分群人设，请检查本机配置。" }); }
      return;
    }
    if (/^\/api\/group-personas\/\d{1,32}$/u.test(url.pathname)) {
      if (request.method !== "PUT") { sendJson(response, 405, { error: "此接口只支持PUT。" }); return; }
      try {
        const body = await readJsonBody(request);
        const groupId = url.pathname.split("/")[3];
        const profile = saveGroupPersona(groupId, body?.profile, body?.revision, readAccessControl().groupIds);
        try { onGroupPersonaSaved?.(groupId); } catch {}
        sendJson(response, 200, { profile, message: "这个群的人设已保存，下一条回复起生效。" });
      } catch (error) { sendJson(response, error.statusCode ?? (error.code ? 500 : 400), { error: error.code ? "保存群人设失败。" : error.message }); }
      return;
    }

    if (url.pathname === "/api/access-control") {
      if (request.method === "GET") {
        try {
          sendJson(response, 200, { accessControl: readAccessControl() });
        } catch (error) {
          sendJson(response, 500, { error: error.message ?? "读取接收白名单失败。" });
        }
        return;
      }

      if (request.method === "PUT") {
        try {
          const body = await readJsonBody(request);
          if (!body || !body.accessControl || typeof body.accessControl !== "object" || Array.isArray(body.accessControl)) {
            sendJson(response, 400, { error: "请求中缺少 accessControl 对象。" });
            return;
          }
          const previousAccess = readAccessControl();
          const accessControl = writeAccessControl(body.accessControl);
          try { ensureGroupPersonas(accessControl.groupIds, readLlmSettings()); }
          catch (error) { writeAccessControl(previousAccess); throw error; }
          sendJson(response, 200, { accessControl, message: "接收白名单已保存，立即生效。" });
        } catch (error) {
          sendJson(response, error.statusCode ?? 400, { error: error.message ?? "保存接收白名单失败。" });
        }
        return;
      }

      sendJson(response, 405, { error: "此接口只支持 GET 和 PUT。" });
      return;
    }

    if (url.pathname === "/api/commands") {
      if (request.method === "GET") {
        try {
          sendJson(response, 200, { commands: readCommands() });
        } catch (error) {
          sendJson(response, 500, { error: error.message ?? "读取指令配置失败。" });
        }
        return;
      }

      if (request.method === "PUT") {
        try {
          const body = await readJsonBody(request);
          if (!body || !Array.isArray(body.commands)) {
            sendJson(response, 400, { error: "请求中缺少 commands 数组。" });
            return;
          }
          const commands = writeCommands(body.commands);
          sendJson(response, 200, { commands, message: "已保存，机器人会立即使用新配置。" });
        } catch (error) {
          sendJson(response, error.statusCode ?? 400, { error: error.message ?? "保存指令配置失败。" });
        }
        return;
      }

      sendJson(response, 405, { error: "此接口只支持 GET 和 PUT。" });
      return;
    }

    if (url.pathname === "/api/visual-memory") {
      try {
        const body = request.method === "GET" ? null : await readJsonBody(request);
        const requested = request.method === "GET" ? url.searchParams.get("groupId") : body?.groupId;
        const groupId = requested === "global" ? null : knowledgeScope(requested ?? undefined, { useDefault: true });
        if (request.method === "GET") {
          const usableIds=new Set(usableVisualReferences(groupId).map(entry=>entry.id));
          sendJson(response, 200, { ...readVisualMemories(groupId), groupId, groups: readAccessControl().groupIds,
            workflow: "provisional-conflict-review-v1",
            sharedReferences: groupId === null ? [] : readVisualMemories(null).entries.filter(entry => entry.status === "confirmed")
              .map(entry=>({...entry,suspendedInGroup:!usableIds.has(entry.id)})),
            learningEnabled: readLlmSettings().visualMemoryLearningEnabled, learning: visualLearningStatus(groupId) });
        }
        else if (["PUT", "DELETE"].includes(request.method)) sendJson(response, 200, { ...editVisualMemory(groupId, body?.entry ?? {}, body?.revision, request.method === "DELETE"), groupId, message: "角色视觉记忆已保存，下一次识图生效。" });
        else sendJson(response, 405, { error: "接口方法不支持。" });
      } catch (error) { sendJson(response, error.statusCode ?? 400, { error: error.code ? "无法访问视觉记忆。" : error.message }); }
      return;
    }

    if (url.pathname === "/api/memory-maintenance") {
      try {
        if (!["GET", "POST"].includes(request.method)) { sendJson(response, 405, { error: "记忆维护支持GET和POST。" }); return; }
        const body = request.method === "POST" ? await readJsonBody(request) : null;
        const groupId = knowledgeScope(request.method === "GET" ? url.searchParams.get("groupId") : body?.groupId);
        if (!groupId) throw new Error("请选择一个群，私聊资料不参与群记忆维护。");
        if (request.method === "POST" && typeof body?.revision !== "string") throw new Error("缺少记忆修订号，请刷新后重试。");
        const maintenance = request.method === "GET" ? memoryMaintenanceSummary(groupId) : maintainGroupMemory(groupId, body.revision);
        sendJson(response, 200, { maintenance, message: "本群记忆已整理；重复和长期未获支持的自动条目保留在归档，不调用模型、不发送群消息。" });
      } catch (error) { sendJson(response, error.statusCode ?? 400, { error: error.code ? "无法维护本群记忆，请检查本机资料文件。" : error.message }); }
      return;
    }

    if (url.pathname === "/api/knowledge") {
      if (request.method === "GET") {
        try {
          const groupId = knowledgeScope(url.searchParams.has("groupId") ? url.searchParams.get("groupId") : undefined, { useDefault: true });
          const entries = readScopedKnowledge(groupId);
          sendJson(response, 200, { groupId, groups: readAccessControl().groupIds, entries, revision: knowledgeRevision(entries), maintenance: groupId ? memoryMaintenanceSummary(groupId) : null,
            learning: { groups: getKnowledgeLearningStatus().groups.filter((state) => state.groupId === groupId) }, oneBotConnected: Boolean(getOneBotStatus?.().connected) });
        }
        catch (error) { sendJson(response, error.statusCode ?? 500, { error: error.statusCode ? error.message : "无法读取本地知识库，请检查本机知识库文件。" }); }
        return;
      }
      if (request.method === "PUT") {
        try {
          const body = await readJsonBody(request, 2 * 1024 * 1024);
          const groupId = knowledgeScope(body?.groupId);
          const entries = writeScopedKnowledge(groupId, body?.entries, body?.revision);
          sendJson(response, 200, { groupId, entries, revision: knowledgeRevision(entries), message: "当前知识库已保存，不影响其他群；下一条消息起生效。" });
        } catch (error) {
          sendJson(response, error.statusCode ?? (error.code ? 500 : 400), { error: error.code ? "无法保存本地知识库。" : error.message });
        }
        return;
      }
      sendJson(response, 405, { error: "此接口只支持 GET 和 PUT。" });
      return;
    }

    if (url.pathname === "/api/knowledge/learn" && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        const groupId = knowledgeScope(body?.groupId);
        if (groupId === null) { sendJson(response, 400, { error: "私聊资料由管理员手动维护，请选择一个群进行提炼。" }); return; }
        sendJson(response, 202, requestDialogueLearning(groupId));
      } catch (error) { sendJson(response, error.statusCode ?? 400, { error: error.message ?? "无法安排当前群的提炼。" }); }
      return;
    }

    if (url.pathname === "/api/knowledge/search") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "此接口只支持 POST。" });
        return;
      }
      try {
        const body = await readJsonBody(request);
        if (typeof body?.query !== "string" || !body.query.trim() || body.query.length > 1000) {
          sendJson(response, 400, { error: "请输入 1 到 1000 个字符的检索问题。" });
          return;
        }
        const groupId = knowledgeScope(body?.groupId);
        sendJson(response, 200, { groupId, results: searchKnowledge(body.query, { groupId }) });
      } catch (error) {
        sendJson(response, error.statusCode ?? 500, { error: error.statusCode ? error.message : "本地知识检索失败。" });
      }
      return;
    }

    if (url.pathname === "/api/stickers" || /^\/api\/stickers\/[a-f\d-]{36}(?:\/image)?$/u.test(url.pathname)) {
      const id = url.pathname.split("/")[3];
      try {
        if (request.method === "GET" && !id) { sendJson(response, 200, { stickers: listStickers(), learning: stickerLearningStatus() }); return; }
        if (request.method === "GET" && url.pathname.endsWith("/image")) {
          const sticker = readSticker(id, { approvedOnly: true });
          if (!sticker) { sendJson(response, 404, { error: "表情不存在。" }); return; }
          response.writeHead(200, { "content-type": sticker.mime, "cache-control": "no-store", "x-content-type-options": "nosniff" });
          response.end(sticker.bytes);
          return;
        }
        if (request.method === "POST" && !id) {
          const sticker = await addSticker(await readJsonBody(request, 30 * 1024 * 1024));
          if (sticker.needsDescription) queueStickerDescription(sticker.id);
          sendJson(response, 201, { sticker }); return;
        }
        if (request.method === "PUT" && id && !url.pathname.endsWith("/image")) {
          const sticker = updateSticker(id, await readJsonBody(request));
          if (sticker.needsDescription) queueStickerDescription(id);
          sendJson(response, 200, { sticker }); return;
        }
        if (request.method === "DELETE" && id && !url.pathname.endsWith("/image")) { deleteSticker(id); sendJson(response, 200, { deleted: true }); return; }
        sendJson(response, 405, { error: "此表情接口不支持该操作。" });
      } catch (error) { sendJson(response, error.statusCode ?? 400, { error: error.code ? "表情文件操作失败。" : error.message }); }
      return;
    }

    if (url.pathname === "/api/video-discovery" && request.method === "GET") {
      try { sendJson(response, 200, { status: readVideoDiscoveryStatus() }); }
      catch { sendJson(response, 500, { error: "读取自主浏览视频状态失败。" }); }
      return;
    }

    if (url.pathname === "/api/chatgpt-imagegen" && request.method === "GET") {
      try { sendJson(response, 200, { status: await readChatGptImageStatus() }); }
      catch { sendJson(response, 500, { error: "读取网页生图状态失败。" }); }
      return;
    }

    if (url.pathname === "/api/reply-recovery" && request.method === "GET") {
      try { sendJson(response, 200, { status: readReplyRecoveryStatus() }); }
      catch { sendJson(response, 500, { error: "读取后台补发状态失败。" }); }
      return;
    }

    if (url.pathname === "/api/features" && request.method === "PATCH") {
      try {
        const body = await readJsonBody(request);
        const allowed = ["knowledgeEnabled", "knowledgeLearningEnabled", "memberImpressionsEnabled", "memberImpressionsLearningEnabled", "stickersEnabled", "stickerLearningEnabled", "visualMemoryLearningEnabled"];
        if (!body || !Object.keys(body).length || Object.entries(body).some(([key, value]) => !allowed.includes(key) || typeof value !== "boolean")) {
          sendJson(response, 400, { error: "功能开关格式不正确。" }); return;
        }
        const settings = writeLlmSettings({ ...readLlmSettings(), ...body });
        onLlmSettingsSaved?.(settings);
        sendJson(response, 200, { settings });
      } catch { sendJson(response, 400, { error: "保存功能开关失败。" }); }
      return;
    }

    if (url.pathname === "/api/llm-settings") {
      if (request.method === "GET") {
        try {
          sendJson(response, 200, {
            settings: readLlmSettings(),
            apiKeyConfigured: Boolean(getLlmApiKey()),
            searchApiKeyConfigured: Boolean(getSearchApiKey()),
            serperApiKeyConfigured: Boolean(getSearchApiKey("serper")),
          });
        } catch (error) {
          sendJson(response, 500, { error: error.message ?? "读取模型设置失败。" });
        }
        return;
      }

      if (request.method === "PUT") {
        try {
          const body = await readJsonBody(request);
          if (!body || !body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) {
            sendJson(response, 400, { error: "请求中缺少 settings 对象。" });
            return;
          }

          let keyAction = "none";
          let requestedApiKey;
          if (body.clearApiKey === true) {
            if (body.apiKey !== undefined && body.apiKey !== "") {
              sendJson(response, 400, { error: "清除 API key 时不能同时提交新 key。" });
              return;
            }
            keyAction = "clear";
          } else if (body.apiKey !== undefined) {
            if (typeof body.apiKey !== "string") {
              sendJson(response, 400, { error: "新 API key 格式不正确。" });
              return;
            }
            if (body.apiKey.trim()) {
              requestedApiKey = validateLlmApiKey(body.apiKey.trim());
              keyAction = "set";
            }
          }

          if (body.clearSerperApiKey === true && body.serperApiKey) throw new Error("不能同时清除并填写 Serper key。");
          if (body.clearTavilyApiKey === true && body.tavilyApiKey) throw new Error("不能同时清除并填写 Tavily key。");
          const serperKey = body.serperApiKey === undefined || body.serperApiKey === "" ? undefined : validateLlmApiKey(body.serperApiKey);
          const tavilyKey = body.tavilyApiKey === undefined || body.tavilyApiKey === "" ? undefined : validateLlmApiKey(body.tavilyApiKey);
          const settings = writeLlmSettings({ ...readLlmSettings(), ...body.settings });
          if (body.clearSerperApiKey === true) updateSerperApiKey(null);
          else if (serperKey !== undefined) updateSerperApiKey(serperKey);
          if (body.clearTavilyApiKey === true) updateTavilyApiKey(null);
          else if (tavilyKey !== undefined) updateTavilyApiKey(tavilyKey);
          if (keyAction === "clear") updateLlmApiKey(null);
          if (keyAction === "set") updateLlmApiKey(requestedApiKey);
          try { onLlmSettingsSaved?.(settings); } catch {}
          sendJson(response, 200, {
            settings,
            apiKeyConfigured: Boolean(getLlmApiKey()),
            apiKeyUpdated: keyAction !== "none",
            searchApiKeyConfigured: Boolean(getSearchApiKey()),
            serperApiKeyConfigured: Boolean(getSearchApiKey("serper")),
            message: "模型设置已保存，立即生效。",
          });
        } catch (error) {
          sendJson(response, error.statusCode ?? 400, {
            error: error.message === "模型 API key 格式不正确。" || error.message === "模型 API key 只能包含不带空格的可见 ASCII 字符。"
              ? error.message
              : "保存模型设置失败，请检查接口地址和字段格式。",
          });
        }
        return;
      }

      sendJson(response, 405, { error: "此接口只支持 GET 和 PUT。" });
      return;
    }

    if (request.method !== "GET") {
      sendJson(response, 405, { error: "此页面只支持 GET。" });
      return;
    }

    const asset = assets.get(url.pathname);
    if (!asset) {
      sendJson(response, 404, { error: "没有这个页面。" });
      return;
    }

    try {
      const [filename, contentType] = asset;
      const content = readFileSync(resolve(publicRoot, filename));
      response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
      response.end(content);
    } catch (error) {
      console.error("管理页面读取失败：", error.message ?? error);
      sendJson(response, 500, { error: "管理页面暂时无法读取。" });
    }
  });

  await new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListening();
    });
  });

  console.log(`本机管理面板：http://127.0.0.1:${port}`);
  return server;
}
