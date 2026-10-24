import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readAccessControl } from "./access-control-store.js";
import { getLlmApiKey } from "./config.js";
import { readLlmSettings } from "./llm-settings-store.js";
import { addLearnedSticker, applyStickerDescription, applyStickerReview, deleteSticker, findStickerSource, listStickers, readSticker } from "./sticker-store.js";
import { reviewStickerBytes, StickerReviewError } from "./sticker-review.js";
import { stickerLearningCapacity } from "./sticker-policy.js";

const statePath = fileURLToPath(new URL("../.local/sticker-learning-state.json", import.meta.url));
const directory = fileURLToPath(new URL("../.local/", import.meta.url));
const cooldownMs = 2 * 60_000;
const dailyLimit = 12;
let active = false;
const shutdown = new AbortController();
const descriptionQueue = new Set();
const descriptionAttempts = new Map();
const observationsFile = new URL("../.local/sticker-learning-observations.json", import.meta.url);
export function noteStickerLearning(groupId, code) {
  if (!/^\d{1,32}$/u.test(groupId) || !/^[a-z-]{2,50}$/u.test(code)) return;
  try { let data = {}; try { data = JSON.parse(readFileSync(observationsFile, "utf8")); } catch {}
    if (data[groupId]?.code === code && Date.now() - data[groupId].at < 60_000) return;
    data[groupId] = { code, at: Date.now() }; mkdirSync(directory, { recursive: true });
    const temp = new URL(observationsFile.href + ".tmp"); writeFileSync(temp, JSON.stringify(data), { mode: 0o600 }); renameSync(temp, observationsFile);
  } catch { /* Diagnostic metadata never changes the learning outcome. */ }
}
export function stickerLearningStatus() {
  let observations = {}; try { observations = JSON.parse(readFileSync(observationsFile, "utf8")); } catch {}
  const entries = listStickers(); let quotas = {}; try { quotas = readState().groups; } catch {}
  return readAccessControl().groupIds.map(groupId => ({ groupId, ...stickerLearningCapacity(entries, groupId),
    count: entries.filter(e => e.groupId === groupId).length, limit: 20, dailyLimit,
    checksToday: quotas[groupId]?.day === dayKey(Date.now()) ? quotas[groupId].count : 0, last: observations[groupId] ?? null }));
}
const retryTimers = new Map();
let descriptionTimer = null;
let descriptionWorker = false;

function dayKey(now) {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

function readState() {
  let source;
  try { source = readFileSync(statePath, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { version: 1, groups: {} }; throw error; }
  if (source.length > 64_000) throw new Error("Sticker learning state too large");
  const value = JSON.parse(source);
  if (value?.version !== 1 || !value.groups || typeof value.groups !== "object" || Array.isArray(value.groups)
    || Object.keys(value.groups).length > 128) throw new Error("Invalid sticker learning state");
  for (const [groupId, entry] of Object.entries(value.groups)) {
    if (!/^\d{1,32}$/u.test(groupId) || !entry || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.day)
      || !Number.isInteger(entry.count) || entry.count < 0 || entry.count > dailyLimit
      || !Number.isSafeInteger(entry.lastAt) || entry.lastAt < 0) throw new Error("Invalid sticker learning state");
  }
  return value;
}

function permitted(groupId) {
  const settings = readLlmSettings();
  return settings.stickerLearningEnabled && settings.stickersEnabled && settings.visionEnabled
    && readAccessControl().groupIds.includes(groupId);
}

export function canLearnSticker(groupId, now = Date.now()) {
  try {
    if (shutdown.signal.aborted || active || !/^\d{1,32}$/u.test(groupId) || !permitted(groupId) || !getLlmApiKey()) return false;
    const stickers = listStickers();
    const capacity = stickerLearningCapacity(stickers, groupId);
    if (!capacity.allowed) { noteStickerLearning(groupId, capacity.reason); return false; }
    const entry = readState().groups[groupId];
    return !entry || (now - entry.lastAt >= cooldownMs && (entry.day !== dayKey(now) || entry.count < dailyLimit));
  } catch { return false; }
}

function reserve(groupId, now) {
  const state = readState();
  for (const [id, entry] of Object.entries(state.groups)) if (now - entry.lastAt > 2 * 24 * 3600_000) delete state.groups[id];
  const previous = state.groups[groupId];
  if (!previous && Object.keys(state.groups).length >= 128) return false;
  const count = previous?.day === dayKey(now) ? previous.count : 0;
  if (count >= dailyLimit || (previous && now - previous.lastAt < cooldownMs)) return false;
  state.groups[groupId] = { day: dayKey(now), count: count + 1, lastAt: now };
  mkdirSync(directory, { recursive: true });
  const tempPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(state), { mode: 0o600 });
  renameSync(tempPath, statePath);
  return true;
}

