import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { readAccessControl } from "./access-control-store.js";
import { readLlmSettings } from "./llm-settings-store.js";
import { settingsForGroup } from "./group-personas.js";
import { getLlmApiKey } from "./config.js";
import { recentGroupContext } from "./conversation-context.js";
import { browseBilibiliFeed, watchBilibiliCandidate } from "./bilibili-browser.js";
import { decideBilibiliDiscovery } from "./llm.js";
import { proactiveQuietUntil } from "./proactive-chat-state.js";

const stateFile = new URL("../.local/video-discovery-state.json", import.meta.url);
const receipts = new URL("../.local/video-recommendations/", import.meta.url);
let active = false;
const emptyGroup = () => ({ nextAt: 0, seen: [], shared: 0, reviewed: 0, waiting: false, quietUntil: 0 });
function readState() {
  try { const value = JSON.parse(readFileSync(stateFile, "utf8")); if (value.version !== 1 || !value.groups || typeof value.groups !== "object" || Array.isArray(value.groups)) throw new Error(); return value; }
  catch (error) { if (error.code === "ENOENT") return { version: 1, groups: {} }; throw new Error("BILI_DISCOVERY_STATE"); }
}
function update(groupId, patch) {
  const state = readState();
  const previous = state.groups[groupId] ?? emptyGroup();
  state.groups[groupId] = { ...previous, ...(typeof patch === "function" ? patch(previous) : patch) };
  mkdirSync(new URL("../.local/", import.meta.url), { recursive: true });
  const temp = new URL(stateFile.href + "." + randomBytes(6).toString("hex") + ".tmp");
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 }); renameSync(temp, stateFile);
  return state.groups[groupId];
}
const receiptPath = (groupId, bvid) => new URL(createHash("sha256").update(`${groupId}:${bvid}`).digest("hex").slice(0, 32) + ".json", receipts);
function hasReceipt(groupId, bvid) { try { readFileSync(receiptPath(groupId, bvid)); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
const nowAfter = seconds => Date.now() + seconds * 1000;

export function acknowledgeVideoDiscoveryReply({ groupId, mentioned = false, replyIds = [], text = "" }) {
  const group = readState().groups[groupId];
  if (!group?.waiting) return false;
  const reaction = Date.now() - group.lastSharedAt < 3 * 60000 && /^(?:哈{2,}|笑死|确实|有意思|好看|好玩|不错|看了|看完了|谢谢|好可爱|有道理|这个(?:视频)?不错)[！!。，,.～~\s]*$/u.test(text.trim());
  if (!mentioned && !replyIds.includes(group.messageId) && !reaction) return false;
  update(groupId, { waiting: false, quietUntil: 0, nextAt: nowAfter(30) });
  return true;
}

export function readVideoDiscoveryStatus() {
  const settings = readLlmSettings(), access = readAccessControl(), state = readState();
  let uncertain = 0;
  try { for (const name of readdirSync(receipts).filter(name => /^[a-f0-9]{32}\.json$/u.test(name))) {
    try { if (["sending", "uncertain"].includes(JSON.parse(readFileSync(new URL(name, receipts), "utf8")).state)) uncertain++; } catch {}
  } } catch {}
  return { enabled: settings.videoDiscoveryEnabled, videoUnderstandingEnabled: settings.videoUnderstandingEnabled, active, uncertain,
    groups: settings.videoDiscoveryGroupIds.filter(id => access.groupIds.includes(id)).map(groupId => {
      const group = state.groups[groupId] ?? emptyGroup();
      return { groupId, shared: group.shared, reviewed: group.reviewed, nextAt: group.nextAt,
        waiting: Boolean(group.waiting), quietUntil: Math.max(group.quietUntil ?? 0, settings.proactivePauseWhenIgnored ? proactiveQuietUntil(groupId) : 0),
        lastSharedAt: group.lastSharedAt ?? null, lastCode: group.lastCode ?? null, lastTitle: group.lastTitle ?? null };
    }) };
}

export function startVideoDiscovery({ sendAction, connected, pace, onShared = () => {} }) {
  let stopped = false;
  async function examine(groupId, feed) {
    const initial = settingsForGroup(readLlmSettings(), groupId), revision = initial.groupPersonaRevision;
    const allowed = () => {
      if (stopped || !connected()) return false;
      const settings = readLlmSettings();
      return settings.videoDiscoveryEnabled && settings.videoUnderstandingEnabled && settings.videoDiscoveryGroupIds.includes(groupId)
        && readAccessControl().groupIds.includes(groupId) && settingsForGroup(settings, groupId).groupPersonaRevision === revision
        && (!settings.proactivePauseWhenIgnored || Date.now() >= Math.max(readState().groups[groupId]?.quietUntil ?? 0, proactiveQuietUntil(groupId)));
    };
    if (!allowed()) return;
    const previous = readState().groups[groupId] ?? emptyGroup();
    const candidates = feed.filter(item => !(previous.seen ?? []).includes(item.bvid) && !hasReceipt(groupId, item.bvid)
      && (!item.duration || item.duration <= initial.videoMaxMinutes * 60));
    if (!candidates.length) { update(groupId, { nextAt: nowAfter(300), lastCode: "NO_NEW_CANDIDATE" }); return; }
    update(groupId, { nextAt: nowAfter(300), lastCode: "SELECTING" });
    const apiKey = getLlmApiKey(), context = recentGroupContext(groupId);
    const chosen = await decideBilibiliDiscovery({ apiKey, settings: initial, groupId, candidates, context, allowed });
    if (!allowed()) return;
    if (!chosen.index) { update(groupId, group => ({ nextAt: nowAfter(chosen.nextCheckSeconds), lastCode: "NOT_INTERESTED", seen: [...new Set([...(group.seen ?? []), ...candidates.map(item => item.bvid)])].slice(-256) })); return; }
    const candidate = candidates[chosen.index - 1];
    update(groupId, group => ({ seen: [...new Set([...(group.seen ?? []), candidate.bvid])].slice(-256), lastCode: "READING" }));
    const video = await watchBilibiliCandidate(candidate, initial, allowed);
    if (!allowed()) return;
    update(groupId, group => ({ reviewed: group.reviewed + 1, lastCode: "REVIEWING" }));
    const decision = await decideBilibiliDiscovery({ apiKey: getLlmApiKey(), settings: settingsForGroup(readLlmSettings(), groupId), groupId, video, context, allowed });
    if (!allowed()) return;
    update(groupId, { nextAt: nowAfter(decision.nextCheckSeconds), lastCode: decision.share ? "READY" : "NOT_SHARING" });
    if (!decision.share) return;
    const note = decision.note.replace(/https?:\/\/\S+/gu, "").trim();
    if (!note) return;
    const text = `${note}\n${video.title}\n${candidate.url}`;
    const file = receiptPath(groupId, candidate.bvid);
    mkdirSync(receipts, { recursive: true });
    const receipt = { groupId, bvid: candidate.bvid, at: Date.now(), state: "sending", textHash: createHash("sha256").update(text).digest("hex") };
    try { writeFileSync(file, JSON.stringify(receipt), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code === "EEXIST") return; throw error; }
    try {
      const sent = await pace("send_msg", { message_type: "group", group_id: groupId, message: text, auto_escape: true }, sendAction, allowed);
      if (sent?.cancelled) { receipt.state = "cancelled"; writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 }); return; }
      if (!sent?.message_id) throw new Error("BILI_DELIVERY_UNCERTAIN");
      receipt.messageId = String(sent.message_id); receipt.state = "sent";
      writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
      update(groupId, group => ({ shared: group.shared + 1, lastSharedAt: Date.now(), messageId: receipt.messageId,
        waiting: readLlmSettings().proactivePauseWhenIgnored, quietUntil: readLlmSettings().proactivePauseWhenIgnored ? nowAfter(65 * 60) : 0,
        lastTitle: video.title.slice(0, 180), lastCode: "SHARED" }));
      try { await onShared({ groupId, text, messageId: receipt.messageId }); } catch {}
      try {
        const message = await sendAction("get_msg", { message_id: receipt.messageId });
        const actualText = typeof message.message === "string" ? message.message : (message.message ?? []).filter(item => item.type === "text").map(item => item.data?.text ?? "").join("");
        const login = await sendAction("get_login_info", {});
        if (String(message.group_id) === groupId && String(message.user_id ?? message.sender?.user_id) === String(login.user_id)
          && createHash("sha256").update(actualText).digest("hex") === receipt.textHash) {
          receipt.state = "verified"; writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
        }
      } catch {}
    } catch {
      if (receipt.state === "sending") { receipt.state = "uncertain"; writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 }); }
      update(groupId, { lastCode: "DELIVERY_UNCERTAIN", nextAt: nowAfter(600) });
    }
  }

  async function tick() {
    if (stopped || active || !connected()) return;
    const settings = readLlmSettings(), access = readAccessControl();
    if (!settings.videoDiscoveryEnabled || !settings.videoUnderstandingEnabled || !getLlmApiKey()) return;
    const state = readState(), now = Date.now();
    const groups = settings.videoDiscoveryGroupIds.filter(groupId => access.groupIds.includes(groupId)).filter(groupId => {
      const group = state.groups[groupId] ?? emptyGroup();
      return now >= group.nextAt && (!settings.proactivePauseWhenIgnored || now >= Math.max(group.quietUntil ?? 0, proactiveQuietUntil(groupId)));
    });
    if (!groups.length) return;
    active = true;
    try {
      const feed = await browseBilibiliFeed(() => !stopped && connected() && readLlmSettings().videoDiscoveryEnabled
        && groups.some(groupId => readLlmSettings().videoDiscoveryGroupIds.includes(groupId) && readAccessControl().groupIds.includes(groupId)));
      for (const groupId of groups) {
        if (stopped) break;
        try { await examine(groupId, feed); }
        catch (error) { update(groupId, { lastCode: /^[A-Z_]{1,60}$/u.test(error.message ?? "") ? error.message : "VIDEO_OR_MODEL_UNAVAILABLE", nextAt: nowAfter(300) }); }
      }
    } catch (error) {
      for (const groupId of groups) update(groupId, { lastCode: /^[A-Z_]{1,60}$/u.test(error.message ?? "") ? error.message : "BROWSER_UNAVAILABLE", nextAt: nowAfter(300) });
    } finally { active = false; }
  }
  const timer = setInterval(() => { void tick().catch(() => {}); }, 15000); timer.unref?.();
  return { stop() { stopped = true; clearInterval(timer); } };
}
