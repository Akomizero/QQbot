import { readFileSync, statSync } from "node:fs";
import { configuredMemoryAllowed, configuredReplyMemory, memoryClauses, shareableMemoryClause, sharedMemberFact } from './memory-reply-access.js';

export const privateReplyNotice = "这部分涉及个人资料，我先不展开。可以继续聊不含个人信息的内容。";
const personal = /真实姓名|本名|历史身份|曾用名|手机号|手机号码|家庭住址|身份证|住在|学校|工作单位|收入|病史|个人资料|个人信息|保密|私密|私聊|饲养员|管理员.{0,12}(?:QQ|账号)|\bQQ\b/iu;
const canonical = value => String(value ?? "").normalize("NFKC").replace(/[\s\p{P}\p{S}\p{Cf}]/gu, "").toLowerCase();

export function buildPrivacyBoundary({ memories = [], memberFacts = [], confidential = [], secrets = [] } = {}) {
  const literals = new Set(), fragments = new Set();
  for (const value of [...memories, ...confidential]) {
    for (const id of String(value).match(/(?<!\d)\d{5,32}(?!\d)/gu) ?? []) literals.add(id);
  }
  for (const value of [...memories, ...memberFacts, ...confidential]) {
    for (const clause of String(value).split(/[。！？\n]/u)) {
      const text = canonical(clause);
      if (text.length < 12) continue;
      // Do not keep actual private values in diagnostics or test fixtures.
      // Fixed-width fragments also catch partial quotations of a stored fact.
      for (let i = 0; i + 12 <= text.length; i++) fragments.add(text.slice(i, i + 12));
    }
  }
  for (const value of secrets) if (typeof value === "string" && value.length >= 8) literals.add(value);
  const protectedLiterals = [...literals].flatMap(value => [canonical(value), Buffer.from(value).toString("base64").toLowerCase(), Buffer.from(value).toString("hex")]);
  return { literals: protectedLiterals, fragments, failed: false };
}

export function privacyViolation(value, boundary) {
  if (boundary.failed) return true;
  const text = canonical(value);
  if (!text) return false;
  if (boundary.literals.some(secret => text.includes(canonical(secret)))) return true;
  for (let i = 0; i + 12 <= text.length; i++) if (boundary.fragments.has(text.slice(i, i + 12))) return true;
  return /(?:sk-[a-z\d]{16,}|tvly-[a-z\d-]{16,}|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dX](?!\d))/iu.test(String(value));
}

