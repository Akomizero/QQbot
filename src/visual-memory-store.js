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
const validHash = value => typeof value === "string" && /^[a-f\d]{64}$/u.test(value);
const validDescription = item => typeof item.name === "string" && item.name.trim() && item.name.length <= 60
  && typeof item.work === "string" && item.work.length <= 80 && Array.isArray(item.traits) && item.traits.length >= 2 && item.traits.length <= 8
  && item.traits.every(trait => typeof trait === "string" && trait.trim() && trait.length <= 120)
  && safe(item.name + item.work + item.traits.join(" "));
const sameImage = (a, b) => validHash(a.fingerprint?.sha256) && a.fingerprint.sha256 === b.fingerprint?.sha256;
const conflictsWith = (a, b) => a.name !== b.name || Boolean(a.work && b.work && a.work !== b.work);
const hasCorrectionSource = item => item.origin === "group-correction" && validDescription(item) && validHash(item.fingerprint?.sha256)
  && Array.isArray(item.evidenceRefs)
  && item.evidenceRefs.some(ref => validHash(ref.hash) && validHash(ref.imageSourceHash));
const provisional = item => (item.status === "provisional" || item.status === "candidate" && !item.reviewedByAdministrator
  && item.resolution?.action !== "withdrawn") && hasCorrectionSource(item);