function mayDescribe(sticker) {
  const settings = readLlmSettings();
  return !shutdown.signal.aborted && settings.stickersEnabled && settings.visionEnabled && Boolean(getLlmApiKey())
    && (sticker.origin==='private'?readAccessControl().userIds.includes(sticker.userId):!sticker.groupId || readAccessControl().groupIds.includes(sticker.groupId));
}

function scheduleDescriptions(delay = 1) {
  if (descriptionTimer || descriptionWorker || !descriptionQueue.size || shutdown.signal.aborted) return;
  descriptionTimer = setTimeout(() => { descriptionTimer = null; void describeNextSticker(); }, delay);
  descriptionTimer.unref?.();
}

export function queueStickerDescription(id) {
  if (shutdown.signal.aborted || descriptionQueue.size >= 50) return;
  descriptionQueue.add(id);
  scheduleDescriptions();
}

export function queuePendingStickerDescriptions() {
  try { for (const entry of listStickers()) if (entry.reviewStatus !== "approved" || (entry.needsDescription && entry.enabled)) queueStickerDescription(entry.id); } catch {}
}

async function describeNextSticker() {
  if (active) { scheduleDescriptions(500); return; }
  const id = descriptionQueue.values().next().value;
  if (!id || shutdown.signal.aborted) return;
  descriptionQueue.delete(id);
  descriptionWorker = true;
  let acquired = false;
  try {
    const sticker = readSticker(id);
    if (!sticker || (sticker.reviewStatus === "approved" && !sticker.needsDescription) || !mayDescribe(sticker)) return;
    active = true;
    acquired = true;
    const review = await reviewStickerBytes(sticker.bytes, { needDescription: sticker.needsDescription });
    if (mayDescribe(sticker)) {
      applyStickerReview(id, review);
      if (review.description && sticker.needsDescription) applyStickerDescription(id, review.description);
    }
    if (sticker.needsDescription && !review.description) throw new Error("Sticker description pending");
    descriptionAttempts.delete(id);
  } catch (error) {
    if (error instanceof StickerReviewError && error.rejected) {
      try { deleteSticker(id); } catch {}
      descriptionAttempts.delete(id);
      return;
    }
    const attempts = (descriptionAttempts.get(id) ?? 0) + 1;
    descriptionAttempts.set(id, attempts);
    if (attempts < 3 && !shutdown.signal.aborted && !retryTimers.has(id)) {
      const timer = setTimeout(() => { retryTimers.delete(id); queueStickerDescription(id); }, 30_000 * attempts * attempts);
      timer.unref?.();
      retryTimers.set(id, timer);
    }
  } finally {
    if (acquired) active = false;
    descriptionWorker = false;
    scheduleDescriptions();
  }
}

export function stopStickerLearning() {
  shutdown.abort();
  if (descriptionTimer) clearTimeout(descriptionTimer);
  for (const timer of retryTimers.values()) clearTimeout(timer);
  descriptionQueue.clear();
  retryTimers.clear();
}

export async function learnIncomingStickers({ groupId, images }) {
  if (!canLearnSticker(groupId)) return 0;
  let acquired = false;
  try {
    const candidates = images.filter((image) => {
      if (!image.stickerCandidate || !Buffer.isBuffer(image.sourceBytes)) return false;
      const known = findStickerSource(image.sourceBytes, groupId);
      return !known || ((known.needsDescription || known.reviewStatus !== "approved") && known.enabled);
    }).slice(0, 2);
    if (!candidates.length) { noteStickerLearning(groupId, "no-new-candidate"); return 0; }
    if (!reserve(groupId, Date.now())) { noteStickerLearning(groupId, "cooldown-or-daily-limit"); return 0; }
    noteStickerLearning(groupId, "reviewing");
    active = true;
    acquired = true;
    let saved = 0;
    for (const candidate of candidates) {
      if (shutdown.signal.aborted || !permitted(groupId)) break;
      const review = await reviewStickerBytes(candidate.sourceBytes, { needDescription: true });
      if (!review.reusable || !review.description) continue;
      const choice = review.description;
      const sticker = await addLearnedSticker({ bytes: candidate.sourceBytes, groupId, review,
        title: choice.title, tags: choice.tags, usage: choice.usage, avoid: choice.avoid,
        allowed: () => !shutdown.signal.aborted && permitted(groupId) });
      if (sticker) saved += 1;
    }
    noteStickerLearning(groupId, saved ? "saved" : "not-reusable-or-capacity");
    return saved;
  } catch (error) {
    noteStickerLearning(groupId, error instanceof StickerReviewError && error.rejected ? "content-rejected" : "review-or-save-failed");
    // Learning failures stay silent; never log image bytes, model output or credentials.
    return 0;
  } finally { if (acquired) active = false; }
}
