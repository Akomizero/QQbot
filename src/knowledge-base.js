import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const storePath = fileURLToPath(new URL("../data/knowledge-base.json", import.meta.url));
const maxStoreBytes = 1024 * 1024;
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const stopWords = new Set(["这个", "那个", "什么", "怎么", "怎样", "为什么", "请问", "一下", "可以", "知道", "是不是", "有没有", "帮我", "一个", "一些", "的", "了", "吗", "呢", "是", "我", "你", "它"]);
let cachedSource = null;
let cachedChunks = [];

export function normalizeKnowledgeEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 200) throw new Error("知识库必须是数组，最多 200 条。");
  const ids = new Set();
  const result = entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("知识条目格式不正确。");
    const { id, title, content, tags = [], enabled = true } = entry;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/u.test(id) || ids.has(id)) throw new Error("知识条目编号无效或重复。");
    if (typeof title !== "string" || !title.trim() || title.length > 120) throw new Error("知识标题不能为空，最多 120 个字符。");
    if (typeof content !== "string" || !content.trim() || content.length > 12000) throw new Error("知识正文不能为空，最多 12000 个字符。");
    if (!Array.isArray(tags) || tags.length > 20 || tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 40)) throw new Error("关键词最多 20 个，每个最多 40 个字符。");
    if (typeof enabled !== "boolean") throw new Error("知识条目启用状态无效。");
    ids.add(id);
    const groupId = entry.groupId ?? null;
    if (groupId !== null && (typeof groupId !== "string" || !/^\d{1,32}$/u.test(groupId))) throw new Error("知识来源群号格式不正确。");
    const origin = entry.origin === "group" ? "group" : "manual";
    const learnedAt = Number.isFinite(entry.learnedAt) ? entry.learnedAt : null;
    const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : null;
    const evidenceCount = Math.max(0, Math.min(10000, Math.trunc(Number(entry.evidenceCount)) || 0));
    const reviewStatus = ["candidate", "rejected"].includes(entry.reviewStatus) ? entry.reviewStatus : "learned";
    const reviewDecision = ["approved", "rejected"].includes(entry.reviewDecision) ? entry.reviewDecision : null;
    const evidenceRefs = (Array.isArray(entry.evidenceRefs) ? entry.evidenceRefs : []).filter(ref => /^[a-f\d]{64}$/u.test(ref?.hash ?? "") && Number.isFinite(ref.at)).slice(-20).map(({ hash, at }) => ({ hash, at }));
    const relatedStickerIds = [...new Set(Array.isArray(entry.relatedStickerIds) ? entry.relatedStickerIds : [])].filter(id => /^[a-f\d-]{36}$/u.test(id)).slice(0, 4);
    const supersedesId = typeof entry.supersedesId === "string" && /^[a-zA-Z0-9_-]{1,100}$/u.test(entry.supersedesId) ? entry.supersedesId : null;
    const requiresReview = entry.requiresReview === true;
    return { id, title: title.trim(), tags: [...new Set(tags.map((tag) => tag.trim()))], content: content.trim(), enabled: reviewStatus === "learned" ? enabled : false, groupId, origin, learnedAt, updatedAt, evidenceCount, reviewStatus, reviewDecision, evidenceRefs, relatedStickerIds, supersedesId, requiresReview };
  });
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maxStoreBytes - 100) throw new Error("知识库总量超过 1 MB，请精简条目。");
  return result;
}

