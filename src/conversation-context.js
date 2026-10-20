const groups = new Map();
const ttl = 15 * 60_000;
const sensitive = /(?:sk-[a-z\d]{12,}|tvly-|api.?key|密钥|密码|cookie|sessdata|身份证|手机号|家庭住址|\b\d{11,}\b)/iu;
const errorReply = /^(?:暂时无法|模型服务|模型请求|这张图片无法|OneBot|这次暂时没能)/u;

function stateFor(groupId) {
  const now = Date.now();
  for (const [id, state] of groups) if (now - state.updatedAt > ttl) groups.delete(id);
  if (!groups.has(groupId)) {
    if (groups.size >= 128) return null;
    groups.set(groupId, { lines: [], updatedAt: now, bot: null, warmedAt: 0, warming: null });
  }
  const state = groups.get(groupId);
  state.lines = state.lines.filter((line) => now - line.at < ttl);
  return state;
}

export function rememberGroupLine({ groupId, userId, text, messageId, isBot = false, at = Date.now(), followup = false, targetUserId = null, name = "", stickerId = null }) {
  if (!/^\d{1,32}$/u.test(groupId) || typeof text !== "string" || !text.trim() || text.length > 4000 || sensitive.test(text) || (isBot && errorReply.test(text))) return;
  const state = stateFor(groupId);
  if (!state || (messageId && state.lines.some((line) => line.messageId === String(messageId)))) return;
  const previousMember = [...state.lines].reverse().find((line) => !line.isBot);
  state.lines.push({ userId, text: text.trim().slice(0, 500), messageId: messageId ? String(messageId) : null, isBot, at,
    name: String(name).slice(0, 40), stickerId: /^[a-f\d-]{36}$/u.test(stickerId ?? "") ? stickerId : null });
  state.lines.sort((a, b) => a.at - b.at);
  state.lines = state.lines.slice(-20);
  state.updatedAt = Date.now();
  if (isBot && (!state.bot || at >= state.bot.at)) state.bot = { at, messageId: messageId ? String(messageId) : null, targetUserId: targetUserId ?? previousMember?.userId,
    followups: followup ? (state.bot?.followups ?? 0) + 1 : 0 };
}

export function isPossibleBotFollowup({ groupId, userId, text, replyIds = [], mentionsOther = false }) {
  const state = stateFor(groupId);
  const bot = state?.bot;
  if (!bot || mentionsOther || Date.now() - bot.at > 120000 || bot.followups >= 3 || sensitive.test(text)) return false;
  if (bot.messageId && replyIds.includes(bot.messageId)) return true;
  if (replyIds.length) return false; // A quote of someone else must not become an accidental follow-up.
  if (!text.trim() || text.length > 180) return false;
  const sinceBot = state.lines.filter((line) => !line.isBot && line.at > bot.at).length;
  if (sinceBot >= 5) return false;
  const directed = /(?:^你|[吗呢？?]|怎么|为什么|为啥|什么|啥意思|然后|继续|感觉|说下去|确实|对呀|对啊|哈哈)/u.test(text);
  const sameSpeaker = userId === bot.targetUserId;
  return directed && (sameSpeaker || (Date.now() - bot.at < 45000 && sinceBot < 2 && /^(?:你|然后呢|感觉什么|什么感觉)/u.test(text)));
}

export function recentGroupContext(groupId, excludeId) {
  const names = new Map();
  return (stateFor(groupId)?.lines ?? []).filter((line) => !excludeId || line.messageId !== String(excludeId)).slice(-12).map((line) => {
    if (!names.has(line.userId)) names.set(line.userId, `群友${names.size + 1}`);
    return { speaker: line.isBot ? "机器人（bot实际已发出的回复）" : names.get(line.userId), speakerId: line.isBot ? "bot" : line.userId,
      name: line.name, text: line.text, isBot: line.isBot, messageId: line.messageId };
  });
}

export async function warmGroupContext({ groupId, selfId, sendAction, since = 0 }) {
  const state = stateFor(groupId);
  if (!state) return;
  if (state.warming) return state.warming;
  if (Date.now() - state.warmedAt < ttl) return;
  state.warmedAt = Date.now();
  state.warming = (async () => {
    try {
      const result = await sendAction("get_group_msg_history", { group_id: groupId, count: 20, disable_get_url: true });
      const messages = Array.isArray(result?.messages) ? result.messages.slice(-20) : [];
      messages.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
      for (const message of messages) {
        const at = Number(message.time) * 1000;
        if (!Number.isFinite(at) || at < since || at > Date.now() + 30000 || Date.now() - at > ttl || String(message.group_id ?? groupId) !== groupId) continue;
        const text = Array.isArray(message.message) ? message.message.filter((part) => part.type === "text").map((part) => part.data?.text ?? "").join("") : "";
        rememberGroupLine({ groupId, userId: String(message.user_id ?? message.sender?.user_id), text, messageId: message.message_id,
          isBot: String(message.user_id ?? message.sender?.user_id) === selfId, at, name: message.sender?.card || message.sender?.nickname });
      }
    } catch { /* Missing history never blocks normal replies. */ }
    finally { state.warming = null; }
  })();
  return state.warming;
}

export function clearGroupConversations(groupId) { if (groupId) groups.delete(groupId); else groups.clear(); }

export function findGroupLine(groupId, messageId) {
  return stateFor(groupId)?.lines.find(line => line.messageId === String(messageId)) ?? null;
}
