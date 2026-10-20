const nodeTextLimit = 1200;
const maxForwardNodes = 50;

// Keep every character (including paragraph breaks) and avoid splitting emoji pairs.
function splitText(text) {
  const characters = Array.from(text);
  const chunks = [];
  let start = 0;
  while (start < characters.length) {
    let end = Math.min(start + nodeTextLimit, characters.length);
    if (end < characters.length) {
      const lower = start + Math.floor(nodeTextLimit / 2);
      let boundary = -1;
      for (let index = end - 1; index >= lower; index -= 1) {
        if (characters[index] === "\n") { boundary = index + 1; break; }
      }
      if (boundary === -1) {
        for (let index = end - 1; index >= lower; index -= 1) {
          if (/[。！？!?；;\s]/u.test(characters[index])) { boundary = index + 1; break; }
        }
      }
      if (boundary !== -1) end = boundary;
    }
    chunks.push(characters.slice(start, end).join(""));
    start = end;
  }
  return chunks;
}

export function buildLongReply(params, { settings, selfId } = {}) {
  if (settings?.longReplyForwardEnabled === false || !/^\d{1,32}$/u.test(selfId ?? "")) return null;
  const threshold = settings?.longReplyThreshold ?? 500;
  if (!Number.isInteger(threshold) || threshold < 100 || threshold > 3000) return null;
  const isGroup = params?.message_type === "group";
  if (!isGroup && params?.message_type !== "private") return null;
  const targetId = isGroup ? params.group_id : params.user_id;
  if (!/^\d{1,32}$/u.test(String(targetId ?? ""))) return null;
  // Only outgoing bot text and already approved stickers are eligible.
  // Other segment types retain their original send semantics.
  if (typeof params.message === "string" && params.auto_escape !== true) return null;
  const segments = typeof params.message === "string"
    ? [{ type: "text", data: { text: params.message } }]
    : params.message;
  if (!Array.isArray(segments) || segments.some((segment) => !segment?.data
    || (segment.type === "text" ? typeof segment.data.text !== "string" : segment.type !== "image"))) return null;
  const text = segments.filter((segment) => segment.type === "text").map((segment) => segment.data.text).join("");
  if (params.foldLongReply !== true && Array.from(text.trim()).length < threshold) return null;

  const nickname = settings?.botAliases?.[0] || "机器人";
  const nodes = [];
  let pendingText = "";
  const flushText = () => {
    for (const chunk of splitText(pendingText)) {
      nodes.push({ type: "node", data: { user_id: selfId, nickname, content: [{ type: "text", data: { text: chunk } }] } });
    }
    pendingText = "";
  };
  for (const segment of segments) {
    if (segment.type === "text") { pendingText += segment.data.text; continue; }
    flushText();
    if (!nodes.length) nodes.push({ type: "node", data: { user_id: selfId, nickname, content: [] } });
    nodes.at(-1).data.content.push(segment);
  }
  flushText();
  if (!nodes.length || nodes.length > maxForwardNodes) return null;
  return {
    action: isGroup ? "send_group_forward_msg" : "send_private_forward_msg",
    params: { [isGroup ? "group_id" : "user_id"]: targetId, messages: nodes },
  };
}

export async function sendReplyWithFolding(params, sendMessage, { settings, selfId, allowed = () => true } = {}) {
  if (!allowed()) return { cancelled: true };
  const forward = buildLongReply(params, { settings, selfId });
  const { foldLongReply, ...ordinaryParams } = params;
  if (!forward) return sendMessage("send_msg", ordinaryParams);
  try {
    return await sendMessage(forward.action, forward.params);
  } catch (error) {
    // A timeout/disconnect leaves delivery uncertain: do not risk sending twice.
    if (error?.code !== "ONEBOT_ACTION_REJECTED") throw error;
    if (!allowed()) return { cancelled: true };
    console.warn("合并转发被 NapCat 拒绝，改用普通消息发送。");
    return sendMessage("send_msg", ordinaryParams);
  }
}
