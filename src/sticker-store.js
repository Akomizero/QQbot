import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import sharp from "sharp";
import { MAX_SOURCE_IMAGE_BYTES, prepareNapCatImageBase64 } from "./image-input.js";
import { reviewStickerBytes, isTrustedStickerReview, STICKER_REVIEW_VERSION } from "./sticker-review.js";
import { renderSummaryImages } from "./announcement-card.js";
import { stickerPolicyAllows, recordStickerSent } from "./sticker-preferences.js";

const root = fileURLToPath(new URL("../.local/stickers/", import.meta.url));
const metaPath = resolve(root, "index.json");
const maxBytes = MAX_SOURCE_IMAGE_BYTES;
const automaticTargetBytes = 3 * 1024 * 1024;
const mimeTypes = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
const sentAt = new Map();

function assetPath(id) {
  if (typeof id !== "string" || !/^[a-f\d-]{36}$/u.test(id)) throw new Error("表情编号无效。");
  const path = resolve(root, id + ".image");
  if (!path.startsWith(resolve(root) + sep)) throw new Error("表情编号无效。");
  return path;
}

export function listStickers() {
  try {
    const data = readFileSync(metaPath, "utf8");
    if (data.length > 100000) throw new Error("表情配置过大。");
    const value = JSON.parse(data);
    if (!Array.isArray(value) || value.length > 50) throw new Error("表情配置无效。");
    return value.map((entry) => {
      assetPath(entry.id);
      if (typeof entry.title !== "string" || entry.title.length > 80 || !Array.isArray(entry.tags)
        || entry.tags.length > 15 || entry.tags.some((tag) => typeof tag !== "string" || tag.length > 30)
        || !Object.values(mimeTypes).includes(entry.mime) || typeof entry.enabled !== "boolean"
        || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > maxBytes
        || (entry.usage !== undefined && (typeof entry.usage !== "string" || entry.usage.length > 240))
        || (entry.avoid !== undefined && (typeof entry.avoid !== "string" || entry.avoid.length > 160))
        || (entry.origin === "group" && !/^\d{1,32}$/u.test(entry.groupId))) throw new Error("表情配置无效。");
      return { ...entry, usage: entry.usage ?? "", avoid: entry.avoid ?? "", needsDescription: entry.needsDescription ?? !entry.usage,
        reviewStatus: entry.reviewStatus === "approved" && entry.reviewVersion === STICKER_REVIEW_VERSION && /^[a-f\d]{64}$/u.test(entry.reviewHash ?? "") ? "approved" : "pending",
        origin: entry.origin === "group" ? "group" : "manual", groupId: entry.origin === "group" ? entry.groupId : null };
    });
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function writeIndex(entries) {
  mkdirSync(root, { recursive: true });
  const temporary = metaPath + "." + process.pid + ".tmp";
  writeFileSync(temporary, JSON.stringify(entries), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, metaPath);
}

function metadata(input) {
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  const tags = input?.tags ?? [];
  const usage = input?.usage ?? "";
  const avoid = input?.avoid ?? "";
  if (input?.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("表情启用状态格式不正确。");
  if (!title || title.length > 80 || !Array.isArray(tags) || tags.length > 15 || tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 30)) throw new Error("请填写表情名称，最多 80 字；关键词最多 15 个，每个最多 30 字。");
  if (typeof usage !== "string" || usage.length > 240 || typeof avoid !== "string" || avoid.length > 160) throw new Error("适用场景最多 240 字，避免场景最多 160 字。");
  return { title, tags: [...new Set(tags.map((tag) => tag.trim()))], usage: usage.trim(), avoid: avoid.trim(), enabled: input?.enabled !== false };
}

export function stickerHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function findStickerSource(bytes, groupId) {
  const hash = stickerHash(bytes);
  // A disabled entry also counts as known, preserving the administrator's choice.
  return listStickers().find((entry) => entry.sourceHash === hash && (!entry.groupId || entry.groupId === groupId));
}

export function hasStickerSource(bytes, groupId) {
  return Boolean(findStickerSource(bytes, groupId));
}

export async function approveStickerForSending(bytes) {
  const digest = stickerHash(bytes);
  // An identical already reviewed asset can be reused without another network call.
  if (listStickers().some((entry) => entry.reviewStatus === "approved" && entry.reviewHash === digest)) return;
  await reviewStickerBytes(bytes);
}

function persistSticker(bytes, meta, mime, source = {}) {
  if (bytes.length > maxBytes) throw new Error("每张图片或 GIF 表情最多 20 MB。");
  const entries = listStickers();
  if (source.origin === "group") {
    const known = entries.find((entry) => entry.sourceHash === source.sourceHash && (!entry.groupId || entry.groupId === source.groupId));
    if (known) return known;
    if (entries.filter((entry) => entry.origin === "group").length >= 40
      || entries.filter((entry) => entry.groupId === source.groupId).length >= 15) return null;
  }
  if (entries.length >= 50 || entries.reduce((sum, entry) => sum + entry.size, 0) + bytes.length > 60 * 1024 * 1024) throw new Error("表情包库最多 50 张、总量 60 MB。");
  const entry = { id: randomUUID(), ...meta, mime, size: bytes.length, origin: "manual", groupId: null,
    sourceHash: stickerHash(bytes), needsDescription: !meta.usage, autoTitle: false, ...source,
    reviewStatus: "approved", reviewHash: stickerHash(bytes), reviewVersion: STICKER_REVIEW_VERSION, reviewedAt: Date.now() };
  mkdirSync(root, { recursive: true });
  writeFileSync(assetPath(entry.id), bytes, { mode: 0o600 });
  try { writeIndex([...entries, entry]); } catch (error) { try { unlinkSync(assetPath(entry.id)); } catch {} throw error; }
  return entry;
}

export async function addSticker(input) {
  const meta = metadata(input);
  if (typeof input?.base64 !== "string" || input.base64.length > Math.ceil(maxBytes / 3) * 4 + 100) throw new Error("每张图片或 GIF 表情最多 20 MB。");
  const encoded = input.base64.replace(/^data:(?:image\/(?:jpeg|jpg|png|webp|gif)|application\/octet-stream);base64,/iu, "");
  await prepareNapCatImageBase64(encoded);
  const bytes = Buffer.from(encoded, "base64");
  const info = await sharp(bytes, { pages: 1, limitInputPixels: 40_000_000, failOn: "warning" }).metadata();
  if (!mimeTypes[info.format] || !info.width || !info.height || info.width * info.height > 40_000_000) throw new Error("请上传有效的 JPG、PNG、WebP 或 GIF 表情，分辨率最多 4000 万像素。");
  if (bytes.length > maxBytes) throw new Error("每张图片或 GIF 表情最多 20 MB。");
  const review = await reviewStickerBytes(bytes);
  if (!meta.usage && review.description) Object.assign(meta, { usage: review.description.usage, avoid: meta.avoid || review.description.avoid });
  return persistSticker(bytes, meta, mimeTypes[info.format]);
}

export async function addLearnedSticker({ bytes, groupId, title, tags, usage = "", avoid = "", review: suppliedReview, requested = false, allowed = () => true }) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxBytes || !/^\d{1,32}$/u.test(groupId)) return null;
  const meta = metadata({ title, tags, usage, avoid, enabled: true });
  const sourceHash = stickerHash(bytes);
  const known = findStickerSource(bytes, groupId);
  if (known?.reviewStatus === "approved") {
    if (!requested && known.needsDescription && allowed()) return applyStickerDescription(known.id, meta);
    return requested ? known : null;
  }
  const review = isTrustedStickerReview(suppliedReview, bytes) ? suppliedReview : await reviewStickerBytes(bytes);
  if (!requested && !review.reusable) return null;
  if (review.description) Object.assign(meta, requested ? review.description : { usage: meta.usage || review.description.usage, avoid: meta.avoid || review.description.avoid });
  if (known) {
    if (!allowed()) return null;
    applyStickerReview(known.id, review);
    if (known.needsDescription && review.description) applyStickerDescription(known.id, review.description);
    return listStickers().find((entry) => entry.id === known.id);
  }
  const info = await sharp(bytes, { pages: 1, limitInputPixels: 40_000_000, failOn: "warning" }).metadata();
  if (!mimeTypes[info.format] || !info.width || !info.height || info.width * info.height > 40_000_000) return null;
  let output = bytes;
  let mime = mimeTypes[info.format];
  let animationReduced = false;
  if (!requested && output.length > automaticTargetBytes && info.format === "gif") {
    const frames = info.pages ?? 1;
    const frameHeight = info.pageHeight ?? info.height;
    // Bound full-animation decoding; very long GIFs are collected as one frame.
    if (frames <= 120 && info.width * frameHeight * frames <= 32_000_000) {
      try {
        output = await sharp(bytes, { animated: true, limitInputPixels: 32_000_000, failOn: "warning" })
          .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
          .gif({ colours: 128, effort: 3 }).toBuffer();
        animationReduced = true;
      } catch { output = bytes; }
    }
  }
  if (!requested && output.length > automaticTargetBytes) {
    output = await sharp(bytes, { pages: 1, animated: false, limitInputPixels: 40_000_000, failOn: "warning" })
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    mime = "image/webp";
    animationReduced = info.format === "gif";
  }
  if (output.length > (requested ? maxBytes : automaticTargetBytes) || !allowed()) return null;
  return persistSticker(output, meta, mime, { origin: "group", groupId, sourceHash, learnedAt: Date.now(), animationReduced,
    requested, autoTitle: requested && !review.description, firstFrameOnly: info.format === "gif" && mime !== "image/gif" });
}