const files = ["data/llm-settings.json", "data/group-personas.json", "data/member-impressions.json", "data/knowledge-base.json", ".env"];
let cachedStamp = ""; const cachedBoundaries = new Map();
export function runtimePrivacyBoundary(scope = {}) {
  try {
    const stamp = files.map(name => { try { const s = statSync(new URL("../" + name, import.meta.url)); return `${s.mtimeMs}:${s.size}`; } catch (e) { if (e.code === "ENOENT") return "missing"; throw e; } }).join("|");
    const scopeKey = JSON.stringify([scope.scope, scope.groupId, scope.userId]);
    if (cachedStamp !== stamp) { cachedBoundaries.clear(); cachedStamp = stamp; }
    if (cachedBoundaries.has(scopeKey)) return cachedBoundaries.get(scopeKey);
    const json = name => { try { return JSON.parse(readFileSync(new URL("../" + name, import.meta.url), "utf8")); } catch (e) { if (e.code === "ENOENT") return {}; throw e; } };
    const defaults = json(files[0]).settings ?? {}, profiles = json(files[1]).profiles ?? [];
    const memories = [defaults, ...profiles].map(profile => {
      const sameScope = profile === defaults ? scope.scope === 'private' : scope.scope === 'group' && profile.groupId === scope.groupId;
      return memoryClauses(profile.memory).filter(clause => !(sameScope && configuredMemoryAllowed(profile, scope) && shareableMemoryClause(clause))).join('');
    });
    const confidential = [defaults, ...profiles].flatMap(profile => [profile.systemPrompt, profile.personality, profile.expressionStyle]
      .flatMap(value => String(value ?? "").split(/[。！？\n]/u).filter(clause => personal.test(clause))));
    const memberFacts = [];
    for (const [groupId, group] of Object.entries(json(files[2]).groups ?? {})) for (const member of Object.values(group.members ?? {})) {
      for (const fact of member.facts ?? []) if (typeof fact.content === 'string'
        && !(scope.scope === 'group' && scope.groupId === groupId && member.enabled !== false && sharedMemberFact(fact))) memberFacts.push(fact.content);
    }
    for (const entry of json(files[3]).entries ?? []) if (personal.test(entry.content ?? "")) confidential.push(entry.content);
    const secrets = ["QQBOT_LLM_API_KEY", "SERPER_API_KEY", "TAVILY_API_KEY", "ONEBOT_ACCESS_TOKEN"].map(name => process.env[name]);
    try { for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/u)) {
      const match = line.match(/^\s*(?:QQBOT_LLM_API_KEY|SERPER_API_KEY|TAVILY_API_KEY|ONEBOT_ACCESS_TOKEN)\s*=\s*(.*?)\s*$/u);
      if (match) secrets.push(match[1].replace(/^["']|["']$/gu, ""));
    } } catch (e) { if (e.code !== "ENOENT") throw e; }
    const boundary = buildPrivacyBoundary({ memories, memberFacts, confidential, secrets });
    if (cachedBoundaries.size > 256) cachedBoundaries.clear(); cachedBoundaries.set(scopeKey, boundary); return boundary;
  } catch { return { literals: [], fragments: new Set(), failed: true }; }
}

export function promptSafeSettings(settings, scope = {}) {
  // Authentication/relationship decisions stay in application code. Group
  // memory and member facts have no public-disclosure consent schema yet.
  const fields = ["systemPrompt", "personality", "expressionStyle"];
  return { ...settings, memory: configuredReplyMemory(settings, scope), ...Object.fromEntries(fields.map(field => [field,
    String(settings[field] ?? "").split(/(?<=[。！？\n])/u).filter(clause => !personal.test(clause) && !/\d{5,32}/u.test(clause)).join("")])) };
}

export function sanitizeModelMessages(messages, boundary = runtimePrivacyBoundary()) {
  const safeText = text => privacyViolation(text, boundary) ? "[内部个人资料已隔离，仅按其余可用材料回答；不要推测或复述被隔离内容。]" : text;
  return messages.map(message => ({ ...message, content: typeof message.content === "string" ? safeText(message.content)
    : Array.isArray(message.content) ? message.content.map(part => part.type === "text" ? { ...part, text: safeText(part.text) } : part) : message.content }));
}

export function publicMessageMetadata(metadata) {
  if (!metadata) return metadata;
  const aliases = new Map(), label = id => { if (!aliases.has(id)) aliases.set(id, `会话成员${aliases.size + 1}`); return aliases.get(id); };
  const visit = (value, key = "") => {
    if (typeof value === "string") {
      if (key === "botId") return "bot";
      if (/(?:^id$|Id$)/u.test(key) && /^-?\d+$/u.test(value)) return label(value);
      return value;
    }
    if (Array.isArray(value)) return value.map(item => visit(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, key)]));
    return value;
  };
  return visit(metadata);
}

export function protectLlmResult(result, boundary = runtimePrivacyBoundary()) {
  const summary = result.summary ?? result.announcement ?? result.illustration;
  const material = [result.reply ?? "", summary ? JSON.stringify(summary) : ""].join("\n");
  if (!privacyViolation(material, boundary)) return result;
  return { reply: privateReplyNotice, status: "privacy-blocked" };
}

function outgoingText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(part => {
    if (part.type === "text") return part.data?.text ?? "";
    if (part.type === "node") return [part.data?.nickname ?? part.data?.name ?? "", outgoingText(part.data?.content ?? part.content)].join("\n");
    if (part.type === "json") return part.data?.data ?? "";
    return part.data?.summary ?? "";
  }).join("");
  return "";
}

export function outboundPrivacyScope(params) {
  return params.message_type === 'group' || params.group_id !== undefined ? { scope: 'group', groupId: String(params.group_id) }
    : { scope: 'private', userId: String(params.user_id) };
}
export function protectOutbound(action, params, boundary = runtimePrivacyBoundary(outboundPrivacyScope(params))) {
  if (!["send_msg", "send_group_msg", "send_private_msg", "send_group_forward_msg", "send_private_forward_msg"].includes(action)) return { action, params, blocked: false };
  if (!privacyViolation(outgoingText(params.message ?? params.messages), boundary)) return { action, params, blocked: false };
  const isGroup = action.includes("group") || params.message_type === "group" || params.group_id !== undefined;
  return { action: "send_msg", params: { message_type: isGroup ? "group" : "private", ...(isGroup ? { group_id: params.group_id } : { user_id: params.user_id }), message: privateReplyNotice, auto_escape: true }, blocked: true };
}
