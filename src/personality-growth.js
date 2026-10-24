import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

const file = new URL("../data/personality-growth.json", import.meta.url);
const validId = value => typeof value === "string" && /^\d{1,32}$/u.test(value);
const day = 86400_000, stepInterval = 6 * 3600_000;
// A bounded vocabulary controls expression, never identity, permissions or factual beliefs.
export const growthHabits = {
  length: { label: "闲聊篇幅", values: {
    concise: { label: "更简短", instruction: "普通闲聊更偏向一两句直接回应；具体问题仍按所需信息完整回答。", cue: /短(?:一)?点|简短(?:些|点|一点)|少说点|回复.{0,8}(?:短|简洁|精简)(?:些|点|一点)?|太长|别.{0,6}(?:长篇|小作文)|不用.{0,6}解释这么多/u },
    detailed: { label: "更愿意展开", instruction: "有内容的话题可多补一两句理由或例子；不主动把闲聊写成报告。", cue: /详细(?:点|一些|一点)|多说点|展开(?:说|一点|点|些)|讲具体点|解释清楚点/u },
  } },
  humor: { label: "玩笑习惯", values: {
     playful: { label: "更会接玩笑", instruction: "轻松话题中可自然接一两句玩笑，避免复读固定梗，不嘲讽真人。", cue: /(?:你|肥鱼|鱼鱼).{0,12}(?:好{1,2}笑|幽默|有梗)|笑死|哈哈.{0,10}(?:你|肥鱼)|多.{0,5}(?:开玩笑|玩梗)|就喜欢.{0,8}(?:玩笑|梗)/u },
    restrained: { label: "更克制玩梗", instruction: "少插入玩笑和梗，优先接住对方正在说的内容；严肃话题认真回应。", cue: /(?:别|不要|少|不想).{0,8}(?:开玩笑|玩梗|抖机灵)|认真点|严肃点|不好笑|不幽默/u },
  } },
  tone: { label: "表达节奏", values: {
    lively: { label: "熟悉后更活泼", instruction: "在轻松且有人回应的交流中，表达可稍活泼；不夸张卖萌或声称有真实情绪。", cue: /活泼点|活跃一点|有活力|(?:你|肥鱼).{0,8}(?:这样|这么).{0,5}可爱/u },
    calm: { label: "更从容安静", instruction: "语气从容、温和，少连续感叹和刻意热闹；不降低回答的准确性。", cue: /安静点|稳重点|冷静点|别太激动|不用这么热情|少点感叹/u },
  } },
  stickers: { label: "表情习惯", values: {
    sparing: { label: "更少配表情", instruction: "回复更少配表情；群内禁用、内容检查和具体成员的拒绝始终优先。", cue: /少.{0,5}(?:用|发).{0,5}表情|别总.{0,5}表情|不用每次.{0,5}表情|表情.{0,4}太多/u },
    contextual: { label: "合适时更愿意斗图", instruction: "轻松斗图场景可选合适库存表情，普通问答不强行配图，遵守所有内容与群偏好过滤。", cue: /多.{0,5}(?:用|发).{0,5}表情|喜欢.{0,8}斗图|可以多斗图/u },
  } },
  sharing: { label: "分享方式", values: {
    contextual: { label: "分享时更像接话", instruction: "已有授权的分享机会中，先用简短感受接上当前话题；不增加主动发送次数，不创造分享机会。", cue: /分享.{0,8}(?:自然|接话)|像群友.{0,8}分享|(?:视频|分享).{0,8}接着聊/u },
    reserved: { label: "分享更谨慎", instruction: "对主动分享保持谨慎，只有与当前具体讨论直接相关时才考虑，没回应时保持安静。", cue: /少.{0,6}(?:分享|推荐视频)|别总.{0,6}(?:分享|推荐)|推荐.{0,5}太多/u },
  } },
};
const option = (dimension, value) => Object.hasOwn(growthHabits, dimension) && Object.hasOwn(growthHabits[dimension].values, value)
  ? growthHabits[dimension].values[value] : null;
