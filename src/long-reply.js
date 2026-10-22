const nodeTextLimit = 1200;
const paragraphTextLimit = 600;
const maxForwardNodes = 50;

// Keep every character (including paragraph breaks) and avoid splitting emoji pairs.
function splitBoundedText(text, limit=nodeTextLimit) {
  const characters = Array.from(text);
  const chunks = [];
  let start = 0;
  while (start < characters.length) {
    let end = Math.min(start + limit, characters.length);
    if (end < characters.length) {
      const lower = start + Math.floor(limit / 2);
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

// Prefer semantic paragraphs inside one forward. Preserve whitespace, keep a
// heading with its following explanation and do not treat code's blank lines as
// paragraph boundaries. Very long blocks still use the existing size bound.
function splitText(text, availableNodes=maxForwardNodes) {
  const blocks=[];let pending="",fence=null;
  for(const line of text.match(/[^\n]*\n|[^\n]+$/gu)??[]) {
    pending+=line;
    const marker=line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if(marker) {
      if(!fence)fence=marker;
      else if(marker[0]===fence[0]&&marker.length>=fence.length)fence=null;
    }
    if(!line.trim()&&!fence) {
      if(pending.trim()){blocks.push(pending);pending="";}
      else if(blocks.length){blocks[blocks.length-1]+=pending;pending="";}
    }
  }
  if(pending)blocks.push(pending);
  const sections=[];pending="";
  for(const block of blocks) {
    pending+=block;
    const heading=block.trim();
    if(/^(?:#{1,6}\s+[^\n]+|\*\*[^\n*]{1,70}\*\*[:：]?|【[^\n]{1,70}】)$/u.test(heading))continue;
    sections.push(pending);pending="";
  }
  if(pending){if(sections.length)sections[sections.length-1]+=pending;else sections.push(pending);}
  const chunks=sections.flatMap(section=>splitBoundedText(section,paragraphTextLimit));
  // Too many short paragraphs must not turn a valid folded reply into a plain
  // wall of text. Repack within the original node bounds without dropping text.
  return chunks.length<=availableNodes?chunks:splitBoundedText(text);
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
    for (const chunk of splitText(pendingText,maxForwardNodes-nodes.length)) {
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