export function applyStickerReview(id, review) {
  const bytes = readFileSync(assetPath(id));
  if (!isTrustedStickerReview(review, bytes)) throw new Error("表情审核结果无效。");
  const entries = listStickers();
  const entry = entries.find((item) => item.id === id);
  if (!entry) return null;
  Object.assign(entry, { reviewStatus: "approved", reviewHash: stickerHash(bytes), reviewVersion: STICKER_REVIEW_VERSION, reviewedAt: Date.now() });
  writeIndex(entries);
  return entry;
}

export function applyStickerDescription(id, description) {
  const entries = listStickers();
  const entry = entries.find((item) => item.id === id);
  if (!entry || !entry.needsDescription) return null;
  const meta = metadata({ ...entry, title: entry.autoTitle ? description.title : entry.title,
    tags: entry.autoTitle || !entry.tags.length ? description.tags : entry.tags, usage: description.usage, avoid: description.avoid });
  if (!meta.usage) return null;
  Object.assign(entry, meta, { needsDescription: false, autoTitle: false,
    sourceHash: entry.sourceHash ?? stickerHash(readFileSync(assetPath(id))) });
  writeIndex(entries);
  return entry;
}

export function updateSticker(id, input) {
  const entries = listStickers();
  const entry = entries.find((item) => item.id === id);
  if (!entry) throw new Error("表情不存在。");
  const meta = metadata({ ...entry, ...input });
  Object.assign(entry, meta, { autoTitle: false, needsDescription: !meta.usage });
  writeIndex(entries);
  return entry;
}

