import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LLM_SETTINGS, normalizeLlmSettings } from "./llm-settings-store.js";

const path = fileURLToPath(new URL("../data/group-personas.json", import.meta.url));
const fields = ["systemPrompt", "personality", "expressionStyle", "memory", "botAliases", "memoryReplyEnabled"];

export function personaFields(settings) {
  return Object.fromEntries(fields.map((key) => [key, key === "botAliases" ? [...settings[key]] : settings[key]]));
}

function normalizeProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.groupId !== "string" || !/^\d{1,32}$/u.test(input.groupId)) throw new Error("群号无效。");
  if (typeof input.enabled !== "boolean") throw new Error("独立人设开关必须是布尔值。");
  if (typeof input.label !== "string" || input.label.trim().length > 60) throw new Error("群备注最多60字。");
  if (fields.filter(key => key !== 'memoryReplyEnabled').some((key) => !Object.hasOwn(input, key))) throw new Error("群人设缺少必填字段。");
  const validated = normalizeLlmSettings({ ...DEFAULT_LLM_SETTINGS, ...Object.fromEntries(fields.map((key) => [key, input[key]])) });
  return { groupId: input.groupId, label: input.label.trim(), enabled: input.enabled, ...personaFields(validated),
    updatedAt: Number.isSafeInteger(input.updatedAt) && input.updatedAt >= 0 ? input.updatedAt : 0 };
}

function readProfiles() {
  let source;
  try { source = readFileSync(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { missing: true, profiles: [] }; throw error; }
  if (Buffer.byteLength(source) > 10 * 1024 * 1024) throw new Error("分群人设配置过大。");
  let data;
  try { data = JSON.parse(source); } catch { throw new Error("分群人设格式无效。"); }
  if (data?.version !== 1 || !Array.isArray(data.profiles) || data.profiles.length > 256) throw new Error("分群人设格式无效。");
  const profiles = data.profiles.map(normalizeProfile);
  if (new Set(profiles.map((profile) => profile.groupId)).size !== profiles.length) throw new Error("群人设编号重复。");
  return { missing: false, profiles };
}

function writeProfiles(profiles) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: 1, profiles }), { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

export function ensureGroupPersonas(groupIds, defaults) {
  const { missing, profiles } = readProfiles();
  let changed = false;
  for (const groupId of groupIds) {
    if (!/^\d{1,32}$/u.test(groupId)) throw new Error("群号无效。");
    if (profiles.some((profile) => profile.groupId === groupId)) continue;
    if (profiles.length >= 256) throw new Error("最多保存256个群的人设。");
    profiles.push(normalizeProfile({ groupId, label: "", enabled: true, ...personaFields(defaults),
      memory: "", memoryReplyEnabled: false, updatedAt: Date.now() }));
    changed = true;
  }
  if (changed || missing) writeProfiles(profiles);
  return profiles.filter((profile) => groupIds.includes(profile.groupId)).map(withRevision);
}

export function personaRevision(profile) {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}
function withRevision(profile) { return { ...profile, revision: personaRevision(profile) }; }

export function saveGroupPersona(groupId, input, revision, allowedGroups) {
  if (!allowedGroups.includes(groupId)) { const error = new Error("请先在群与权限中添加这个群。"); error.statusCode = 404; throw error; }
  const { profiles } = readProfiles();
  const index = profiles.findIndex((profile) => profile.groupId === groupId);
  if (index < 0) throw new Error("请刷新群人设列表后再保存。");
  if (revision !== personaRevision(profiles[index])) { const error = new Error("这个群的人设刚被其他页面更新，请撤销修改读取最新配置后再编辑。"); error.statusCode = 409; throw error; }
  const previous=profiles[index];
  const profile = normalizeProfile({ ...input, groupId,
    memoryReplyEnabled:input.memory === previous.memory && input.memoryReplyEnabled===true,
    updatedAt: Math.max(Date.now(),previous.updatedAt+1) });
  profiles[index] = profile;
  writeProfiles(profiles);
  return withRevision(profile);
}

export function groupPersonaSettings(settings, profile) {
  // Default/private memory is never inherited by a shared group.
  return profile?.enabled ? { ...settings, ...personaFields(profile), memoryReplyUserIds: [] } : { ...settings, memory: "", memoryReplyEnabled: false, memoryReplyUserIds: [] };
}

export function settingsForGroup(settings, groupId) {
  if (typeof groupId !== "string" || !/^\d{1,32}$/u.test(groupId)) return settings;
  const profile = readProfiles().profiles.find((entry) => entry.groupId === groupId);
  // Default memory is private/default configuration, not a public group fallback.
  const effective = groupPersonaSettings(settings, profile);
  return { ...effective, groupPersonaSince: profile?.updatedAt ?? 0,
    groupPersonaRevision: personaRevision({ groupId, ...personaFields(effective), profileUpdatedAt: profile?.updatedAt ?? 0 }) };
}
