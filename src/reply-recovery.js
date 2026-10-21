import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync } from "node:fs";
import { readAccessControl } from "./access-control-store.js";
import { readLlmSettings } from "./llm-settings-store.js";
import { settingsForGroup, personaRevision, personaFields } from "./group-personas.js";
import { memberLearningStamp } from "./member-impressions.js";
import { recoveryId, readRecoveryDelivery, sendRecoveredReply } from "./recovery-delivery.js";
const folder = new URL("../.local/reply-recovery/", import.meta.url);
const delays = [60_000, 180_000, 600_000];
const active = new Set(["pending", "running"]);
function pathFor(id) { if (!/^[a-f\d]{32}$/u.test(id)) throw new Error("Invalid recovery ID"); return new URL(id + ".json", folder); }
function jobs() {
  let names; try { names = readdirSync(folder); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return names.filter(name => /^[a-f\d]{32}\.json$/u.test(name)).flatMap(name => {
    try { const job = JSON.parse(readFileSync(new URL(name, folder), "utf8")); return job.id + ".json" === name ? [job] : []; } catch { return []; }
  });
}
function save(job) { const file = pathFor(job.id), temp = new URL(file.href + ".tmp"); writeFileSync(temp, JSON.stringify(job), { mode: 0o600 }); renameSync(temp, file); }
function revision(settings, scope, groupId) { return scope === "group" ? settingsForGroup(settings, groupId).groupPersonaRevision : personaRevision(personaFields(settings)); }
export function enqueueReplyRecovery({ event, authorized, code = "TRANSIENT_FAILURE", forwardSourceMessageId = null }) {
  const scope = authorized.scope, peerId = scope === "group" ? authorized.groupId : authorized.userId, sourceMessageId = String(event.message_id ?? "");
  if (!["group", "private"].includes(scope) || !/^\d{1,32}$/u.test(peerId ?? "") || !/^-?\d{1,32}$/u.test(sourceMessageId) || !/^\d{1,32}$/u.test(String(event.self_id ?? ""))) return null;
  const settings = readLlmSettings(), id = recoveryId(scope, peerId, sourceMessageId);
  if (readRecoveryDelivery(id)) return id;
  const existing = jobs(); if (existing.some(job => job.id === id)) return id;
  if (existing.filter(job => active.has(job.state)).length >= 256) throw new Error("Recovery queue full");
  const now = Date.now(), job = { id, scope, peerId, userId: authorized.userId, sourceMessageId, selfId: String(event.self_id),
    sourceAt: Number(event.time) * 1000 || now, createdAt: now, nextAt: now + delays[0], expiresAt: now + 6*3600_000, attempts: 0, state: "pending",
    personaRevision: revision(settings, scope, peerId), generation: scope === "group" ? memberLearningStamp(peerId, authorized.userId).generation : null,
    forwardSourceMessageId: /^-?\d{1,32}$/u.test(String(forwardSourceMessageId ?? "")) ? String(forwardSourceMessageId) : null,
    imageSourceMessageId: /^-?\d{1,32}$/u.test(String(authorized.imageReference?.messageId ?? "")) ? String(authorized.imageReference.messageId) : null,
    code: /^[A-Z_\d]{1,60}$/u.test(code) ? code : "TRANSIENT_FAILURE" };
  mkdirSync(folder, { recursive: true }); let fd;
  try { fd = openSync(pathFor(id), "wx", 0o600); writeFileSync(fd, JSON.stringify(job)); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
  return id;
}
export function recoveryStillAllowed(job) {
  const access = readAccessControl(), settings = readLlmSettings();
  return Date.now() < job.expiresAt && (job.scope === "group" ? access.groupIds.includes(job.peerId) : access.userIds.includes(job.peerId))
    && revision(settings, job.scope, job.peerId) === job.personaRevision
    && (job.scope !== "group" || memberLearningStamp(job.peerId, job.userId).generation === job.generation)
    && (!job.forwardSourceMessageId || settings.forwardReadingEnabled !== false)
    && (!job.imageSourceMessageId || settings.visionEnabled);
}
export function readReplyRecoveryStatus() {
  const counts = { pending: 0, running: 0, delivered: 0, uncertain: 0, exhausted: 0, cancelled: 0, verified: 0 };
  for (const job of jobs()) if (Object.hasOwn(counts, job.state)) counts[job.state]++;
  try {
    const dir = new URL("../.local/recovery-deliveries/", import.meta.url);
    let sent = 0, verified = 0;
    for (const name of readdirSync(dir).filter(name => /^[a-f\d]{32}\.json$/u.test(name))) {
      const receipt = JSON.parse(readFileSync(new URL(name, dir), "utf8"));
      if (["sent", "verified"].includes(receipt.state)) sent++;
      if (receipt.state === "verified") verified++;
    }
    counts.delivered = Math.max(counts.delivered, sent); counts.verified = verified;
  } catch {}
  return counts;
}
export function startReplyRecovery({ sendAction, connected, run, pace }) {
  let stopped = false, busy = false;
  for (const job of jobs()) if (job.state === "running") {
    const receipt = readRecoveryDelivery(job.id);
    job.state = receipt ? (["sent", "verified"].includes(receipt.state) ? "delivered" : "uncertain")
      : job.attempts >= 3 ? "exhausted" : "pending";
    job.nextAt = Date.now()+30000; save(job);
  }
  const tick = async () => {
    if (stopped || busy || !connected()) return;
    busy = true;
    try {
      const job = jobs().filter(job => job.state === "pending" && job.nextAt <= Date.now()).sort((a,b) => a.createdAt-b.createdAt)[0];
      if (!job) return;
      if (!recoveryStillAllowed(job)) { job.state = "cancelled"; save(job); return; }
      const previous = readRecoveryDelivery(job.id);
      if (previous) { job.state = ["sent", "verified"].includes(previous.state) ? "delivered" : "uncertain"; save(job); return; }
      job.state = "running"; job.attempts++; save(job);
      try {
        const self = await sendAction("get_login_info", {});
        if (String(self.user_id) !== job.selfId) { job.state = "cancelled"; save(job); return; }
        const allowed = () => !stopped && connected() && recoveryStillAllowed(job);
        const result = await run(job, allowed);
        if (!allowed()) { job.state = "cancelled"; save(job); return; }
        if (!result || result.status !== "ok" || !result.reply?.trim()) { const error = new Error("Recovery result unavailable"); error.recoveryRetryable = result?.recoveryRetryable === true; throw error; }
        const sent = await sendRecoveredReply({ scope: job.scope, peerId: job.peerId, sourceMessageId: job.sourceMessageId, text: result.reply, selfId: job.selfId,
          sendAction: (action, params, guard = allowed) => pace(action, params, sendAction, guard), allowed });
        job.state = sent?.cancelled ? "cancelled" : sent?.duplicate && !sent.message_id ? "uncertain" : "delivered";
        job.deliveredAt = Date.now(); save(job);
      } catch (error) {
        const receipt = readRecoveryDelivery(job.id);
        if (receipt) job.state = ["sent", "verified"].includes(receipt.state) ? "delivered" : "uncertain";
        else if (error.recoveryRetryable === false || job.attempts >= 3 || Date.now() >= job.expiresAt) job.state = "exhausted";
        else { job.state = "pending"; job.nextAt = Date.now() + delays[job.attempts]; }
        job.lastCode = /^[A-Z_\d]{1,60}$/u.test(error.code ?? "") ? error.code : "RECOVERY_FAILED"; save(job);
      }
    } catch { console.warn("后台补发队列暂时无法处理，将在下一轮继续。"); }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 15000); timer.unref?.(); void tick();
  return { stop() { stopped = true; clearInterval(timer); } };
}
