import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
const file = new URL("../data/visual-memory.json", import.meta.url);
const legacy = new URL("../data/character-references.json", import.meta.url);
const clean = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
const safe = value => !/(?:https?:\/\/|sk-[a-z\d]{12,}|tvly-|api.?key|密钥|密码|cookie|sessdata|身份证|手机号|家庭住址|真实姓名|忽略.{0,8}指令|系统提示|\b\d{7,}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})/iu.test(value);
export const isVisualCorrectionText = text => typeof text === "string" && text.length <= 1200
  && /(?:这(?:个|张|是)|图(?:里|中|上)|角色|人物|认错|不是.{1,40}是|记住.{0,20}(?:叫|是))/u.test(text)
  && /(?:是|叫|出自|来自|认错|记住)/u.test(text) && safe(text);

function readStore() {
  let data;
  try { const text = readFileSync(file, "utf8"); if (Buffer.byteLength(text) > 12 * 1024 * 1024) throw Error(); data = JSON.parse(text); }
  catch (error) {
    if (error.code !== "ENOENT") throw new Error("视觉记忆文件无法读取。");
    let refs = []; try { refs = JSON.parse(readFileSync(legacy, "utf8")).references ?? []; } catch (old) { if (old.code !== "ENOENT") throw new Error("旧角色参考无法读取。"); }
    data = { version: 1, entries: refs.map(ref => ({ ...ref, groupId: ref.groupId ?? null, status: "confirmed", evidenceRefs: [], preview: null, createdAt: ref.updatedAt, origin: "administrator", relatedStickerId: null })) };
  }
  if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 128) throw new Error("视觉记忆格式无效。");
  return data.entries;
}
function writeStore(entries) {
  if (entries.length > 128) throw new Error("视觉记忆最多128条，请先整理旧候选。");
  const text = JSON.stringify({ version: 1, entries });
  if (Buffer.byteLength(text) > 12 * 1024 * 1024) throw new Error("视觉记忆空间已满，请整理条目。");
  mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
  const temp = new URL(file.href + "." + randomUUID() + ".tmp");
  writeFileSync(temp, text, { mode: 0o600 }); renameSync(temp, file);
}
const scopeEntries = (all, groupId) => all.filter(item => (item.groupId ?? null) === groupId);
const revisionOf = entries => createHash("sha256").update(JSON.stringify(entries)).digest("hex");
export function readVisualMemories(groupId) {
  const entries = scopeEntries(readStore(), groupId);
  return { revision: revisionOf(entries), entries: entries.map(({ fingerprint, ...item }) => item) };
}
export function confirmedVisualReferences(groupId) {
  const all = readStore(), scoped = all.filter(item => item.status === "confirmed" && item.groupId === groupId);
  return all.filter(item => item.status === "confirmed" && (item.groupId === groupId || item.groupId === null
    && !scoped.some(local => local.fingerprint?.sha256 === item.fingerprint?.sha256)))
    .map(item => ({ ...item, origin: item.origin === "web-verified" ? "web-verified" : "administrator-confirmed" }));
}
export function visualMemoryRevision(groupId) { return revisionOf(scopeEntries(readStore(), groupId)); }
function checkRevision(all, groupId, revision) {
  if (revision !== revisionOf(scopeEntries(all, groupId))) throw Object.assign(new Error("视觉记忆刚有更新，请刷新后重试。"), { statusCode: 409 });
}
export function editVisualMemory(groupId, input, revision, remove = false) {
  const all = readStore(); checkRevision(all, groupId, revision);
  const item = all.find(item => item.id === input.id && (item.groupId ?? null) === groupId);
  if (!item) throw Object.assign(new Error("这条视觉记忆不存在。"), { statusCode: 404 });
  if (remove) writeStore(all.filter(entry => entry !== item));
  else {
    const name = clean(input.name, 60), work = clean(input.work, 80), traits = Array.isArray(input.traits) ? input.traits.map(x => clean(x, 120)).filter(Boolean) : [];
    if (!name || !safe(name + work + traits.join(" ")) || traits.length < 2 || traits.length > 8 || !["candidate", "confirmed", "disabled", "rejected"].includes(input.status)
      || input.status === "confirmed" && !work) throw new Error("请填写角色名、2至8条可见特征；确认启用时还需填写作品名。");
    const identityChanged = item.name !== name || item.work !== work || JSON.stringify(item.traits) !== JSON.stringify(traits);
    Object.assign(item, { name, work, traits, status: input.status, updatedAt: new Date().toISOString(), reviewedByAdministrator: true });
    if (identityChanged) { item.origin = "administrator"; delete item.verification; }
    if (item.status === "confirmed") for (const other of all) {
      if (other !== item && (other.groupId ?? null) === groupId && other.status === "confirmed" && other.fingerprint?.sha256 === item.fingerprint?.sha256)
        Object.assign(other, { status: "disabled", updatedAt: item.updatedAt, reviewedByAdministrator: true });
    }
    writeStore(all);
  }
  return readVisualMemories(groupId);
}
export function addVisualCandidate(input) {
  const all = readStore();
  if (!/^\d{1,32}$/u.test(input.groupId) || !input.name || !safe(input.name + input.work + input.traits.join(" "))) throw new Error("角色纠正不适合保存。");
  const existing = all.find(item => item.groupId === input.groupId && item.fingerprint?.sha256 === input.fingerprint.sha256 && item.name === input.name && (!input.work || item.work === input.work));
  if (existing) {
    if (existing.status === "rejected" || existing.reviewedByAdministrator) return false;
    const refs = existing.evidenceRefs ?? [];
    if (refs.some(ref => ref.hash === input.evidence.hash)) return false;
    existing.evidenceRefs = [...refs, input.evidence].slice(-20); existing.updatedAt = new Date().toISOString();
  } else {
    all.push({ id: randomUUID(), groupId: input.groupId, name: input.name, work: input.work, traits: input.traits,
      fingerprint: input.fingerprint, preview: input.preview, status: "candidate", origin: "group-correction",
      relatedStickerId: input.relatedStickerId ?? null, evidenceRefs: [input.evidence],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  writeStore(all); return existing?.id ?? all.at(-1).id;
}
export function recordVisualVerification(groupId, id, report) {
  const all = readStore(), item = all.find(item => item.groupId === groupId && item.id === id);
  if (!item || item.status !== "candidate" || item.reviewedByAdministrator) return false;
  item.verification = { ...report, checkedAt: new Date().toISOString() };
  const conflict = all.some(other => other !== item && (other.groupId === groupId || other.groupId === null) && other.status === "confirmed"
    && other.fingerprint?.sha256 === item.fingerprint?.sha256 && (other.name !== item.name || other.work !== (report.work || item.work)));
  if (report.status === "verified" && !conflict && report.work && safe(report.work)) {
    item.status = "confirmed"; item.origin = "web-verified"; item.work = report.work; item.traits = report.features;
  } else if (conflict && report.status === "verified") item.verification.status = "existing-reference-conflict";
  item.updatedAt = new Date().toISOString(); writeStore(all);
  return item.origin === "web-verified" && item.status === "confirmed";
}
export function saveAdministratorVisualReference(entry) {
  const all = readStore();
  const id = createHash("sha256").update(JSON.stringify([entry.groupId, entry.name, entry.work])).digest("hex").slice(0, 24);
  writeStore([...all.filter(item => item.id !== id), { ...entry, id, status: "confirmed", origin: "administrator", preview: null,
    reviewedByAdministrator: true, evidenceRefs: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
}