export function deleteSticker(id) {
  const entries = listStickers();
  if (!entries.some((entry) => entry.id === id)) throw new Error("表情不存在。");
  writeIndex(entries.filter((entry) => entry.id !== id));
  try { unlinkSync(assetPath(id)); } catch {}
}

export function readSticker(id, { enabledOnly = false, approvedOnly = false } = {}) {
  const entry = listStickers().find((item) => item.id === id && (!enabledOnly || item.enabled));
  if (!entry) return null;
  const bytes = readFileSync(assetPath(id));
  if (bytes.length > maxBytes || bytes.length !== entry.size) throw new Error("表情文件大小不匹配。");
  if (approvedOnly && (entry.reviewStatus !== "approved" || entry.reviewHash !== stickerHash(bytes))) return null;
  return { ...entry, bytes };
}

export function stickerChoices(conversationId) {
  if (Date.now() - (sentAt.get(conversationId) ?? 0) < 30_000) return [];
  const groupId = conversationId?.startsWith("group:") ? conversationId.slice(6) : null;
  return listStickers().filter((entry) => entry.enabled && entry.reviewStatus === "approved" && !entry.needsDescription && (!entry.groupId || entry.groupId === groupId)
    && stickerPolicyAllows(entry, groupId, { includeRecent: true }))
    .map(({ id, title, tags, usage, avoid }) => ({ id, title, tags, usage, avoid }));
}

