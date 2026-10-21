import { createHash } from "node:crypto";
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";
const folder = new URL("../.local/recovery-deliveries/", import.meta.url);
const digest = text => createHash("sha256").update(String(text)).digest("hex");
export const recoveryId = (scope, peer, source) => digest(`${scope}:${peer}:${source}`).slice(0, 32);
function fileFor(id) { if (!/^[a-f\d]{32}$/u.test(id)) throw new Error("Invalid recovery ID"); return new URL(id + ".json", folder); }
export function readRecoveryDelivery(id) { try { return JSON.parse(readFileSync(fileFor(id), "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
function writeReceipt(id, value) { const file = fileFor(id), temp = new URL(file.href + ".tmp"); writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); renameSync(temp, file); }
export async function sendRecoveredReply({ scope, peerId, sourceMessageId, text, selfId, sendAction, allowed = () => true }) {
  if (!["group", "private"].includes(scope) || !/^\d{1,32}$/u.test(peerId) || !/^-?\d{1,32}$/u.test(sourceMessageId) || typeof text !== "string" || !text.trim()) throw new Error("Invalid recovery delivery");
  if (!allowed()) return { cancelled: true };
  const id = recoveryId(scope, peerId, sourceMessageId), previous = readRecoveryDelivery(id);
  if (previous) return { duplicate: true, state: previous.state, message_id: previous.messageId };
  const body = "【补上之前未完成的回复】\n" + text.trim().slice(0, 4000);
  const receipt = { id, scope, peerId, sourceMessageId, state: "sending", at: Date.now(), textHash: digest(body) };
  mkdirSync(folder, { recursive: true });
  let fd;
  try { fd = openSync(fileFor(id), "wx", 0o600); writeFileSync(fd, JSON.stringify(receipt)); }
  catch (error) { if (error.code === "EEXIST") return { duplicate: true, state: "reserved" }; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
  if (!allowed()) { receipt.state = "cancelled"; writeReceipt(id, receipt); return { cancelled: true }; }
  let sent;
  try {
    sent = await sendAction("send_msg", { message_type: scope, ...(scope === "group" ? { group_id: peerId } : { user_id: peerId }),
      message: [{ type: "reply", data: { id: sourceMessageId } }, { type: "text", data: { text: body } }], auto_escape: true }, allowed);
  } catch (error) {
    if (error.code === "ONEBOT_ACTION_REJECTED") unlinkSync(fileFor(id));
    else { receipt.state = "uncertain"; writeReceipt(id, receipt); }
    throw error;
  }
  if (sent?.cancelled) { receipt.state = "cancelled"; writeReceipt(id, receipt); return sent; }
  receipt.state = "sent"; receipt.messageId = String(sent?.message_id ?? ""); writeReceipt(id, receipt);
  try {
    const readBack = await sendAction("get_msg", { message_id: receipt.messageId });
    const actualText = (Array.isArray(readBack.message) ? readBack.message : []).filter(part => part.type === "text").map(part => part.data?.text ?? "").join("");
    const sameScope = scope === "group" ? String(readBack.group_id) === peerId : !readBack.group_id;
    if (sameScope && String(readBack.user_id ?? readBack.sender?.user_id) === selfId && digest(actualText) === receipt.textHash) { receipt.state = "verified"; writeReceipt(id, receipt); }
  } catch { /* Acknowledged sends are never repeated just because read-back failed. */ }
  return { ...sent, recoveryId: id, verified: receipt.state === "verified" };
}
