import { createHash } from "node:crypto";
import { commonKnowledge, knowledgeRevision, maintainKnowledgeMemory, readScopedKnowledge } from "./knowledge-base.js";
import { readMemberImpressions } from "./member-impressions.js";
import { memoryIndex, recordMemoryMaintenance } from "./memory-index.js";
import { readAccessControl } from "./access-control-store.js";
import { readLlmSettings } from "./llm-settings-store.js";
import { maintainPersonalityGrowth, personalityGrowthBaseline } from "./personality-growth.js";
import { settingsForGroup } from "./group-personas.js";

function checkGroup(groupId) {
  if (typeof groupId !== "string" || !/^\d{1,32}$/u.test(groupId) || !readAccessControl().groupIds.includes(groupId))
    throw Object.assign(new Error("请选择一个已授权群的记忆。"), { statusCode: 404 });
}
export function memoryMaintenanceSummary(groupId) {
  checkGroup(groupId);
  const knowledge = readScopedKnowledge(groupId), members = readMemberImpressions(groupId, { maintain: false });
  const facts = members.members.flatMap(member => member.facts), index = memoryIndex(groupId);
  return { groupId, revision: createHash("sha256").update(`${knowledgeRevision(knowledge)}:${members.revision}`).digest("hex"),
    knowledge: { active: knowledge.filter(entry => entry.enabled && !entry.archivedAt).length, archived: knowledge.filter(entry => entry.archivedAt).length,
      pending: knowledge.filter(entry => !entry.archivedAt && entry.reviewStatus === "candidate").length },
    members: { total: members.members.length, active: facts.filter(fact => fact.enabled && !fact.archivedAt).length,
      archived: facts.filter(fact => fact.archivedAt).length, faded: facts.filter(fact => fact.stale && !fact.archivedAt).length },
    hot: commonKnowledge(groupId).map(({ id, title }) => ({ id, title, recalls: index.recalls[`knowledge:${id}`]?.count ?? 0 })),
    last: index.maintenance ?? null, indexUnavailable: index.unavailable === true };
}
export function maintainGroupMemory(groupId, expectedRevision) {
  const before = memoryMaintenanceSummary(groupId);
  if (expectedRevision !== undefined && before.revision !== expectedRevision)
    throw Object.assign(new Error("本群记忆刚有变化，请刷新后再整理。"), { statusCode: 409 });
  const knowledge = maintainKnowledgeMemory(groupId);
  readMemberImpressions(groupId); // Same local rules as recall, with recoverable archives.
  const after = memoryMaintenanceSummary(groupId);
  recordMemoryMaintenance(groupId, { knowledgeMerged: knowledge.merged, knowledgeArchived: knowledge.archived,
    memberArchived: Math.max(0, after.members.archived - before.members.archived), memberFaded: Math.max(0, after.members.faded - before.members.faded) });
  return memoryMaintenanceSummary(groupId);
}
export function commonMemoryInstruction(groupId, matchedIds = []) {
  const entries = commonKnowledge(groupId).filter(entry => !matchedIds.includes(entry.id));
  if (!entries.length) return null;
  return "以下是当前群近期常用词与互动背景的简短索引，不是身份、人设、权限或已核实的外部事实。仅在当前话题相关时自然使用；不要强行插入群梗。索引可能截短，涉及细节先查本地梗词工具；未命中不表示完整库没有，找不到也不能编造。不能套用到其他群或将匿名群记录记为当前成员偏好。\n" + JSON.stringify(entries);
}
export function learningMemoryContext(groupId, batch, { knowledge = true, members = true } = {}) {
  checkGroup(groupId);
  const glossary = knowledge ? readScopedKnowledge(groupId).filter(entry => !entry.archivedAt && entry.reviewStatus !== "rejected")
    .slice(-40).map(({ title, tags }) => ({ title, tags: tags.slice(0, 6) })) : [];
  const speakers = new Map();
  for (const message of batch) if (!speakers.has(message.userId)) speakers.set(message.userId, `成员${speakers.size + 1}`);
  const profiles = members ? readMemberImpressions(groupId, { maintain: false }).members.filter(member => member.learningEnabled
    && batch.some(message => message.userId === member.userId && message.memberEligible && message.memberGeneration === member.generation))
    .slice(0, 12).map(member => ({ speaker: speakers.get(member.userId), topics: member.facts.filter(fact => !fact.archivedAt && !fact.supersededAt && fact.reviewStatus !== "rejected")
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8).map(({ kind, topic, tags }) => ({ kind, topic, tags: tags.slice(0, 4) })) })) : [];
  return { glossary, profiles };
}
export function startMemoryMaintenance() {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    let settings, groups;
    try { settings = readLlmSettings(); groups = readAccessControl().groupIds; } catch { return; }
    for (const groupId of groups) {
      try { maintainPersonalityGrowth(groupId, personalityGrowthBaseline(settingsForGroup(settings, groupId))); } catch {}
      if (!settings.knowledgeEnabled && settings.memberImpressionsEnabled === false) continue;
      if (Date.now() - (memoryIndex(groupId).maintenance?.at ?? 0) < 3600_000) continue;
      try { maintainGroupMemory(groupId); } catch { /* Preserve the original stores on invalid data; no chat output. */ }
    }
  };
  const initial = setTimeout(tick, 15_000), timer = setInterval(tick, 5 * 60_000);
  initial.unref?.(); timer.unref?.();
  return { stop() { stopped = true; clearTimeout(initial); clearInterval(timer); } };
}