export function readKnowledgeEntries() {
  let source;
  try {
    if (statSync(storePath).size > maxStoreBytes) throw new Error("知识库文件过大。");
    source = readFileSync(storePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(source);
  if (parsed?.version !== 1) throw new Error("知识库文件版本不受支持。");
  return normalizeKnowledgeEntries(parsed.entries);
}

export function writeKnowledgeEntries(entries) {
  const normalized = normalizeKnowledgeEntries(entries);
  const source = `${JSON.stringify({ version: 1, entries: normalized })}\n`;
  mkdirSync(dirname(storePath), { recursive: true });
  const tempPath = resolve(dirname(storePath), `knowledge-base.json.${process.pid}.tmp`);
  writeFileSync(tempPath, source, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, storePath);
  cachedSource = null;
  return normalized;
}

export function knowledgeRevision(entries = readKnowledgeEntries()) {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function readScopedKnowledge(groupId) {
  return readKnowledgeEntries().filter((entry) => entry.groupId === groupId);
}

export function writeScopedKnowledge(groupId, input, revision) {
  const all = readKnowledgeEntries();
  const current = all.filter((entry) => entry.groupId === groupId);
  if (revision !== knowledgeRevision(current)) {
    const error = new Error("当前知识库刚有新积累或被其他页面更新，请检查后再次保存。");
    error.statusCode = 409;
    throw error;
  }
  if (!Array.isArray(input)) throw new Error("知识条目必须是数组。");
  const scoped = normalizeKnowledgeEntries(input.map((entry) => {
    if (!entry || (entry.groupId !== undefined && entry.groupId !== groupId)) throw new Error("不能修改其他群的知识条目。");
    return { ...entry, groupId };
  }));
  writeKnowledgeEntries([...all.filter((entry) => entry.groupId !== groupId), ...scoped]);
  return scoped;
}

export function mergeLearnedKnowledge(groupId, candidates, now = Date.now()) {
  if (!/^\d{1,32}$/u.test(groupId)) return 0;
  const entries = readKnowledgeEntries();
  let changed = 0;
  for (const candidate of candidates.slice(0, 3)) {
    const titleKey = candidate.title.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s/gu, "");
    let id = "learned-" + createHash("sha256").update(`${groupId}:${titleKey}`).digest("hex").slice(0, 24);
    const base = entries.find(entry => entry.id === id);
    const correction = base && base.reviewStatus === "learned" && base.content !== candidate.content;
    if (correction) id += "-" + createHash("sha256").update(candidate.content).digest("hex").slice(0, 10);
    const existing = entries.find((entry) => entry.id === id);
    if (entries.some((entry) => entry.origin === "manual" && entry.groupId === groupId && entry.title.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s/gu, "") === titleKey)) continue;
    if (existing) {
      if (existing.reviewDecision === "rejected" || existing.reviewStatus === "rejected") continue;
      // Preserve an administrator's disabled/edit choices; only promote a pending candidate.
      const oldRefs = existing.evidenceRefs ?? [];
      const fresh = (candidate.evidenceRefs ?? []).filter(ref => !oldRefs.some(old => old.hash === ref.hash));
      if ((candidate.evidenceRefs?.length ?? 0) && !fresh.length) continue;
      existing.evidenceCount += candidate.evidenceRefs?.length ? fresh.length : candidate.evidenceCount;
      existing.evidenceRefs = [...oldRefs, ...fresh].slice(-20);
      existing.relatedStickerIds = [...new Set([...(existing.relatedStickerIds ?? []), ...(candidate.relatedStickerIds ?? [])])].slice(0, 4);
      existing.updatedAt = now;
      existing.requiresReview = existing.requiresReview || candidate.requiresReview === true;
      if (existing.reviewStatus === "candidate" && candidate.confirmed && !existing.requiresReview && !existing.supersedesId && !existing.reviewDecision) {
        existing.reviewStatus = "learned";
        existing.enabled = true;
      }
      existing.tags = [...new Set([...existing.tags, ...candidate.tags])].slice(0, 20);
    } else {
      if (entries.length >= 200 || entries.filter((entry) => entry.origin === "group" && entry.groupId === groupId).length >= 40) continue;
      const confirmed = candidate.confirmed && !correction && !candidate.requiresReview;
      entries.push({ id, title: candidate.title, content: candidate.content, tags: candidate.tags, enabled: confirmed, groupId, origin: "group", learnedAt: now, updatedAt: now, evidenceCount: candidate.evidenceCount, reviewStatus: confirmed ? "learned" : "candidate",
        reviewDecision: null, evidenceRefs: candidate.evidenceRefs ?? [], relatedStickerIds: candidate.relatedStickerIds ?? [], supersedesId: correction ? base.id : null, requiresReview: candidate.requiresReview === true });
    }
    changed += 1;
  }
  if (changed) writeKnowledgeEntries(entries);
  return changed;
}

function tokens(text) {
  const normalized = String(text).normalize("NFKC").toLocaleLowerCase("zh-CN");
  const result = [];
  for (const { segment, isWordLike } of segmenter.segment(normalized)) {
    if (!isWordLike || stopWords.has(segment)) continue;
    result.push(segment);
    if (/^\p{Script=Han}{3,}$/u.test(segment)) {
      for (let i = 0; i < segment.length - 1; i += 1) result.push(segment.slice(i, i + 2));
    }
  }
  return result;
}

function buildChunks(entries) {
  const chunks = [];
  for (const entry of entries.filter((item) => item.enabled)) {
    for (let offset = 0; offset < entry.content.length; offset += 650) {
      const excerpt = entry.content.slice(offset, offset + 800);
      const words = tokens(`${entry.title} ${entry.tags.join(" ")} ${excerpt}`);
      const counts = new Map();
      for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
      chunks.push({ entry, excerpt, counts, length: Math.max(words.length, 1) });
      if (offset + 800 >= entry.content.length) break;
    }
  }
  return chunks;
}

function rankChunks(chunks, query, limit) {
  const queryWords = [...new Set(tokens(String(query).slice(0, 3000)))];
  if (!queryWords.length || !chunks.length) return [];
  const documentFrequency = new Map(queryWords.map((word) => [word, chunks.filter((chunk) => chunk.counts.has(word)).length]));
  const averageLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0) / chunks.length;
  const normalizedQuery = String(query).normalize("NFKC").toLocaleLowerCase("zh-CN");
  const ranked = chunks.map((chunk) => {
    let score = 0;
    for (const word of queryWords) {
      const frequency = chunk.counts.get(word) ?? 0;
      if (!frequency) continue;
      const idf = Math.log(1 + (chunks.length - documentFrequency.get(word) + 0.5) / (documentFrequency.get(word) + 0.5));
      score += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * chunk.length / averageLength));
    }
    const names = [chunk.entry.title, ...chunk.entry.tags].map((name) => name.normalize("NFKC").toLocaleLowerCase("zh-CN"));
    if (names.some((name) => name.length >= 2 && normalizedQuery.includes(name))) score += 5;
    return { ...chunk, score };
  }).filter((chunk) => chunk.score > 0).sort((a, b) => b.score - a.score);
  const results = [];
  const seen = new Set();
  for (const chunk of ranked) {
    if (seen.has(chunk.entry.id)) continue;
    seen.add(chunk.entry.id);
    results.push({ id: chunk.entry.id, title: chunk.entry.title, tags: chunk.entry.tags, excerpt: chunk.excerpt });
    if (results.length >= limit) break;
  }
  return results;
}

// The bot reads only this curated store. No filesystem paths are accepted from chat.
export function searchKnowledge(query, { limit = 3, entries = null, groupId = null } = {}) {
  const boundedLimit = Math.min(5, Math.max(1, Math.trunc(limit) || 3));
  if (groupId !== null && (typeof groupId !== "string" || !/^\d{1,32}$/u.test(groupId))) return [];
  const inScope = (entry) => entry.groupId === groupId;
  if (entries !== null) return rankChunks(buildChunks(normalizeKnowledgeEntries(entries).filter(inScope)), query, boundedLimit);
  const saved = readKnowledgeEntries().filter(inScope);
  const source = JSON.stringify(saved);
  if (source !== cachedSource) {
    cachedChunks = buildChunks(saved);
    cachedSource = source;
  }
  return rankChunks(cachedChunks, query, boundedLimit);
}
