import { isNapCatImageFile } from "./image-input.js";
import { messageReferences } from "./message-context.js";
import { groupMemberContextSince } from "./member-impressions.js";

const recent = new Map(), recentTtl = 180_000;
const validId = value => typeof value === "string" && /^[A-Za-z0-9_+=/.-]{1,512}$/u.test(value);
const clean = value => String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "");
function redact(value) {
  let text = clean(value).replace(/(?:sk-[a-z\d]{12,}|tvly-[a-z\d-]{12,}|gh[pousr]_[a-z\d]{20,}|github_pat_[a-z\d_]{20,})/giu, "[凭据已隐藏]");
  for (const name of ["QQBOT_LLM_API_KEY", "TAVILY_API_KEY", "SERPER_API_KEY", "ONEBOT_ACCESS_TOKEN", "QQBOT_MODEL_PROXY_URL"]) {
    const secret = process.env[name]; if (secret?.length >= 8) text = text.replaceAll(secret, "[凭据已隐藏]");
  }
  return text;
}
export function forwardDescriptors(message) {
  const segments = Array.isArray(message) ? message : typeof message === "string"
    ? [...message.matchAll(/\[CQ:forward,id=([^,\]]+)[^\]]*\]/giu)].map(match => ({ type: "forward", data: { id: match[1] } })) : [];
  const result = [];
  for (const part of segments.slice(0, 100)) {
    if (part?.type === "forward") {
      const id = String(part.data?.id ?? "");
      if (validId(id) || Array.isArray(part.data?.content)) result.push({ id: validId(id) ? id : null, inline: Array.isArray(part.data?.content) ? part.data.content : null });
    } else if (part?.type === "node" && Array.isArray(part.data?.content)) {
      result.push({ id: null, inline: [part] });
    } else if (part?.type === "json" && typeof part.data?.data === "string" && part.data.data.length <= 16000) {
      try {
        const value = JSON.parse(part.data.data);
        if (value.app !== "com.tencent.multimsg") continue;
        const detail = value.meta?.detail ?? value.meta?.detail_1;
        const id = String(detail?.resid ?? detail?.m_resid ?? value.resid ?? "");
        if (validId(id)) result.push({ id, inline: null });
      } catch { /* Other cards are not forwarded conversations. */ }
    }
  }
  return result.slice(0, 2);
}
export const hasForwardMessage = message => forwardDescriptors(message).length > 0;
const forwardCue = text => /(?:转发|聊天记录|合并消息|这段(?:对话|记录)|刚才.{0,6}(?:记录|消息)|看看|看一下|如何评价|总结|概括|提炼)/u.test(text ?? "");
const scopeKey = ({ scope, groupId, userId }) => `${scope}:${scope === "group" ? groupId : userId}`;
function sinceFor(options) { return Math.max(options.since ?? 0, options.scope === "group" ? groupMemberContextSince(options.groupId) : 0); }
function inScope(source, options, maxAge = recentTtl) {
  const now = Date.now(), at = Number(source?.time) * 1000;
  if (!Number.isFinite(at) || at <= sinceFor(options) || at > now + 1500 || now - at > maxAge) return false;
  return options.scope === "group" ? String(source.group_id ?? "") === options.groupId
    : !source.group_id && String(source.user_id ?? source.sender?.user_id) === options.userId;
}
export function rememberForwardMessage(options) {
  const { event, userId, selfId } = options;
  if (!hasForwardMessage(event.message) || messageReferences(event.message).mentions.some(id => id !== selfId)) return;
  for (const [key, entries] of recent) { const kept = entries.filter(entry => Date.now() - entry.at <= recentTtl); if (kept.length) recent.set(key, kept); else recent.delete(key); }
  const key = scopeKey(options); if (recent.size >= 128 && !recent.has(key)) return;
  if (!/^-?\d{1,32}$/u.test(String(event.message_id ?? ""))) return;
  const entries = recent.get(key) ?? [];
  if (!entries.some(entry => entry.id === String(event.message_id))) entries.push({ id: String(event.message_id), userId, at: Date.now() });
  recent.set(key, entries.slice(-20)); // No forwarded body is cached.
}
export function clearForwardContext(groupId) { if (groupId) recent.delete(`group:${groupId}`); else recent.clear(); }
export async function resolveForwardSource(options) {
  const { event, selfId, userId, text, sendAction } = options;
  if (messageReferences(event.message).mentions.some(id => id !== selfId)) return null;
  if (hasForwardMessage(event.message)) return { message: event.message, messageId: String(event.message_id) };
  const quote = messageReferences(event.message).replyIds[0];
  if (quote) {
    try {
      const source = await sendAction("get_msg", { message_id: quote });
      return inScope(source, options, 15 * 60_000) && hasForwardMessage(source.message) ? { message: source.message, messageId: quote } : null;
    } catch { return null; }
  }
  if (!forwardCue(text)) return null;
  const cached = (recent.get(scopeKey(options)) ?? []).filter(entry => entry.userId === userId && Date.now() - entry.at <= recentTtl).at(-1);
  if (cached) {
    try {
      const source = await sendAction("get_msg", { message_id: cached.id });
      if (inScope(source, options) && String(source.user_id ?? source.sender?.user_id) === userId && hasForwardMessage(source.message)) return { message: source.message, messageId: cached.id };
    } catch {}
  }
  try {
    const response = await sendAction(options.scope === "group" ? "get_group_msg_history" : "get_friend_msg_history", {
      ...(options.scope === "group" ? { group_id: options.groupId } : { user_id: userId }), count: 20, disable_get_url: true,
    });
    const sources = (Array.isArray(response?.messages) ? response.messages.slice(-20) : []).filter(source => inScope(source, options)
      && String(source.user_id ?? source.sender?.user_id) === userId && hasForwardMessage(source.message)
      && !messageReferences(source.message).mentions.some(id => id !== selfId)
      && String(source.message_id) !== String(event.message_id)).sort((a, b) => Number(a.time) - Number(b.time));
    const source = sources.at(-1); return source ? { message: source.message, messageId: String(source.message_id) } : null;
  } catch { return null; }
}
export class ForwardReadError extends Error {
  constructor(message = "这条转发消息暂时无法展开，可能已经失效或 NapCat 未返回内容。请重新转发，或复制其中的文字给我。") { super(message); this.name = "ForwardReadError"; }
}
export async function readForwardedMessages(message, { sendAction, allowed = () => true, imageNumbers = [] } = {}) {
  const nodes = [], images = [], notes = new Set(), seen = new Set(), speakers = new Map();
  const requestedImages = new Set(imageNumbers.filter(number => Number.isInteger(number) && number > 0 && number <= 100).slice(0, 2));
  let apiCalls = 0, characters = 0, truncated = false, limitReached = false, imageCount = 0;
  function markLimit() { truncated = true; limitReached = true; }
  const deadline = Date.now() + 60_000;
  async function readAction(id) {
    if (!allowed() || Date.now() >= deadline) throw new ForwardReadError();
    let timer;
    try { return await Promise.race([sendAction("get_forward_msg", { message_id: id }), new Promise((_, reject) => { timer = setTimeout(() => reject(new ForwardReadError()), Math.max(1, deadline - Date.now())); })]); }
    finally { clearTimeout(timer); }
  }
  async function visit(descriptor, depth) {
    if (!allowed()) throw new ForwardReadError("当前会话已不在授权范围内。");
    if (depth > 4 || nodes.length >= 200 || characters >= 120000) { markLimit(); return; }
    let entries = descriptor.inline;
    if (descriptor.id) {
      if (seen.has(descriptor.id)) { notes.add("重复或循环的转发未重复展开"); return; }
      if (apiCalls >= 16) { markLimit(); return; }
      seen.add(descriptor.id); apiCalls++;
      try {
        const response = await readAction(descriptor.id);
        const fetched = Array.isArray(response) ? response : response?.messages ?? response?.content;
        if (!Array.isArray(fetched) || !fetched.length) throw new ForwardReadError();
        entries = fetched;
      } catch {
        notes.add("部分转发或嵌套记录未能完整展开");
        if (!entries?.length) return;
        truncated = true; notes.add("当前部分内容来自消息携带的预览节点");
      }
    }
    if (!Array.isArray(entries)) { notes.add("部分转发未返回消息节点"); return; }
    for (const entry of entries.slice(0, 200)) {
      if (nodes.length >= 200 || characters >= 120000) { markLimit(); break; }
      const data = entry?.type === "node" ? entry.data : entry;
      if (!data || typeof data !== "object") continue;
      const speakerKey = String(data.user_id ?? data.sender?.user_id ?? data.sender?.nickname ?? data.nickname ?? "unknown");
      if (!speakers.has(speakerKey)) speakers.set(speakerKey, `转发者${speakers.size + 1}`);
      const content = data.content ?? data.message;
      if (Array.isArray(content) && content.length > 100) markLimit();
      const parts = typeof content === "string" ? [{ type: "text", data: { text: content.replace(/\[CQ:[^\]]+\]/gu, "[非文字消息]") } }] : Array.isArray(content) ? content.slice(0, 100) : [];
      const fragments = [], nested = [];
      for (const part of parts) {
        const forwards = forwardDescriptors([part]);
        if (forwards.length) { nested.push(...forwards); fragments.push("[嵌套转发]"); }
        else if (part?.type === "text") {
          const text = typeof part.data?.text === "string" ? redact(part.data.text) : "";
          if (text.length > 12000) markLimit();
          fragments.push(text.slice(0, 12000));
        }
        else if (part?.type === "image") {
          imageCount++; const number = imageCount;
          if (images.length < 100 && (!requestedImages.size || requestedImages.has(number)) && isNapCatImageFile(part.data?.file)) {
            images.push({ type: "image", data: { file: part.data.file,
              ...(typeof part.data.url === "string" && part.data.url.length <= 4096 ? { url: part.data.url } : {}) }, forwardedNumber: number }); fragments.push(`[转发图片${number}，待识图]`);
          } else fragments.push(`[转发图片${number}，未读取]`);
        } else if (part?.type === "at") fragments.push("[@转发记录中的成员]");
        else if (["face", "mface"].includes(part?.type)) fragments.push("[QQ表情]");
        else if (part?.type === "video") fragments.push("[视频，尚未解析音视频]");
        else if (part?.type === "record") fragments.push("[语音，尚未转写]");
        else if (part?.type === "file") fragments.push("[文件，尚未读取]");
        else if (part?.type === "json") fragments.push("[分享卡片，尚未展开]");
      }
      const rawText = fragments.join("");
      const text = rawText.slice(0, Math.min(12000, 120000 - characters));
      if (rawText.length > text.length) markLimit();
      characters += text.length;
      const time = Number(data.time) * 1000;
      const displayTime = Number.isFinite(time) && time > 0 && time < 4133980800000 ? new Date(time).toISOString() : null;
      nodes.push({ speaker: speakers.get(speakerKey), displayName: redact(data.sender?.card || data.sender?.nickname || data.nickname || "未署名").slice(0, 40), displayTime, content: text || "[未支持的消息内容]" });
      for (const child of nested.slice(0, 2)) await visit(child, depth + 1);
      if (nested.length > 2) markLimit();
    }
    if (entries.length > 200) markLimit();
  }
  for (const descriptor of forwardDescriptors(message)) await visit(descriptor, 0);
  if (!nodes.length) throw new ForwardReadError();
  if (!requestedImages.size && imageCount > images.length) notes.add("部分图片没有可读取文件标识，或超过100张边界，无法识别这些图片");
  if (requestedImages.size) notes.add("本次按用户指定的图片编号阅读，其余图片不在本次识图范围");
  if (requestedImages.size && images.length < requestedImages.size) notes.add("指定的部分图片未在当前已读节点中找到，或没有可读取文件标识");
  if (limitReached) notes.add("记录较长，受200条节点、4层嵌套、16次展开及120000字符边界限制，未读取全部内容");
  return { nodes, images, notes: [...notes], truncated, apiCalls, imageCount, imagesRead: 0, requestedImageNumbers: [...requestedImages] };
}
