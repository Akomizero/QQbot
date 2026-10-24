import { isNapCatImageFile, MAX_IMAGE_COUNT } from "./image-input.js";
import { groupMemberContextSince } from "./member-impressions.js";
import { messageReferences } from "./message-context.js";
import { isVisualCorrectionText } from "./visual-memory-store.js";
import { isExactImageReturnRequest } from './image-exchange.js';

// Store platform file identifiers only. Image bytes are obtained on demand through
// the existing get_image / validation path, never saved as conversation memory.
const groups = new Map();
const ttl = 180_000, quoteTtl = 15 * 60_000;
const validId = value => /^-?\d{1,32}$/u.test(String(value ?? ""));
export function isImageFollowupText(text) {
  return isExactImageReturnRequest(text) || /(?:(?:刚才|前面|之前|这|那)(?:的)?(?:一|1)?张.{0,6}(?:是谁|叫什么|什么角色)|如何评价|评价一下|怎么看|看一下|看看|看下|这(?:个|张|幅).{0,8}(?:图|表情|角色)|(?:图片|图里|图中|图上|动图|gif)|这个(?:呢|是谁|是什么))/iu.test(text ?? "");
}
function cutoff(groupId, since) { return Math.max(since || 0, groupMemberContextSince(groupId)); }
function stateFor(groupId, now = Date.now()) {
  for (const [key, state] of groups) if (now - state.at > ttl) groups.delete(key);
  let state = groups.get(groupId);
  if (!state) {
    if (groups.size >= 128) return null;
    state = { at: now, entries: [] }; groups.set(groupId, state);
  }
  state.entries = state.entries.filter(entry => now - entry.at <= ttl && entry.at > cutoff(groupId, 0));
  return state;
}
function imageEntry(event, groupId, selfId, since, now, maxAge) {
  if (String(event?.group_id ?? "") !== groupId || !validId(event?.message_id)
    || !/^\d{1,32}$/u.test(String(event.user_id ?? event.sender?.user_id ?? ""))) return null;
  const userId = String(event.user_id ?? event.sender?.user_id);
  if (userId === selfId || messageReferences(event.message).mentions.some(id => id !== selfId)) return null;
  const at = event.time === undefined ? now : Number(event.time) * 1000;
  if (!Number.isFinite(at) || at > now + 1500 || now - at > maxAge || at <= cutoff(groupId, since)) return null;
  const images = Array.isArray(event.message) ? event.message.filter(segment => segment?.type === "image") : [];
  if (!images.length || images.length > MAX_IMAGE_COUNT || images.some(segment => !isNapCatImageFile(segment.data?.file))) return null;
  return { groupId, userId, messageId: String(event.message_id), at, maxAge, images: images.map(segment => ({ type: "image", data: {
    file: segment.data.file, sub_type: Number(segment.data.sub_type) === 1 ? 1 : 0,
  } })) };
}
export function rememberGroupImages({ event, groupId, selfId, since = 0, now = Date.now() }) {
  const entry = imageEntry(event, groupId, selfId, since, now, ttl);
  if (!entry) return;
  const state = stateFor(groupId, now); if (!state) return;
  if (!state.entries.some(old => old.messageId === entry.messageId)) state.entries.push(entry);
  state.entries.sort((a, b) => a.at - b.at); state.entries = state.entries.slice(-20); state.at = now;
}
export async function resolveRecentGroupImages({ event, groupId, selfId, text, since = 0, sendAction, now = Date.now() }) {
  const refs = messageReferences(event.message);
  if (refs.mentions.some(id => id !== selfId)) return null;
  if (refs.replyIds.length) {
    // An explicit quote wins; never substitute an unrelated recent image.
    try {
      const source = await sendAction("get_msg", { message_id: refs.replyIds[0] });
      if (String(source?.message_id ?? refs.replyIds[0]) !== refs.replyIds[0]) return null;
      return imageEntry({ ...source, message_id: refs.replyIds[0] }, groupId, selfId, since, now, quoteTtl);
    } catch { return null; }
  }
  if (!isImageFollowupText(text) && !isVisualCorrectionText(text)) return null;
  const select = () => stateFor(groupId, now)?.entries.filter(entry => entry.userId === String(event.user_id)
    && entry.messageId !== String(event.message_id) && entry.at <= now && entry.at > cutoff(groupId, since)).at(-1) ?? null;
  const cached = select(); if (cached) return cached;
  // A restart must not silently lose the immediately preceding image. Read only
  // bounded recent history in this group, validating the sender and age again.
  try {
    const history = await sendAction("get_group_msg_history", { group_id: groupId, count: 20, disable_get_url: true });
    for (const message of (Array.isArray(history?.messages) ? history.messages.slice(-20) : [])) {
      rememberGroupImages({ event: message, groupId, selfId, since, now });
    }
  } catch { /* Missing history leaves the text request usable. */ }
  return select();
}
export function clearRecentGroupImages(groupId) { if (groupId) groups.delete(groupId); else groups.clear(); }
export function canUseRecentGroupImages(reference, { groupId, since = 0, now = Date.now() }) {
  return Boolean(reference && reference.groupId === groupId && reference.at > cutoff(groupId, since)
    && reference.at <= now && now - reference.at <= Math.min(reference.maxAge ?? ttl, quoteTtl));
}