export async function sendLlmResult(result, destination, sendMessage, { stickersEnabled = true, onSent = () => {} } = {}) {
  const conversationId = `${destination.message_type}:${destination.group_id ?? destination.user_id}`;
  const message = result.reply ? [{ type: "text", data: { text: result.reply } }] : [];
  let sticker;
  const summary = result.summary ?? result.announcement ?? result.illustration;
  let summaryImages = [];
  if (summary?.format === "illustrated" && result.reply) {
    try { summaryImages = await renderSummaryImages(result.reply, summary); }
    catch { console.warn("摘要图文排版未完成，改用完整文字发送。"); }
  }
  if (summaryImages.length) {
    const checkedIds=new Set((summary.verification?.claims??[]).flatMap(claim=>[...(claim.support??[]),...(claim.against??[])].map(item=>item.sourceId)));
    const checkedSources=(summary.verification?.sources??[]).filter(source=>checkedIds.has(source.id));
    const links = [...new Set([...summary.articles,...checkedSources].filter(article=>article.url).map(article=>article.url))].join("\n");
    message[0] = { type: "text", data: { text: `${summary.topic || summary.articles[0]?.game || "内容总结"}\n${links ? "详细内容见图，来源：\n" + links : summary.adapter === "discussion" ? "详细内容见图。" : "根据你提供的文字整理，详细摘要见图。"}` } };
    for (const bytes of summaryImages) message.push({ type: "image", data: { file: `base64://${bytes.toString("base64")}`, summary: "[内容摘要]" } });
  }
  if (!summary && stickersEnabled && result.stickerId && stickerChoices(conversationId).some((entry) => entry.id === result.stickerId)) {
    try { sticker = readSticker(result.stickerId, { enabledOnly: true, approvedOnly: true }); } catch {}
  }
  if (sticker) message.push({ type: "image", data: { file: `base64://${sticker.bytes.toString("base64")}`, sub_type: 1, summary: `[${sticker.title.slice(0, 30)}]` } });
  if (!message.length) return false;
  // Reserve before awaiting the send to prevent concurrent replies bursting stickers.
  if (sticker) {
    if (sentAt.size > 2000) for (const [key, value] of sentAt) if (Date.now() - value > 30_000) sentAt.delete(key);
    sentAt.set(conversationId, Date.now());
  }
  try {
    const sent = await sendMessage("send_msg", { ...destination, message: sticker || summaryImages.length ? message : result.reply, auto_escape: true },
      () => { if (!sticker) return true; const latest = listStickers().find(entry => entry.id === sticker.id && entry.enabled && entry.reviewStatus === "approved");
        return Boolean(latest && stickerPolicyAllows(latest, destination.message_type === "group" ? String(destination.group_id) : null)); });
    if (sent?.cancelled) { if (sticker) sentAt.delete(conversationId); return false; }
    if (sticker) { try { recordStickerSent(String(destination.group_id ?? ""), sticker.id); } catch {} }
    onSent(sent, { stickerId: sticker?.id ?? null });
  }
  catch (error) { if (sticker) sentAt.delete(conversationId); throw error; }
  return true;
}