function supports(dimension, value, text) {
  const chosen = option(dimension, value);
  if (!chosen?.cue.test(text)) return false;
  if (["playful", "lively", "detailed", "contextual"].includes(value)
    && /不好笑|不幽默|不可爱|(?:别|不要|不用|不想).{0,5}(?:活泼|详细|多说|展开|多.{0,4}表情)/u.test(text)) return false;
  return true;
}
const contributor = (groupId, userId) => createHash("sha256").update(`growth:${groupId}:${userId}`).digest("hex");
export const personalityGrowthBaseline = settings => createHash("sha256").update(JSON.stringify([
  settings.systemPrompt, settings.personality, settings.expressionStyle,
])).digest("hex");
const fresh = () => ({ enabled: true, learningEnabled: true, generation: 0, baseline: null, habits: {}, candidates: [], changes: [], journal: [], blocked: [], lastChangedAt: 0 });
function read() {
  try {
    if (statSync(file).size > 2 * 1024 * 1024) throw Error();
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data.version !== 1 || !data.groups || typeof data.groups !== "object" || Array.isArray(data.groups)) throw Error();
    return data;
  } catch (error) { if (error.code === "ENOENT") return { version: 1, groups: {} }; throw new Error("性格成长记录无法读取，已保留原文件。"); }
}
function write(data) {
  const source = JSON.stringify(data);
  if (Object.keys(data.groups).length > 128 || Buffer.byteLength(source) > 2 * 1024 * 1024) throw new Error("成长记录达到存储边界，请整理后继续。");
  mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
  const temp = new URL(file.href + `.${process.pid}.tmp`);
  writeFileSync(temp, source, { mode: 0o600 }); renameSync(temp, file);
}
const groupOf = (data, groupId) => data.groups[groupId] ?? fresh();
const revision = group => createHash("sha256").update(JSON.stringify(group)).digest("hex");
function log(group, type, summary, now = Date.now()) {
  group.journal = [...group.journal, { id: randomUUID(), at: now, type, summary }].slice(-60);
}
function syncBaseline(group, baseline) {
  if (group.baseline && group.baseline !== baseline) {
    group.habits = {}; group.candidates = []; group.blocked = []; group.lastChangedAt = 0; group.generation++;
    for (const change of group.changes) change.status = "stale";
    log(group, "base-changed", "基础人设已变更，旧成长不再套用，等待新互动。");
  }
  group.baseline = baseline;
}
function enough(refs) {
  if (refs.length < 3 || new Set(refs.map(ref => ref.textHash)).size < 2) return false;
  const times = refs.map(ref => ref.at).sort((a, b) => a - b);
  const days = new Set(times.map(at => new Date(at + 8 * 3600_000).toISOString().slice(0, 10)));
  return times.at(-1) - times[0] >= 30 * 60_000 && (new Set(refs.map(ref => ref.by)).size >= 2 || days.size >= 2);
}
const recent = (refs, now) => refs.filter(ref => now - ref.at <= 30 * day && ref.at <= now);
function applyOne(group, now = Date.now()) {
  if (!group.enabled || !group.learningEnabled || now - group.lastChangedAt < stepInterval) return false;
  const candidates = group.candidates.map(candidate => ({ ...candidate, refs: recent(candidate.refs, now) }))
    .filter(candidate => !group.blocked.includes(`${candidate.dimension}:${candidate.value}`)
      && enough(candidate.refs));
  // Conflicting recent group feedback remains pending instead of flipping repeatedly.
  const selected = candidates.filter(candidate => group.habits[candidate.dimension]?.value !== candidate.value
      && !candidates.some(other => other.dimension === candidate.dimension && other.value !== candidate.value
        && other.refs.at(-1).at >= candidate.refs.at(-1).at - 3 * day))
    .sort((a, b) => b.refs.at(-1).at - a.refs.at(-1).at)[0];
  if (!selected) return false;
  const id = randomUUID(), previous = group.habits[selected.dimension] ?? null;
  const habit = { value: selected.value, refs: selected.refs.slice(-20), since: now, changeId: id };
  group.habits[selected.dimension] = habit; group.lastChangedAt = now;
  group.changes = [...group.changes, { id, at: now, dimension: selected.dimension, previous, next: habit, baseline: group.baseline, status: "applied" }].slice(-30);
  group.candidates = group.candidates.filter(candidate => candidate.dimension !== selected.dimension);
  log(group, "grown", `${growthHabits[selected.dimension].label}逐渐调整为「${option(selected.dimension, selected.value).label}」，依据${selected.refs.length}条独立互动反馈。`, now);
  return true;
}
export function growthLearningStamp(groupId) {
  if (!validId(groupId)) return { enabled: false, learningEnabled: false, generation: 0 };
  const group = groupOf(read(), groupId);
  return { enabled: group.enabled, learningEnabled: group.learningEnabled, generation: group.generation };
}
export function hasGrowthFeedback(text) {
  // A clear request can be phrased as a question (for example, “能不能短一点？”).
  // The multi-message evidence threshold below still prevents one request from changing group style.
  return typeof text === "string" && Object.values(growthHabits).some(dimension => Object.values(dimension.values).some(value => value.cue.test(text)));
}
export function validateGrowthObservations(value, batch) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap(item => {
    const chosen = option(item?.dimension, item?.value);
    if (!chosen || !Array.isArray(item.evidenceIds) || item.evidenceIds.length > 6) return [];
    const refs = [...new Set(item.evidenceIds)].filter(id => Number.isInteger(id) && id >= 1 && id <= batch.length).map(id => batch[id - 1])
      .filter(message => message.growthEligible && hasGrowthFeedback(message.text) && supports(item.dimension, item.value, message.text)
        && !Object.keys(growthHabits[item.dimension].values).some(value => value !== item.value && supports(item.dimension, value, message.text))
        && /^[a-f\d]{64}$/u.test(message.sourceRef ?? "") && Number.isFinite(message.at) && validId(message.userId))
      .map(message => ({ hash: message.sourceRef, at: message.at, userId: message.userId, generation: message.growthGeneration, baseline: message.growthBaseline,
        textHash: createHash("sha256").update(message.text.normalize("NFKC").replace(/\s+/gu, " ").trim()).digest("hex") }));
    return refs.length ? [{ dimension: item.dimension, value: item.value, refs }] : [];
  });
}
export function mergeGrowthObservations(groupId, observations, stamp, baseline) {
  if (!validId(groupId) || !baseline) return 0;
  const data = read(), group = groupOf(data, groupId);
  if (!group.enabled || !group.learningEnabled || group.generation !== stamp.generation) return 0;
  const valid = observations.flatMap(observation => option(observation.dimension, observation.value) ? [{ ...observation,
    refs: observation.refs.filter(ref => ref.generation === stamp.generation && ref.baseline === baseline) }] : []).filter(observation => observation.refs.length);
  if (!valid.length) return 0;
  syncBaseline(group, baseline);
  let added = 0;
  for (const observation of valid) {
    if (group.blocked.includes(`${observation.dimension}:${observation.value}`)) continue;
    let candidate = group.candidates.find(candidate => candidate.dimension === observation.dimension && candidate.value === observation.value);
    if (!candidate) { candidate = { dimension: observation.dimension, value: observation.value, refs: [] }; group.candidates.push(candidate); }
    const refs = observation.refs.map(({ userId, generation, baseline, ...ref }) => ({ ...ref, by: contributor(groupId, userId) }));
    const freshRefs = refs.filter(ref => !candidate.refs.some(previous => previous.hash === ref.hash));
    if (!freshRefs.length) continue;
    candidate.refs = recent([...candidate.refs, ...freshRefs], Date.now()).sort((a, b) => a.at - b.at).slice(-30); added += freshRefs.length;
  }
  if (!added) return 0;
  group.lastObservedAt = Date.now(); group.lastReflection = { at: Date.now(), feedbackCount: added, outcome: "pending" };
  if (applyOne(group)) group.lastReflection.outcome = "grown";
  data.groups[groupId] = group; write(data); return added;
}
export function personalityGrowthInstruction(groupId, baseline) {
  if (!validId(groupId)) return null;
  const group = groupOf(read(), groupId);
  if (!group.enabled || group.baseline !== baseline) return null;
  const habits = Object.entries(group.habits).filter(([dimension, habit]) => option(dimension, habit.value)).map(([dimension, habit]) => option(dimension, habit.value).instruction);
  if (!habits.length) return null;
  return "以下仅是本群在长期互动中逐渐形成的相处与表达习惯，适度自然体现，不向群友汇报成长过程。基础身份、核心性格、事实核实、隐私与安全规则始终优先。当前明确任务和个人偏好优先于群习惯；不把群习惯当成任一成员的偏好，不跨群使用，不声称有真实情绪或经历。不扩大主动发言、搜索、分享和表情权限或发送频率。\n" + habits.join("\n");
}
export function readPersonalityGrowth(groupId, baseline) {
  if (!validId(groupId)) throw new Error("请选择有效群。");
  const group = groupOf(read(), groupId), matches = !group.baseline || group.baseline === baseline;
  const reversible = group.changes.findLast(change => change.status === "applied" && change.baseline === baseline && group.habits[change.dimension]?.changeId === change.id);
  return { groupId, revision: revision(group), enabled: group.enabled, learningEnabled: group.learningEnabled, baselineMatches: matches,
    habits: matches ? Object.entries(group.habits).map(([dimension, habit]) => ({ dimension, label: growthHabits[dimension]?.label, value: habit.value,
      description: option(dimension, habit.value)?.label, since: habit.since, evidenceCount: habit.refs.length })) : [],
    candidates: matches ? group.candidates.map(candidate => ({ dimension: candidate.dimension, label: growthHabits[candidate.dimension]?.label,
      description: option(candidate.dimension, candidate.value)?.label, evidenceCount: recent(candidate.refs, Date.now()).length, ready: enough(recent(candidate.refs, Date.now())) })) : [],
    journal: group.journal.slice(-20).reverse(), blocked: group.blocked.map(id => { const [dimension, value] = id.split(":"); return option(dimension, value)?.label ?? "已撤回习惯"; }),
    lastReflection: group.lastReflection ?? null, nextAdjustmentAt: group.lastChangedAt ? group.lastChangedAt + stepInterval : null,
    rollbackId: matches ? reversible?.id ?? null : null };
}
export function controlPersonalityGrowth(groupId, input, baseline) {
  const data = read(), group = groupOf(data, groupId);
  if (!validId(groupId) || input?.revision !== revision(group)) throw Object.assign(new Error("成长记录刚有更新，请刷新后再操作。"), { statusCode: 409 });
  syncBaseline(group, baseline);
  if (input.action === "settings") {
    if (typeof input.enabled !== "boolean" || typeof input.learningEnabled !== "boolean") throw new Error("成长开关必须是布尔值。");
    group.enabled = input.enabled; group.learningEnabled = input.learningEnabled;
    log(group, "settings", `成长效果${group.enabled ? "启用" : "停用"}，新互动积累${group.learningEnabled ? "继续" : "暂停"}。`);
  } else if (input.action === "rollback") {
    const change = group.changes.findLast(change => change.status === "applied" && change.baseline === baseline && group.habits[change.dimension]?.changeId === change.id);
    if (!change || change.id !== input.changeId) throw new Error("这次调整已不是最新生效版本，请刷新。");
    if (change.previous) group.habits[change.dimension] = change.previous; else delete group.habits[change.dimension];
    change.status = "reverted"; group.blocked = [...new Set([...group.blocked, `${change.dimension}:${change.next.value}`])];
    group.candidates = group.candidates.filter(candidate => candidate.dimension !== change.dimension || candidate.value !== change.next.value);
    log(group, "rollback", `已撤回「${option(change.dimension, change.next.value).label}」，该方向暂停自动重学。`);
  } else if (input.action === "unblock") { group.blocked = []; log(group, "unblock", "允许从新的互动反馈重新学习已撤回方向。"); }
  else throw new Error("不支持的成长操作。");
  group.generation++; data.groups[groupId] = group; write(data); return readPersonalityGrowth(groupId, baseline);
}
export function forgetGrowthContributor(groupId, userId) {
  if (!validId(groupId) || !validId(userId)) return;
  const data = read(), group = data.groups[groupId]; if (!group) return;
  const by = contributor(groupId, userId), clean = refs => refs.filter(ref => ref.by !== by); let changed = false;
  for (const candidate of group.candidates) { const refs = clean(candidate.refs); if (refs.length !== candidate.refs.length) changed = true; candidate.refs = refs; }
  for (const [dimension, habit] of Object.entries(group.habits)) {
    const refs = clean(habit.refs); if (refs.length === habit.refs.length) continue;
    changed = true; habit.refs = refs; if (!enough(refs)) delete group.habits[dimension];
  }
  if (group.changes.some(change => change.previous?.refs.some(ref => ref.by === by) || change.next.refs.some(ref => ref.by === by))) changed = true;
  if (!changed) return;
  group.changes = []; group.generation++; log(group, "forget", "已移除一位成员的互动贡献；不足以继续支持的成长习惯已停用。");
  data.groups[groupId] = group; write(data);
}
export function maintainPersonalityGrowth(groupId, baseline) {
  const data = read(), group = data.groups[groupId];
  if (!group) return;
  if (group.baseline && group.baseline !== baseline) { syncBaseline(group, baseline); write(data); return; }
  if (!group.enabled || !group.learningEnabled) return;
  if (applyOne(group)) { group.lastReflection = { at: Date.now(), outcome: "grown", feedbackCount: 0 }; data.groups[groupId] = group; write(data); }
}
