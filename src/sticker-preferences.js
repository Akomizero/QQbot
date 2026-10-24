import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { recentStickerAllows } from "./sticker-policy.js";
const file = new URL("../data/sticker-preferences.json", import.meta.url);
const validGroup = id => typeof id === "string" && /^\d{1,32}$/u.test(id);
const validScope = id => validGroup(id) || typeof id === "string" && /^private:\d{1,32}$/u.test(id);
const validSticker = id => typeof id === "string" && /^[a-f\d-]{36}$/u.test(id);
const key = text => String(text).normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s/gu, "");
function load() {
  try { const source = readFileSync(file, "utf8"); if (source.length > 500_000) throw new Error("表情偏好文件过大。"); const data = JSON.parse(source);
    if (data.version !== 1 || !data.groups || typeof data.groups !== "object") throw new Error("表情偏好格式无效。"); return data;
  } catch (error) { if (error.code === "ENOENT") return { version: 1, groups: {} }; throw error; }
}
function write(data) {
  mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
  const temp = new URL(file.href + ".tmp"); writeFileSync(temp, JSON.stringify(data), { mode: 0o600 }); renameSync(temp, file);
}
const stateFor = (data, groupId) => data.groups[groupId] ?? { rules: [], recent: [] };
const revisionOf = state => createHash("sha256").update(JSON.stringify(state.rules)).digest("hex");
export function readStickerPreferences(groupId) {
  if (!validGroup(groupId)) throw new Error("请选择表情偏好所属群。");
  const state = stateFor(load(), groupId);
  return { rules: state.rules, revision: revisionOf(state), recent: state.recent ?? [] };
}
export function saveStickerPreferences(groupId, rules, revision) {
  if (!validGroup(groupId) || !Array.isArray(rules) || rules.length > 40) throw new Error("每群最多40条表情偏好。");
  const data = load(), state = stateFor(data, groupId);
  if (revision !== revisionOf(state)) throw Object.assign(new Error("本群表情偏好刚有更新，请刷新后再保存。"), { statusCode: 409 });
  const seen = new Set();
  state.rules = rules.map(rule => {
    if (!rule || !validSticker(rule.id) || seen.has(rule.id) || !["sticker", "term"].includes(rule.kind)
      || !["candidate", "blocked", "dismissed"].includes(rule.status) || typeof rule.value !== "string"
      || (rule.kind === "sticker" ? !validSticker(rule.value) : !rule.value.trim() || rule.value.length > 30)) throw new Error("表情偏好格式不正确。");
    seen.add(rule.id);
    return { id: rule.id, kind: rule.kind, value: rule.value.trim(), status: rule.status, at: Number.isFinite(rule.at) ? rule.at : Date.now(), origin: rule.origin === "member" ? "member" : "admin" };
  });
  data.groups[groupId] = state; write(data); return readStickerPreferences(groupId);
}
export function parseStickerRejection(text) {
  if (typeof text !== "string") return null;
  for (const clause of text.normalize("NFKC").slice(0, 3000).split(/[,，。！？!?；;\n]/u)) {
    // Negating a dislike or a ban is not a request to suppress stickers.
    if (/(?:不是不|并非不|没有不|不要钱|别(?:屏蔽|禁用|停用)|不要(?:屏蔽|禁用|停用))/u.test(clause)) continue;
    const reverse = clause.match(/([^，。！？!?\n]{0,30}?)(?:的)?表情(?:包)?(?:我|你|咱们|大家|真的|实在|已经|都|就|也|\s){0,10}(?:不想(?:再)?(?:看到|看见|见到|收到|看|要)|不喜欢|不要(?:再(?:发|用|看到|出现)|了)|别(?:再)?(?:发|用|出现)|不用(?:再)?(?:发|用)|停用|禁止)/u);
    const forward = /(?:别|不要|不用|不想|不喜欢|停用|禁止)[^，。！？!?\n]{0,30}表情/u.test(clause);
    if (!reverse && !forward) continue;
    const match = clause.match(/(?:别|不要|不用)(?:再|老是|一直)?(?:给我)?(?:发|用)(?:那个|这个|那张|这张)?\s*([^，。！？!?\n]{1,30}?)(?:的)?表情(?:包)?/u)
      ?? clause.match(/(?:不喜欢|不想(?:再)?(?:看到|看见|看|要))(?:你)?(?:发|用)?\s*([^，。！？!?\n]{1,30}?)(?:的)?表情(?:包)?/u);
    const term = (match?.[1] ?? reverse?.[1] ?? "").trim().replace(/的$/u, "")
      .replace(/^(?:这|那)(?:个|张|些|种|类|款|套)?\s*/u, "").replace(/(?:这个|那个)$/u, "").trim();
    return { term: term && !/^(?:它|你|你的|我|我的|所有|全部|任何|一切|任何人)$/u.test(term) ? term : null };
  }
  return null;
}
export function noteStickerFeedback(groupId, text, quotedStickerId) {
  if (!validGroup(groupId) || typeof text !== "string" || text.length > 400) return null;
  const rejection = parseStickerRejection(text);
  if (!rejection) return null;
  const data = load(), state = stateFor(data, groupId);
  const explicitTerm = rejection.term;
  const target = explicitTerm && !/^(?:这|那|这个|那个|这张|那张|这类|那类|这种|那种|它|你|你的|所有|全部|任何|一切|任何人)$/u.test(explicitTerm) ? { kind: "term", value: explicitTerm }
    : validSticker(quotedStickerId) ? { kind: "sticker", value: quotedStickerId } : null;
  if (!target) return null;
  let rule = state.rules.find(x => x.kind === target.kind && key(x.value) === key(target.value));
  if (rule?.status === "dismissed") return { ...rule, ignored: true };
  if (!rule) { if (state.rules.length >= 40) return null; rule = { id: randomUUID(), ...target, status: "candidate", origin: "member", at: Date.now() }; state.rules.push(rule); }
  data.groups[groupId] = state; write(data); return rule;
}
export function stickerPolicyAllows(sticker, groupId, { includeRecent = false, equivalentIds = [] } = {}) {
  if (!validScope(groupId)) return true;
  const state = stateFor(load(), groupId), now = Date.now();
  const searchable = key(`${sticker.title} ${sticker.tags.join(" ")} ${sticker.usage}`);
  if (state.rules.some(rule => (rule.status === "blocked" || rule.status === "candidate" && now - rule.at < 15 * 60_000)
    && (rule.kind === "sticker" ? rule.value === sticker.id : searchable.includes(key(rule.value))))) return false;
  return !includeRecent || recentStickerAllows(sticker, state.recent ?? [], { now, equivalentIds });
}
export function recordStickerSent(groupId, stickerId, contentHash = null) {
  if (!validScope(groupId) || !validSticker(stickerId)) return;
  const data = load(), state = stateFor(data, groupId);
  state.recent = [...(state.recent ?? []).filter(item => Date.now() - item.at < 10 * 60_000), { id: stickerId, at: Date.now(), ...(/^[a-f\d]{64}$/u.test(contentHash ?? "") ? { contentHash } : {}) }].slice(-6);
  data.groups[groupId] = state; write(data);
}
