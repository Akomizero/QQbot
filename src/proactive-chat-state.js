import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = resolve(projectRoot, ".local", "proactive-chat-state.json");
const maxStoredGroups = 512;
const stateRetentionMs = 2 * 24 * 60 * 60 * 1000;
const lastBotReplies = new Map();

function emptyState() {
  return { version: 1, groups: {} };
}

function readState() {
  let source;
  try {
    source = readFileSync(statePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw new Error("无法读取主动聊天节流状态。");
  }

  let state;
  try { state = JSON.parse(source); } catch { throw new Error("主动聊天节流状态文件格式无效。"); }
  if (
    state?.version !== 1
    || !state.groups
    || typeof state.groups !== "object"
    || Array.isArray(state.groups)
  ) {
    throw new Error("主动聊天节流状态文件格式无效。");
  }

  const groups = {};
  for (const [groupId, entry] of Object.entries(state.groups)) {
    if (
      !/^\d{1,32}$/u.test(groupId)
      || !entry
      || typeof entry.dayKey !== "string"
      || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.dayKey)
      || !Number.isSafeInteger(entry.dailyAttempts)
      || entry.dailyAttempts < 0
      || entry.dailyAttempts > 1440
      || !Number.isSafeInteger(entry.dailyReplies)
      || entry.dailyReplies < 0
      || entry.dailyReplies > 24
      || !Number.isSafeInteger(entry.lastEvaluationAt)
      || entry.lastEvaluationAt < 0
      || !Number.isSafeInteger(entry.lastReplyAt)
      || entry.lastReplyAt < 0
    ) {
      throw new Error("主动聊天节流状态文件格式无效。");
    }
    groups[groupId] = {
      dayKey: entry.dayKey,
      dailyAttempts: entry.dailyAttempts,
      dailyReplies: entry.dailyReplies,
      lastEvaluationAt: entry.lastEvaluationAt,
      lastReplyAt: entry.lastReplyAt,
      quietUntil: Number.isSafeInteger(entry.quietUntil) && entry.quietUntil >= 0 ? entry.quietUntil : 0,
    };
  }
  if (Object.keys(groups).length > maxStoredGroups) throw new Error("主动聊天节流状态超过容量限制。");
  return { version: 1, groups };
}

function writeState(state) {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const tempPath = `${statePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tempPath, statePath);
  } finally {
    try { unlinkSync(tempPath); } catch {}
  }
}

export function reserveProactiveEvaluation({ groupId, now, dayKey, cooldownMs, evaluationIntervalMs, dailyLimit, pauseWhenIgnored = true }) {
  const state = readState();
  for (const [storedGroupId, entry] of Object.entries(state.groups)) {
    const lastActivityAt = Math.max(entry.lastEvaluationAt, entry.lastReplyAt);
    if (lastActivityAt > 0 && now - lastActivityAt > stateRetentionMs) delete state.groups[storedGroupId];
  }

  let group = state.groups[groupId];
  if (!group) {
    if (Object.keys(state.groups).length >= maxStoredGroups) return false;
    group = { dayKey, dailyAttempts: 0, dailyReplies: 0, lastEvaluationAt: 0, lastReplyAt: 0 };
  }
  if (group.dayKey !== dayKey) {
    group.dayKey = dayKey;
    group.dailyAttempts = 0;
    group.dailyReplies = 0;
  }
  if (
    (pauseWhenIgnored && group.quietUntil > now)
    ||
    now - group.lastReplyAt < cooldownMs
    || now - group.lastEvaluationAt < evaluationIntervalMs
    || group.dailyReplies >= dailyLimit
  ) return false;

  group.dailyAttempts += 1;
  group.lastEvaluationAt = now;
  state.groups[groupId] = group;
  writeState(state);
  return true;
}

export function recordProactiveWaiting({ groupId, now = Date.now(), text, messageId }) {
  const state = readState();
  const group = state.groups[groupId];
  if (!group) return;
  group.quietUntil = now + 65 * 60_000;
  writeState(state);
  lastBotReplies.set(groupId, { at: now, text: String(text ?? "").slice(0, 180), messageId: messageId == null ? null : String(messageId) });
}

export function proactiveQuietUntil(groupId) { return readState().groups[groupId]?.quietUntil ?? 0; }

export function recordExternalProactiveReply({ groupId, text, messageId, pauseWhenIgnored = true, now = Date.now() }) {
  const state = readState();
  const dayKey = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const group = state.groups[groupId] ?? { dayKey, dailyAttempts: 0, dailyReplies: 0, lastEvaluationAt: 0, lastReplyAt: 0 };
  group.lastReplyAt = now; state.groups[groupId] = group; writeState(state);
  if (pauseWhenIgnored) recordProactiveWaiting({ groupId, now, text, messageId });
}

export function acknowledgeGroupReply({ groupId, mentioned = false, replyIds = [], text = "", now = Date.now() }) {
  const previous = lastBotReplies.get(groupId);
  let engaged = mentioned || Boolean(previous?.messageId && replyIds.includes(previous.messageId));
  if (!engaged && previous && now - previous.at <= 3 * 60_000) {
    const value = text.trim().toLocaleLowerCase("zh-CN");
    const reaction = /^(?:哈{2,}|笑死|确实|对呀|对啊|好耶|笑了|谢谢|好可爱|没错|有道理|然后呢)[！!。，,.～~\s]*$/u.test(value);
    const common = new Set(["这个", "那个", "一下", "什么", "可以", "怎么", "知道", "好像"]);
    const pairs = [...previous.text.matchAll(/[\p{Script=Han}]{2,}|[a-z]{3,}/giu)].flatMap(([word]) => word.length > 2 ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]);
    engaged = reaction || pairs.some((pair) => !common.has(pair) && value.includes(pair.toLocaleLowerCase("zh-CN")));
  }
  if (!engaged) return false;
  const state = readState();
  if (state.groups[groupId]?.quietUntil) { state.groups[groupId].quietUntil = 0; writeState(state); }
  lastBotReplies.delete(groupId);
  return true;
}

export function recordProactiveReply({ groupId, now, dayKey, cooldownMs, dailyLimit }) {
  const state = readState();
  const group = state.groups[groupId];
  if (!group) return false;
  if (group.dayKey !== dayKey) {
    group.dayKey = dayKey;
    group.dailyAttempts = 0;
    group.dailyReplies = 0;
  }
  if (now - group.lastReplyAt < cooldownMs || group.dailyReplies >= dailyLimit) return false;
  group.dailyReplies += 1;
  group.lastReplyAt = now;
  writeState(state);
  return true;
}