const active = item => item.status === "confirmed" || provisional(item);
function markConflict(item, other, reason, at, sources) {
  const evidence = { entryId: other?.id ?? null, name: other?.name ?? item.name, work: other?.work ?? item.work,
    scope: other?.groupId === null ? "global" : "group", reason, at, ...(sources?.length ? { sources } : {}) };
  const prior = item.conflicts ?? [];
  if (!prior.some(ref => ref.entryId === evidence.entryId && ref.reason === reason)) item.conflicts = [...prior, evidence].slice(-128);
  item.status = "disputed"; item.updatedAt = at;
}
function selectAdministratorReference(all, item, at) {
  item.resolution = { action: "selected", entryId: item.id, at };
  for (const other of all) if (other !== item && (other.groupId ?? null) === (item.groupId ?? null) && sameImage(item, other)
    && ["confirmed", "provisional", "candidate", "disputed"].includes(other.status)) {
    Object.assign(other, { status: "disabled", updatedAt: at, reviewedByAdministrator: true,
      resolution: { action: "superseded", entryId: item.id, at } });
  }
}
export function readVisualMemories(groupId) {
  const entries = scopeEntries(readStore(), groupId);
  return { revision: revisionOf(entries), entries: entries.map(({ fingerprint, ...item }) => item.status === "candidate" && provisional({ ...item, fingerprint })
    ? { ...item, status: "provisional", legacyCandidate: true } : item) };
}
export function confirmedVisualReferences(groupId) {
  const all = readStore(), scoped = all.filter(item => item.status === "confirmed" && item.groupId === groupId);
  return all.filter(item => item.status === "confirmed" && (item.groupId === groupId || item.groupId === null
    && !scoped.some(local => local.fingerprint?.sha256 === item.fingerprint?.sha256)))
    .map(item => ({ ...item, origin: item.origin === "web-verified" ? "web-verified" : "administrator-confirmed" }));
}
// Group corrections remain unverified evidence, never global identity assertions.
export function usableVisualReferences(groupId) {
  if (groupId !== null && (typeof groupId !== "string" || !/^\d{1,32}$/u.test(groupId))) return [];
  const all = readStore(), local = all.filter(item => item.groupId === groupId && groupId !== null);
  const blocked = new Set(local.filter(item => (item.status === "disputed" || item.status === "candidate"
    && item.resolution?.action === "withdrawn" && item.conflicts?.length) && validHash(item.fingerprint?.sha256)).map(item => item.fingerprint.sha256));
  const candidates = all.filter(item => validDescription(item) && validHash(item.fingerprint?.sha256) && active(item)
    && (item.groupId === null && item.status === "confirmed" || groupId !== null && item.groupId === groupId));
  // Defend against older/corrupt stores that contain conflicting active entries without a disputed flag.
  for (const item of candidates) {
    const selected = local.some(other => active(other) && sameImage(item, other) && other.reviewedByAdministrator && other.resolution?.action === "selected");
    if (selected && item.groupId === null) continue;
    if (candidates.some(other => other !== item && sameImage(item, other) && conflictsWith(item, other)
      && !(selected && other.groupId === null))) blocked.add(item.fingerprint.sha256);
  }
  return candidates.filter(item => !blocked.has(item.fingerprint.sha256) && !(item.groupId === null
    && local.some(other => active(other) && sameImage(item, other))))
    .map(item => ({ ...item, status: provisional(item) ? "provisional" : item.status, origin: provisional(item) ? "group-provisional" : item.origin === "web-verified" ? "web-verified" : "administrator-confirmed",
      review: { state: provisional(item) ? "unverified" : "confirmed", scope: item.groupId === null ? "global" : "group", source: item.origin } }));
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
    if (!name || !safe(name + work + traits.join(" ")) || traits.length < 2 || traits.length > 8 || !["candidate", "provisional", "disputed", "confirmed", "disabled", "rejected"].includes(input.status)
      || groupId === null && ["provisional", "disputed"].includes(input.status)
      || input.status === "confirmed" && !work) throw new Error("请填写角色名、2至8条可见特征；确认启用时还需填写作品名。");
    const identityChanged = item.name !== name || item.work !== work || JSON.stringify(item.traits) !== JSON.stringify(traits);
    Object.assign(item, { name, work, traits, status: input.status, updatedAt: new Date().toISOString(), reviewedByAdministrator: true });
    if (identityChanged) { if (item.status !== "provisional") item.origin = "administrator"; delete item.verification; }
    if (item.status === "provisional") {
      if (!hasCorrectionSource({ ...item, origin: "group-correction" })) throw new Error("临时标注必须保留明确的本群单图纠正来源。");
      item.origin = "group-correction";
    }
    if (["confirmed", "provisional"].includes(item.status)) selectAdministratorReference(all, item, item.updatedAt);
    else item.resolution = { action: "withdrawn", entryId: item.id, at: item.updatedAt };
    writeStore(all);
  }
  return readVisualMemories(groupId);
}
export function addVisualCandidate(input) {
  const all = readStore();
  if (typeof input.groupId !== "string" || !/^\d{1,32}$/u.test(input.groupId) || !validDescription(input)
    || !hasCorrectionSource({ ...input, origin: "group-correction", evidenceRefs: [input.evidence] })) throw new Error("角色纠正不适合保存。");
  const existing = all.find(item => item.groupId === input.groupId && item.fingerprint?.sha256 === input.fingerprint.sha256 && item.name === input.name && (!input.work || item.work === input.work));
  if (existing) {
    if (["rejected", "disabled"].includes(existing.status) || existing.reviewedByAdministrator) return false;
    const refs = existing.evidenceRefs ?? [];
    if (refs.some(ref => ref.hash === input.evidence.hash)) return false;
    existing.evidenceRefs = [...refs, input.evidence].slice(-20); existing.updatedAt = new Date().toISOString();
    if (existing.status === "candidate" && provisional(existing)) existing.status = "provisional";
  } else {
    all.push({ id: randomUUID(), groupId: input.groupId, name: input.name, work: input.work, traits: input.traits,
      fingerprint: input.fingerprint, preview: input.preview, status: "provisional", origin: "group-correction",
      relatedStickerId: input.relatedStickerId ?? null, evidenceRefs: [input.evidence],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  const saved = existing ?? all.at(-1), at = new Date().toISOString();
  const peers = all.filter(other => other !== saved && (other.groupId === input.groupId || other.groupId === null)
    && sameImage(saved, other) && (active(other) || other.status === "disputed"));
  for (const other of peers) if (conflictsWith(saved, other) || other.status === "disputed") {
    markConflict(saved, other, "same-image-correction-conflict", at);
    if (other.groupId === input.groupId) markConflict(other, saved, "same-image-correction-conflict", at);
  }
  writeStore(all); return existing?.id ?? all.at(-1).id;
}
export function recordVisualVerification(groupId, id, report) {
  const all = readStore(), item = all.find(item => item.groupId === groupId && item.id === id);
  if (!item || !["candidate", "provisional", "disputed"].includes(item.status) || item.reviewedByAdministrator || !hasCorrectionSource(item)) return false;
  item.verification = { ...report, checkedAt: new Date().toISOString() };
  const at = item.verification.checkedAt;
  const conflict = all.filter(other => other !== item && (other.groupId === groupId || other.groupId === null) && (active(other) || other.status === "disputed")
    && sameImage(item, other) && conflictsWith({ ...item, work: report.work || item.work }, other));
  const reliableConflict = report.status === "conflict" && validHash(report.referenceImageHash)
    && Array.isArray(report.sources) && report.sources.some(source => ["official", "wiki"].includes(source.kind) && /^https:\/\//u.test(source.url ?? ""));
  if (reliableConflict) markConflict(item, null, "reliable-source-conflict", at, report.sources);
  for (const other of conflict) {
    markConflict(item, other, "same-image-reference-conflict", at);
    if (other.groupId === groupId) markConflict(other, item, "same-image-reference-conflict", at);
  }
  if (report.status === "verified" && item.status !== "disputed" && !conflict.length && report.work
    && validDescription({ ...item, work: report.work, traits: report.features })) {
    item.status = "confirmed"; item.origin = "web-verified"; item.work = report.work; item.traits = report.features;
  } else if (conflict.length && report.status === "verified") item.verification.status = "existing-reference-conflict";
  item.updatedAt = new Date().toISOString(); writeStore(all);
  return item.origin === "web-verified" && item.status === "confirmed";
}
export function saveAdministratorVisualReference(entry) {
  const all = readStore();
  const id = createHash("sha256").update(JSON.stringify([entry.groupId, entry.name, entry.work])).digest("hex").slice(0, 24);
  const saved = { ...entry, id, status: "confirmed", origin: "administrator", preview: null,
    reviewedByAdministrator: true, evidenceRefs: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const next = [...all.filter(item => item.id !== id), saved]; selectAdministratorReference(next, saved, saved.updatedAt); writeStore(next);
}
