// Capture the image-networking baseline before application dependencies load.
import {
  prepareNapCatImageBase64,
  prepareNapCatImageUrl,
  isNapCatImageFile,
  ImageInputError,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  MAX_TOTAL_IMAGE_BYTES,
  MAX_TOTAL_SOURCE_IMAGE_BYTES,
} from "./image-input.js";
import { getConfig, getLlmApiKey, getSearchApiKey } from "./config.js";
import { readAccessControl } from "./access-control-store.js";
import { getCommandMatch } from "./commands.js";
import { readCommands } from "./command-store.js";
import { getLlmReply, describeForwardBatch, LlmRequestError } from "./llm.js";
import { prepareForwardReading } from "./forward-reading.js";
import { extractBilibiliReference } from "./bilibili-video.js";
import { readLlmSettings } from "./llm-settings-store.js";
import { ensureGroupPersonas, settingsForGroup } from "./group-personas.js";
import { createOneBotBridge } from "./onebot.js";
import { recordProactiveReply, reserveProactiveEvaluation, recordProactiveWaiting, acknowledgeGroupReply, recordExternalProactiveReply } from "./proactive-chat-state.js";
import { acknowledgeVideoDiscoveryReply, startVideoDiscovery } from "./video-discovery.js";
import { parseSearchIntent } from "./search-intent.js";
import { closeSearchConnections } from "./search.js";
import { parseImageGenerationIntent, generateChatGptImage, recordGeneratedImageDelivery, stopChatGptImageGeneration, ChatGptImageError } from "./chatgpt-imagegen.js";
import { enqueueReplyRecovery, startReplyRecovery, recoveryStillAllowed } from "./reply-recovery.js";
import { parseSummaryIntent } from "./content-summary.js";
import { startManagementServer } from "./web.js";
import { observeKnowledgeMessage, clearKnowledgeLearning } from "./knowledge-learning.js";
import { startMemoryMaintenance } from "./memory-maintenance.js";
import { growthLearningStamp } from "./personality-growth.js";
import { addLearnedSticker, approveStickerForSending, sendLlmResult, readSticker } from "./sticker-store.js";
import { queueVisualCorrection, noteVisualLearningMissingImage } from "./visual-learning.js";
import { isVisualCorrectionText } from "./visual-memory-store.js";
import { canLearnSticker, learnIncomingStickers, queuePendingStickerDescriptions, queueStickerDescription, stopStickerLearning } from "./sticker-learning.js";
import { queueConversationReply, paceOneBotMessage, paceOneBotMessages } from "./reply-queue.js";
import { sendReplyWithFolding, buildDirectReplyParts, buildLongReply } from "./long-reply.js";
import { rememberGroupLine, warmGroupContext, isPossibleBotFollowup, recentGroupContext, clearGroupConversations, findGroupLine } from "./conversation-context.js";
import { resolveMessageContext, messageReferences } from "./message-context.js";
import { noteStickerFeedback } from "./sticker-preferences.js";
import { memberMemoryCommand, forgetMemberImpression, resumeMemberImpression, memberLearningStamp, groupMemberContextSince } from "./member-impressions.js";
import { clearMemberLearningBuffer } from "./knowledge-learning.js";
import { startConfiguredModelProxy } from "./local-model-proxy.js";
import { closeModelConnections } from "./model-transport.js";
import { rememberGroupImages, resolveRecentGroupImages, clearRecentGroupImages, canUseRecentGroupImages } from "./recent-group-images.js";
import { hasForwardMessage, rememberForwardMessage, resolveForwardSource, readForwardedMessages, clearForwardContext, ForwardReadError } from "./forward-input.js";

const sensitiveValues = new Set();
const seenMessageIds = new Map();
const passiveGroupContexts = new Map();
const pendingGroupTurnTimers = new Map();
const contextExpiryTimers = new Map();
const activeProactiveGroups = new Set();
let activeImageRequests = 0;
const waitingImageRequests = [];
const pendingStickerGroups = new Set();
const passiveContextTtlMs = 15 * 60_000;
const maxPassiveContextGroups = 256;
const maxPassiveContextMessages = 20;
const maxPassiveMessageLength = 400;

async function acquireImageSlot() {
  if (activeImageRequests === 0) activeImageRequests = 1;
  else await new Promise((resolve) => waitingImageRequests.push(resolve));
}

function releaseImageSlot() {
  const next = waitingImageRequests.shift();
  if (next) next();
  else activeImageRequests = 0;
}

function getCurrentLlmApiKey() {
  const apiKey = getLlmApiKey();
  if (apiKey) sensitiveValues.add(apiKey);
  return apiKey;
}

function numericId(value) {
  return typeof value === "string" && /^\d{1,32}$/u.test(value) ? value : null;
}

function segmentsOf(message) {
  if (Array.isArray(message)) return message;
  return typeof message === "string" ? [{ type: "text", data: { text: message } }] : [];
}

function hasBotMention(message, selfId) {
  if (!selfId) return false;
  if (Array.isArray(message)) {
    return message.some((segment) => segment?.type === "at" && numericId(segment?.data?.qq) === selfId);
  }
  if (typeof message !== "string") return false;
  return [...message.matchAll(/\[CQ:at,qq=(\d+)\]/giu)]
    .some((match) => numericId(match[1]) === selfId);
}

function hasAnyMention(message) {
  if (Array.isArray(message)) return message.some((segment) => segment?.type === "at");
  return typeof message === "string" && /\[CQ:at(?:,|\])/iu.test(message);
}

function isPlainTextMessage(message) {
  if (Array.isArray(message)) return message.length > 0 && message.every((segment) => segment?.type === "text");
  return typeof message === "string" && !/\[CQ:[^\]]+\]/iu.test(message);
}

// NapCat exposes QQ market faces as image segments with emoji metadata, often GIF files.
function isMarketFaceImage(segment) {
  return segment?.type === "image"
    && ["string", "number"].includes(typeof segment?.data?.emoji_id)
    && String(segment.data.emoji_id).length > 0
    && ["string", "number"].includes(typeof segment?.data?.emoji_package_id)
    && String(segment.data.emoji_package_id).length > 0;
}

function isQqFaceSegment(segment) {
  return segment?.type === "face" || segment?.type === "mface" || isMarketFaceImage(segment);
}

function isMarketFaceCqCode(code) {
  return /(?:^|,)emoji_id=[^,\]]+/u.test(code)
    && /(?:^|,)emoji_package_id=[^,\]]+/u.test(code);
}

function imageSegments(message) {
  if (Array.isArray(message)) {
    return message.filter((segment) => segment?.type === "image" && (!isMarketFaceImage(segment) || isNapCatImageFile(segment?.data?.file)));
  }
  if (typeof message === "string") {
    const imageCodes = [...message.matchAll(/\[CQ:image(?:,[^\]]*)?\]/giu)];
    if (imageCodes.some(([code]) => !isMarketFaceCqCode(code))) return null;
  }
  return [];
}

function looksLikeSticker(segment) {
  return Number(segment?.data?.sub_type) === 1 || isMarketFaceImage(segment) || /\.gif$/iu.test(segment?.data?.file ?? "");
}

function isStickerCollectionRequest(text) {
  return /(?:给你(?:当|做|作|用作)?(?:个|一张|一些)?表情包?|(?:这张|这个).{0,8}(?:当|做).{0,4}表情|(?:收藏|保存|收下|学会|添加).{0,12}(?:表情包?|这张(?:图)?|这(?:个|些)图))/u.test(text);
}

async function readIncomingImages(images, sendMessage, { collectSources = false, maxCount = MAX_IMAGE_COUNT } = {}) {
  if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 9 || !Array.isArray(images) || images.length > maxCount) throw new ImageInputError(`一次最多处理 ${maxCount <= 9 ? maxCount : MAX_IMAGE_COUNT} 张图片，请减少图片数量后再试。`);
  const prepared = [];
  let totalBytes = 0;
  let totalSourceBytes = 0;
  for (const segment of images) {
    const file = segment?.data?.file;
    if (!isNapCatImageFile(file)) throw new ImageInputError("这张图片的 QQ 文件标识无法识别，请从 QQ 重新发送图片或表情。");
    const imageOptions = {
      remainingSourceBytes: MAX_TOTAL_SOURCE_IMAGE_BYTES - totalSourceBytes,
      includeSourceBytes: collectSources,
    };
    const image = segment.forwardedNumber && segment.data.url
      ? await prepareNapCatImageUrl(segment.data.url, MAX_TOTAL_IMAGE_BYTES - totalBytes, imageOptions)
      : await prepareNapCatImageBase64((await sendMessage("get_image", { file }))?.base64, MAX_TOTAL_IMAGE_BYTES - totalBytes, imageOptions);
    if (image.byteLength > MAX_IMAGE_BYTES) throw new ImageInputError("这张图片超过 4 MB，请压缩后重新发送。");
    totalBytes += image.byteLength;
    totalSourceBytes += image.sourceByteLength;
    prepared.push({ ...image, stickerCandidate: looksLikeSticker(segment) || image.firstFrameOnly === true });
  }
  return prepared;
}

async function observeGroupStickers(images, authorized, sendMessage) {
  if (!Array.isArray(images) || images.length > MAX_IMAGE_COUNT || pendingStickerGroups.has(authorized.groupId)
    || pendingStickerGroups.size >= 128 || !canLearnSticker(authorized.groupId)) return;
  const stickers = images.filter(looksLikeSticker);
  if (!stickers.length) return;
  pendingStickerGroups.add(authorized.groupId);
  try {
    let prepared;
    await acquireImageSlot();
    try {
      if (!canLearnSticker(authorized.groupId)) return;
      prepared = await readIncomingImages(stickers, sendMessage, { collectSources: true });
    } finally { releaseImageSlot(); }
    await learnIncomingStickers({ groupId: authorized.groupId, images: prepared });
  } catch {
    // Unmentioned stickers may be learned silently; ordinary group chat gets no error reply.
  } finally { pendingStickerGroups.delete(authorized.groupId); }
}

function extractText(message) {
  if (Array.isArray(message)) {
    return message
      .map((segment) => {
        if (segment?.type === "text" && typeof segment?.data?.text === "string") return segment.data.text;
        if (segment?.type === "json" && typeof segment?.data?.data === "string" && segment.data.data.length <= 16000) {
          try { return " " + (extractBilibiliReference(JSON.stringify(JSON.parse(segment.data.data)).replace(/\\\//gu, "/")) ?? ""); } catch { return ""; }
        }
        return isQqFaceSegment(segment) ? "[QQ表情]" : "";
      })
      .join("")
      .replace(/\s+/gu, " ")
      .trim();
  }

  if (typeof message !== "string") return "";
  return message
    .replace(/\[CQ:at,qq=\d+\]/giu, " ")
    .replace(/\[CQ:(?:face|mface)(?:,[^\]]*)?\]/giu, " [QQ表情] ")
    .replace(/\[CQ:image(?:,[^\]]*)?\]/giu, (code) => isMarketFaceCqCode(code) ? " [QQ表情] " : " ")
    .replace(/\[CQ:[^\]]+\]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function authorizeEvent(event, accessControl) {
  if (event?.post_type !== "message") return null;
  const userId = numericId(event.user_id);
  if (!userId) return null;

  if (event.message_type === "group") {
    const groupId = numericId(event.group_id);
    const selfId = numericId(event.self_id);
    if (!groupId || !selfId || userId === selfId || !accessControl.groupIds.includes(groupId)) return null;
    return {
      scope: "group",
      groupId,
      selfId,
      userId,
      mentioned: hasBotMention(event.message, selfId),
      content: extractText(event.message),
    };
  }

  if (event.message_type === "private" && event.sub_type === "friend") {
    if (!accessControl.userIds.includes(userId)) return null;
    return { scope: "private", userId, content: extractText(event.message) };
  }

  return null;
}

function isDuplicate(messageId, scope) {
  if (!messageId) return false;
  const key = `${scope}:${messageId}`;
  const now = Date.now();
  for (const [existingKey, seenAt] of seenMessageIds) {
    if (now - seenAt > 10 * 60_000) seenMessageIds.delete(existingKey);
  }
  if (seenMessageIds.has(key)) return true;
  seenMessageIds.set(key, now);
  if (seenMessageIds.size > 5000) seenMessageIds.delete(seenMessageIds.keys().next().value);
  return false;
}

function safeErrorDetails(error) {
  let details;
  if (error instanceof Error) {
    details = `${error.name}: ${error.message}`;
  } else {
    try {
      details = typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
    } catch {
      details = String(error);
    }
  }

  for (const value of [...sensitiveValues].sort((left, right) => right.length - left.length)) {
    if (value) details = details.replaceAll(value, "[已隐藏]");
  }
  details = details.replace(/https?:\/\/[^\s"'<>]+/giu, (url) => (
    /^https?:\/\/[^/?#]*@/iu.test(url) ? "[已隐藏的代理地址]" : url
  ));
  return details;
}

function prunePassiveContexts(allowedGroupIds, now) {
  const allowed = new Set(allowedGroupIds);
  for (const [groupId, context] of passiveGroupContexts) {
    if (!allowed.has(groupId)) {
      cancelPendingGroupTurn(groupId);
      cancelContextExpiry(groupId);
      passiveGroupContexts.delete(groupId);
      continue;
    }
    context.messages = context.messages.filter((item) => now - item.createdAt <= passiveContextTtlMs);
    if (context.messages.length === 0 && !activeProactiveGroups.has(groupId)) {
      cancelContextExpiry(groupId);
      passiveGroupContexts.delete(groupId);
    }
  }
}

function getPassiveContext(groupId) {
  let context = passiveGroupContexts.get(groupId);
  if (!context) {
    if (passiveGroupContexts.size >= maxPassiveContextGroups) return null;
    context = { messages: [], updatedAt: 0, reviewPending: false };
    passiveGroupContexts.set(groupId, context);
  }
  return context;
}

function shanghaiDayKey(now) {
  return new Date(now + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

function cancelPendingGroupTurn(groupId) {
  const timer = pendingGroupTurnTimers.get(groupId);
  if (timer) clearTimeout(timer);
  pendingGroupTurnTimers.delete(groupId);
}

function cancelContextExpiry(groupId) {
  const timer = contextExpiryTimers.get(groupId);
  if (timer) clearTimeout(timer);
  contextExpiryTimers.delete(groupId);
}

function scheduleContextExpiry(groupId) {
  cancelContextExpiry(groupId);
  const context = passiveGroupContexts.get(groupId);
  if (!context?.messages.length) return;
  const expiresAt = context.messages[0].createdAt + passiveContextTtlMs;
  const timer = setTimeout(() => {
    contextExpiryTimers.delete(groupId);
    const latestContext = passiveGroupContexts.get(groupId);
    if (!latestContext) return;
    const now = Date.now();
    latestContext.messages = latestContext.messages.filter((item) => now - item.createdAt <= passiveContextTtlMs);
    if (!latestContext.messages.length && !activeProactiveGroups.has(groupId)) {
      passiveGroupContexts.delete(groupId);
      return;
    }
    scheduleContextExpiry(groupId);
  }, Math.max(1, expiresAt - Date.now()));
  timer.unref?.();
  contextExpiryTimers.set(groupId, timer);
}

function clearPassiveContexts() {
  for (const timer of pendingGroupTurnTimers.values()) clearTimeout(timer);
  for (const timer of contextExpiryTimers.values()) clearTimeout(timer);
  pendingGroupTurnTimers.clear();
  contextExpiryTimers.clear();
  passiveGroupContexts.clear();
}

function scheduleGroupTurn(groupId, sendMessage, config, debounceSeconds) {
  cancelPendingGroupTurn(groupId);
  const timer = setTimeout(() => {
    pendingGroupTurnTimers.delete(groupId);
    void evaluateProactiveGroupTurn(groupId, sendMessage, config);
  }, debounceSeconds * 1000);
  timer.unref?.();
  pendingGroupTurnTimers.set(groupId, timer);
}

function observeGroupMessage(authorized, { sendMessage }, config, accessControl, settings) {
  const text = authorized.content.trim();
  if (!text) return;

  const now = Date.now();
  prunePassiveContexts(accessControl.groupIds, now);
  const context = getPassiveContext(authorized.groupId);
  if (!context) return;
  context.messages.push({ createdAt: now, text: text.slice(0, maxPassiveMessageLength) });
  context.updatedAt = now;
  if (context.messages.length > maxPassiveContextMessages) context.messages.shift();
  scheduleContextExpiry(authorized.groupId);
  scheduleGroupTurn(authorized.groupId, sendMessage, config, settings.proactiveDebounceSeconds);
}

async function evaluateProactiveGroupTurn(groupId, sendMessage, config) {
  let accessControl;
  let settings;
  try {
    accessControl = readAccessControl();
    if (!accessControl.groupIds.includes(groupId)) {
      passiveGroupContexts.delete(groupId);
      return;
    }
    settings = readLlmSettings();
  } catch {
    return;
  }
  if (!settings.proactiveChatEnabled) {
    clearPassiveContexts();
    return;
  }
  const apiKey = getCurrentLlmApiKey();
  if (!apiKey) return;

  const now = Date.now();
  prunePassiveContexts(accessControl.groupIds, now);
  const context = passiveGroupContexts.get(groupId);
  if (!context) return;
  if (activeProactiveGroups.has(groupId)) {
    context.reviewPending = true;
    return;
  }

  const recentMessages = context.messages.slice(-10);
  if (recentMessages.length === 0) return;
  const evaluatedContextAt = context.updatedAt;

  let reserved;
  try {
    reserved = reserveProactiveEvaluation({
      groupId,
      now,
      dayKey: shanghaiDayKey(now),
      cooldownMs: settings.proactiveCooldownMinutes * 60_000,
      evaluationIntervalMs: settings.proactiveFrequencyMinutes * 60_000,
      dailyLimit: settings.proactiveDailyLimit,
      pauseWhenIgnored: settings.proactivePauseWhenIgnored,
    });
  } catch {
    return;
  }
  if (!reserved) return;

  activeProactiveGroups.add(groupId);

  const groupContext = recentMessages
    .map((item, index) => `${index + 1}. ${item.text}`)
    .join("\n")
    .slice(-2800);
  try {
    const result = await getLlmReply({
      apiKey,
      searchApiKey: config.searchApiKey,
      settings,
      userId: `proactive-group:${groupId}`,
      groupId,
      userMessage: groupContext,
      proactive: true,
      conversationContext: settings.conversationFollowupEnabled ? recentGroupContext(groupId) : [],
    });
    if (!result.reply) return;

    const latestAccess = readAccessControl();
    const latestSettings = readLlmSettings();
    const currentContext = passiveGroupContexts.get(groupId);
    if (
      !latestAccess.groupIds.includes(groupId)
      || !latestSettings.proactiveChatEnabled
      || !currentContext
      || currentContext.updatedAt !== evaluatedContextAt
    ) return;
    const replyTime = Date.now();
    const canReply = recordProactiveReply({
      groupId,
      now: replyTime,
      dayKey: shanghaiDayKey(replyTime),
      cooldownMs: latestSettings.proactiveCooldownMinutes * 60_000,
      dailyLimit: latestSettings.proactiveDailyLimit,
    });
    if (!canReply) return;
    const sent = await sendMessage("send_msg", {
      message_type: "group",
      group_id: groupId,
      message: result.reply,
      auto_escape: true,
    }, () => passiveGroupContexts.get(groupId)?.updatedAt === evaluatedContextAt && readLlmSettings().proactiveChatEnabled
      && (!result.groupPersonaRevision || settingsForGroup(readLlmSettings(), groupId).groupPersonaRevision === result.groupPersonaRevision));
    if (!sent?.cancelled) {
      rememberGroupLine({ groupId, userId: "bot", text: result.reply, isBot: true, messageId: sent?.message_id });
      if (latestSettings.proactivePauseWhenIgnored) recordProactiveWaiting({ groupId, now: Date.now(), text: result.reply, messageId: sent?.message_id });
    }
  } catch (error) {
    console.error("主动群聊回复失败：", safeErrorDetails(error));
  } finally {
    activeProactiveGroups.delete(groupId);
    const latestContext = passiveGroupContexts.get(groupId);
    if (latestContext && !latestContext.messages.length) {
      passiveGroupContexts.delete(groupId);
      cancelContextExpiry(groupId);
    } else if (latestContext?.reviewPending) {
      latestContext.reviewPending = false;
      let debounceSeconds = 8;
      try { debounceSeconds = readLlmSettings().proactiveDebounceSeconds; } catch {}
      scheduleGroupTurn(groupId, sendMessage, config, debounceSeconds);
    }
  }
}

async function handleMessage(event, { sendMessage }, config) {
  let accessControl;
  try {
    accessControl = readAccessControl();
  } catch {
    return;
  }

  // This is the first decision on an inbound event. Unauthorized messages never
  // reach command parsing, attachment inspection, search, the model, or replies.
  const authorized = authorizeEvent(event, accessControl);
  if (!authorized || isDuplicate(event.message_id, authorized.scope)) return;
  if (authorized.scope === "group") {
    let followupEnabled = false;
    let videoDiscoveryEnabled = false;
    let visionEnabled = false;
    let personaSince = 0;
    try {
      const settings = settingsForGroup(readLlmSettings(), authorized.groupId);
      personaSince = settings.groupPersonaSince;
      followupEnabled = settings.conversationFollowupEnabled;
      videoDiscoveryEnabled = settings.videoDiscoveryEnabled && settings.videoDiscoveryGroupIds.includes(authorized.groupId);
      visionEnabled = settings.visionEnabled;
      if (settings.forwardReadingEnabled !== false) rememberForwardMessage({ event, ...authorized });
      if (visionEnabled) rememberGroupImages({ event, groupId: authorized.groupId, selfId: authorized.selfId, since: personaSince });
      if (settings.nicknameTriggerEnabled && settings.botAliases.some((name) => {
        const text = authorized.content.toLocaleLowerCase("zh-CN"), alias = name.toLocaleLowerCase("zh-CN");
        return text.includes(alias) && (!hasAnyMention(event.message) || text.startsWith(alias));
      })) authorized.mentioned = true;
      if (settings.contentSummaryEnabled !== false && !hasAnyMention(event.message)
        && /(?:帮我|帮忙|给我|^请|^\/(?:总结|摘要|summarize|公告|更新公告|补丁))/u.test(authorized.content)
        && parseSummaryIntent(authorized.content, { aliases: settings.botAliases })) authorized.mentioned = true;
    } catch { return; }
    if (followupEnabled) await warmGroupContext({ groupId: authorized.groupId, selfId: authorized.selfId, sendAction: sendMessage, since: personaSince });
    authorized.messageContext = await resolveMessageContext({ event, groupId: authorized.groupId, selfId: authorized.selfId,
      lookup: findGroupLine, sendAction: sendMessage, since: personaSince });
    if (followupEnabled && !authorized.mentioned && authorized.messageContext.reply?.isBot
      && !authorized.messageContext.mentions.some(x => !x.isBot)) {
      authorized.mentioned = true;
      authorized.followup = true;
    }
    try { acknowledgeGroupReply({ groupId: authorized.groupId, mentioned: authorized.mentioned, text: authorized.content, replyIds: segmentsOf(event.message).filter((segment) => segment?.type === "reply").map((segment) => String(segment.data?.id ?? "")) }); } catch {}
    try { if (acknowledgeVideoDiscoveryReply({ groupId: authorized.groupId, mentioned: authorized.mentioned, text: authorized.content, replyIds: messageReferences(event.message).replyIds })) acknowledgeGroupReply({ groupId: authorized.groupId, mentioned: true }); } catch {}
    if (followupEnabled && !authorized.mentioned && isPossibleBotFollowup({ groupId: authorized.groupId, userId: authorized.userId, text: authorized.content,
      replyIds: messageReferences(event.message).replyIds, mentionsOther: hasAnyMention(event.message),
      hasImage: visionEnabled && Array.isArray(event.message) && event.message.some(segment => segment?.type === "image"),
      hasForward: readLlmSettings().forwardReadingEnabled !== false && hasForwardMessage(event.message) })) {
      authorized.mentioned = true;
      authorized.followup = true;
    }
    if (visionEnabled && (authorized.mentioned || isVisualCorrectionText(authorized.content)) && Array.isArray(event.message) && !hasForwardMessage(event.message) && !event.message.some(segment => segment?.type === "image")) {
      authorized.imageReference = await resolveRecentGroupImages({ event, groupId: authorized.groupId, selfId: authorized.selfId,
        text: authorized.content, since: personaSince, sendAction: sendMessage });
      if (authorized.imageReference) authorized.messageContext.imageSource = {
        messageId: authorized.imageReference.messageId, speakerId: authorized.imageReference.userId,
        relation: authorized.messageContext.reply ? "明确引用的图片" : "当前发言者刚才发来、这次请bot看的图片",
        ageSeconds: Math.max(0, Math.round((Date.now() - authorized.imageReference.at) / 1000)),
      };
    }
    if (followupEnabled || videoDiscoveryEnabled) rememberGroupLine({ groupId: authorized.groupId, userId: authorized.userId, text: authorized.content, messageId: event.message_id,
      name: event.sender?.card || event.sender?.nickname, addressedToBot: authorized.mentioned });
    if (visionEnabled && isVisualCorrectionText(authorized.content) && !hasForwardMessage(event.message)
      && !authorized.messageContext?.mentions.some(item => !item.isBot)) {
      const correctionImages = authorized.imageReference?.images ?? imageSegments(event.message);
      const relatedStickerId = authorized.messageContext?.reply?.stickerId;
      if (correctionImages?.length || relatedStickerId) try {
        queueVisualCorrection({ groupId: authorized.groupId, text: authorized.content, messageId: event.message_id,
          sourceMessageId: authorized.imageReference?.messageId ?? event.message_id, relatedStickerId,
          loadImages: async () => correctionImages?.length ? readIncomingImages(correctionImages, sendMessage)
            : [await prepareNapCatImageBase64(readSticker(relatedStickerId, { approvedOnly: true }).bytes.toString("base64"), MAX_TOTAL_IMAGE_BYTES)] });
      } catch {}
      else if (/(?:角色|人物|认错|不是.{1,40}(?:那|她|他|它|这|图)?.{0,4}是)/u.test(authorized.content)) noteVisualLearningMissingImage(authorized.groupId);
    }
    if (authorized.mentioned) {
      cancelPendingGroupTurn(authorized.groupId);
      const context = passiveGroupContexts.get(authorized.groupId);
      if (context) context.updatedAt = Date.now();
    }
  }
  if (authorized.scope === "private" && readLlmSettings().forwardReadingEnabled !== false) rememberForwardMessage({ event, ...authorized, selfId: numericId(event.self_id) });
  const pacedSend = (action, params, extraGuard = () => true) => {
    const allowed = () => {
      const latest = readAccessControl();
      return (params.message_type === "group" ? latest.groupIds.includes(String(params.group_id)) : latest.userIds.includes(String(params.user_id))) && extraGuard();
    };
    if(action==="send_msg"&&readLlmSettings().longReplyForwardEnabled===false) {
      const {foldLongReply,...directParams}=params;
      return paceOneBotMessages(action,buildDirectReplyParts(directParams),sendMessage,allowed);
    }
    return paceOneBotMessage(action, params, (queuedAction, queuedParams) => {
      if (queuedAction !== "send_msg") return sendMessage(queuedAction, queuedParams);
      const settings = settingsForGroup(readLlmSettings(), queuedParams.message_type === "group" ? String(queuedParams.group_id) : null);
      return sendReplyWithFolding(queuedParams, sendMessage, { settings, selfId: numericId(event.self_id), allowed });
    }, allowed);
  };
  if (authorized.scope === "group" && authorized.mentioned && !authorized.messageContext?.mentions.some(item => !item.isBot)) {
    const memoryCommand = memberMemoryCommand(authorized.content);
    if (memoryCommand) {
      try {
        if (memoryCommand === "forget") forgetMemberImpression(authorized.groupId, authorized.userId);
        else resumeMemberImpression(authorized.groupId, authorized.userId);
        clearMemberLearningBuffer(authorized.groupId, authorized.userId);
        clearGroupConversations(authorized.groupId);
        clearRecentGroupImages(authorized.groupId);
        clearForwardContext(authorized.groupId);
        cancelPendingGroupTurn(authorized.groupId);
        passiveGroupContexts.delete(authorized.groupId);
        authorized.memberMemoryAction = memoryCommand;
      } catch { authorized.memberMemoryAction = "failed"; }
    }
  }
  const task = async () => {
    const latest = readAccessControl();
    if (authorized.scope === "group" ? !latest.groupIds.includes(authorized.groupId) : !latest.userIds.includes(authorized.userId)) return;
    if (authorized.imageReference && !canUseRecentGroupImages(authorized.imageReference, {
      groupId: authorized.groupId, since: settingsForGroup(readLlmSettings(), authorized.groupId).groupPersonaSince,
    })) {
      delete authorized.imageReference;
      delete authorized.messageContext.imageSource;
    }
    await handleAuthorizedMessage(event, { sendMessage: pacedSend }, config, authorized, latest);
  };
  if (authorized.scope === "private" || authorized.mentioned) return queueConversationReply(`${authorized.scope}:${authorized.groupId ?? authorized.userId}`, task);
  return task();
}

async function handleAuthorizedMessage(event, { sendMessage }, config, authorized, accessControl) {
  if (authorized.scope === "group" && authorized.mentioned) cancelPendingGroupTurn(authorized.groupId);

  let recoveryForwardSourceMessageId = authorized.recoveryJob?.forwardSourceMessageId ?? null;
  const temporaryFailure = text => /(?:暂时无法连接|(?:模型|网页搜索|Serper).{0,18}(?:超时|暂时出错|请求较多|暂时不可用)|模型回复.{0,12}(?:中断|超时)|转发消息暂时无法展开|这张图片暂时无法读取)/u.test(text);
  const scheduleRecovery = code => {
    if (authorized.recoveryJob) return;
    try { return enqueueReplyRecovery({ event, authorized, code, forwardSourceMessageId: recoveryForwardSourceMessageId }); }
    catch { console.warn("本次故障未能登记后台补发，请检查本机补发状态。"); }
  };
  const sendText = async (text) => {
    if (authorized.recoveryJob) { const error = new Error("Recovery not ready"); error.recoveryRetryable = temporaryFailure(text); throw error; }
    if (temporaryFailure(text) && scheduleRecovery("TRANSIENT_FAILURE")) text += "\n已登记后台重试，恢复后会补发这条回复。";
    return sendMessage("send_msg", {
    message_type: authorized.scope,
    ...(authorized.scope === "group" ? { group_id: authorized.groupId } : { user_id: authorized.userId }),
    message: text,
    auto_escape: true,
  }); };

  if (authorized.memberMemoryAction) {
    await sendText(authorized.memberMemoryAction === "forget" ? "已清除本群关于你的长期印象，并暂停继续积累。想恢复时可以对我说‘继续记住我’。"
      : authorized.memberMemoryAction === "resume" ? "已恢复本群关于你的印象积累。清除过的旧印象不会恢复。" : "这次没能修改你的成员印象，请管理员检查本机成员印象页。");
    return;
  }
  const command = getCommandMatch(authorized.content);
  if (command.kind === "matched") {
    if (authorized.scope === "group" && !authorized.mentioned) {
      cancelPendingGroupTurn(authorized.groupId);
      return;
    }
    try {
      await sendText(command.reply);
    } catch (error) {
      console.error("OneBot 消息回复失败：", safeErrorDetails(error));
    }
    return;
  }

  const searchIntent = parseSearchIntent(authorized.content);
  const summaryIntent = parseSummaryIntent(authorized.content);
  const imageGenerationIntent = parseImageGenerationIntent(authorized.content, settingsForGroup(readLlmSettings(), authorized.groupId).botAliases);
  let images = authorized.imageReference?.images ?? imageSegments(event.message);
  let imageRequested = images === null || images.length > 0;
  if (!authorized.recoveryJob && !imageGenerationIntent && authorized.scope === "group" && command.kind === "none"
    && segmentsOf(event.message).every((segment) => ["text", "at", "image", "reply"].includes(segment?.type))) {
    try { observeKnowledgeMessage({ groupId: authorized.groupId, userId: authorized.userId, text: authorized.content.replaceAll("[QQ表情]", "").trim(), settings: readLlmSettings(),
      messageId: event.message_id, relatedStickerId: authorized.messageContext?.reply?.stickerId,
      memberName: event.sender?.card || event.sender?.nickname || "", hasQuote: messageReferences(event.message).replyIds.length > 0 && !authorized.messageContext?.reply?.isBot,
      directedToBot: authorized.mentioned && !authorized.messageContext?.mentions.some(item => !item.isBot) }); } catch {}
  }

  if (authorized.scope === "group" && !authorized.mentioned) {
    const filteredPassiveMessage =
      command.kind !== "none"
      || searchIntent
      || imageRequested
      || hasAnyMention(event.message)
      || !isPlainTextMessage(event.message);
    if (filteredPassiveMessage) {
      cancelPendingGroupTurn(authorized.groupId);
      if (imageRequested && !hasAnyMention(event.message) && command.kind === "none" && !searchIntent) {
        await observeGroupStickers(images, authorized, sendMessage);
      }
      return;
    }
    let settings;
    try { settings = readLlmSettings(); } catch { return; }
    if (!settings.proactiveChatEnabled) {
      clearPassiveContexts();
      return;
    }
    if (!getCurrentLlmApiKey()) return;
    observeGroupMessage(authorized, { sendMessage }, config, accessControl, settings);
    return;
  }

  if (searchIntent && !searchIntent.query) {
    try {
      await sendText("请告诉我你想搜索什么，例如「/搜索 人工智能最新进展」。");
    } catch (error) {
      console.error("OneBot 消息回复失败：", safeErrorDetails(error));
    }
    return;
  }

  if (command.kind === "unknown" && !imageGenerationIntent && !searchIntent && !summaryIntent && !/^\/(?:看视频|看转发)(?:\s|$)/u.test(authorized.content)) {
    try {
      await sendText("这个指令我还不认识。发送「帮助」查看可用指令。");
    } catch (error) {
      console.error("OneBot 消息回复失败：", safeErrorDetails(error));
    }
    return;
  }

  let settings;
  try {
    settings = readLlmSettings();
  } catch {
    return;
  }

  if (imageGenerationIntent) {
    if (authorized.recoveryJob) return { status: "cancelled", recoveryRetryable: false };
    if (!settings.chatgptImageGenerationEnabled) { await sendText("ChatGPT 网页生图尚未开启，请管理员在聊天设置中开启。"); return; }
    const personaRevision = authorized.scope === "group" ? settingsForGroup(settings, authorized.groupId).groupPersonaRevision : null;
    const generation = authorized.scope === "group" ? memberLearningStamp(authorized.groupId, authorized.userId).generation : null;
    const allowed = () => {
      const current = readLlmSettings(), access = readAccessControl();
      return current.chatgptImageGenerationEnabled && (authorized.scope === "group"
        ? access.groupIds.includes(authorized.groupId) && settingsForGroup(current, authorized.groupId).groupPersonaRevision === personaRevision
          && memberLearningStamp(authorized.groupId, authorized.userId).generation === generation
        : access.userIds.includes(authorized.userId));
    };
    let generated;
    try {
      if (!event.message_id) throw new ChatGptImageError("MESSAGE_ID", "这条画图请求缺少消息编号，请重新发送。");
      let references = [];
      if (imageRequested) {
        if (!settings.visionEnabled || !Array.isArray(images) || images.length > MAX_IMAGE_COUNT) throw new ChatGptImageError("REFERENCES", "请开启图片识别，并一次最多发送两张参考图。");
        await acquireImageSlot();
        try { references = (await readIncomingImages(images, sendMessage)).map(image => image.dataUrl); }
        finally { releaseImageSlot(); }
      }
      generated = await generateChatGptImage({ prompt: imageGenerationIntent.prompt,
        sourceKey: `${event.self_id}:${authorized.scope}:${authorized.groupId ?? authorized.userId}:${event.message_id}`,
        referenceDataUrls: references, allowed });
      if (!allowed()) return;
      recordGeneratedImageDelivery(generated.id, "sending");
      const delivered = await sendMessage("send_msg", { message_type: authorized.scope,
        ...(authorized.scope === "group" ? { group_id: authorized.groupId } : { user_id: authorized.userId }),
        message: [{ type: "reply", data: { id: String(event.message_id) } },
          { type: "text", data: { text: "画好啦～" } },
          { type: "image", data: { file: `base64://${generated.bytes.toString("base64")}` } }], auto_escape: false }, allowed);
      recordGeneratedImageDelivery(generated.id, delivered?.cancelled ? "uncertain" : "delivered", delivered?.message_id);
    } catch (error) {
      if (generated) recordGeneratedImageDelivery(generated.id, "uncertain");
      if (allowed() && error.code !== "CANCELLED") await sendText(error instanceof ChatGptImageError || error instanceof ImageInputError
        ? error.message : "这次网页生图或图片发送没有完成，请管理员检查本机生图状态。");
    }
    return;
  }

  let forwardedMessages = null;
  let forwardBatchNeeded = false;
  const forwardRevision = authorized.scope === "group" ? settingsForGroup(settings, authorized.groupId).groupPersonaRevision : null;
  const forwardGeneration = authorized.scope === "group" ? memberLearningStamp(authorized.groupId, authorized.userId).generation : null;
  const forwardContextSince = authorized.scope === "group" ? groupMemberContextSince(authorized.groupId) : null;
  const forwardAllowed = () => {
    const latest = readLlmSettings(), access = readAccessControl();
    return latest.forwardReadingEnabled !== false && (!settings.visionEnabled || !forwardedMessages?.imageCount || latest.visionEnabled)
      && (authorized.scope === "group" ? access.groupIds.includes(authorized.groupId)
        && settingsForGroup(latest, authorized.groupId).groupPersonaRevision === forwardRevision
        && memberLearningStamp(authorized.groupId, authorized.userId).generation === forwardGeneration
        && groupMemberContextSince(authorized.groupId) === forwardContextSince : access.userIds.includes(authorized.userId));
  };
  if (settings.forwardReadingEnabled === false && hasForwardMessage(event.message)) {
    await sendText("转发消息阅读当前已关闭，请管理员在聊天设置中开启。"); return;
  }
  if (settings.forwardReadingEnabled !== false) {
    let forwardResolution=null;
    const source = authorized.recoveryForwardMessage ?? await resolveForwardSource({ event, ...authorized, text: authorized.content, selfId: numericId(event.self_id),
      addressedToBot:authorized.mentioned===true&&!authorized.followup,
      onResolution:value=>{forwardResolution=value;},
      since: authorized.scope === "group" ? settingsForGroup(settings, authorized.groupId).groupPersonaSince : 0, sendAction: sendMessage });
    if(forwardResolution)authorized.messageContext={...authorized.messageContext,forwardSource:forwardResolution};
    if(!source&&forwardResolution?.explicit&&forwardResolution.status==="unresolved") {
      const explanations={
        ambiguous:"找到了不止一条可能的合并转发，暂时无法确定你指哪条。请引用那条转发并 @我，我会展开里面的文字和图片。",
        "not-found":"这次没有定位到你说的那条转发。我能展开合并转发及其中图片；请引用原转发并 @我。无引用时只查本会话最近24小时、最多300条记录。",
        "quoted-out-of-scope":"这条引用不在当前会话可读取的范围内，或早于记忆重置边界。请在当前会话重新转发给我。",
        "quote-is-not-forward":"当前引用的不是合并转发消息。请引用原始转发卡片，或把里面的图片直接发来。",
        "quoted-unavailable":"这次未能取得你引用的原消息，尚未展开其中内容。可以稍后重试，或重新转发原记录；这不表示转发图片功能不支持。",
        "history-unavailable":"这次查询本会话历史记录失败，尚未定位到原转发。请引用原转发并 @我，或稍后再试。",
      };
      await sendText(explanations[forwardResolution.reason]??explanations["not-found"]);return;
    }
    if (source) {
      recoveryForwardSourceMessageId = source.messageId;
      try {
        forwardedMessages = await readForwardedMessages(source.message, { sendAction: sendMessage,
          imageNumbers: [...authorized.content.matchAll(/第\s*(\d{1,3})\s*张/gu)].map(match => Number(match[1])), allowed: forwardAllowed });
        forwardedMessages.source={relation:source.relation??"recovery",sourceTime:source.sourceTime??null};
        // A selected forward replaces implicit previous-image context. Directly
        // attached images keep priority over the forward's sampled images.
        images = imageSegments(event.message);
        if (authorized.imageReference) delete authorized.messageContext.imageSource;
        if (Array.isArray(images) && settings.visionEnabled) {
          forwardBatchNeeded = forwardedMessages.images.length > Math.max(0, MAX_IMAGE_COUNT - images.length)
            || JSON.stringify(forwardedMessages.nodes).length > 18000;
          const chosen = forwardBatchNeeded ? [] : forwardedMessages.images.slice(0, Math.max(0, MAX_IMAGE_COUNT - images.length));
          forwardedMessages.selectedImageNumbers = chosen.map(image => image.forwardedNumber);
          forwardedMessages.directImageCount = images.length;
          images = [...images, ...chosen];
        } else if (!settings.visionEnabled && forwardedMessages.imageCount) forwardedMessages.notes.push("图片识别关闭，转发图片仅作占位，未识别内容");
        if (!settings.visionEnabled) forwardedMessages.images = [];
        if (JSON.stringify(forwardedMessages.nodes).length > 18000) forwardBatchNeeded = true;
        imageRequested = images === null || images.length > 0;
      } catch (error) {
        await sendText(error instanceof ForwardReadError ? error.message : "这次没有读到转发消息，请重新转发或复制其中的文字。"); return;
      }
    }
  }
  if (!authorized.content && !searchIntent && !imageRequested && !forwardedMessages) return;

  const preloadedImageDataUrls = [];
  if (!authorized.recoveryJob && authorized.scope === "group" && authorized.mentioned && !authorized.messageContext?.mentions.some(x => !x.isBot)) {
    try {
      const feedback = noteStickerFeedback(authorized.groupId, authorized.content, authorized.messageContext?.reply?.stickerId);
      if (feedback && !feedback.ignored) {
        await sendText(feedback.status === "blocked" ? "这项表情偏好已经对本群生效，我会避开。" : "收到，先避开这类表情。已放入本群的待确认偏好，管理员可以在表情包页确认或撤销。");
        return;
      }
    } catch { console.warn("本群表情偏好暂未保存。"); }
  }
  let preparedImages = [];
  const tokenExchange = !authorized.recoveryJob && !forwardedMessages && /\btoken\s*来/iu.test(authorized.content) && imageRequested;
  const explicitStickerRequest = !authorized.recoveryJob && !forwardedMessages && authorized.scope === "group" && authorized.mentioned && isStickerCollectionRequest(authorized.content);
  let reservedImageSlot = false;
  let videoProgressTimer;
  let waitingForVideo = true;
  if (imageRequested) {
    if (!settings.visionEnabled) {
      try { await sendText("图片识别当前已关闭，请管理员在管理页开启后再试。"); } catch {}
      return;
    }
    if (!Array.isArray(images)) {
      try { await sendText("这张图片无法通过安全校验，请用 QQ 图片消息重新发送。"); } catch {}
      return;
    }
    if (images.length > MAX_IMAGE_COUNT) {
      try { await sendText("一次最多处理 2 张图片，请减少图片数量后再试。"); } catch {}
      return;
    }
    const apiKey = getCurrentLlmApiKey();
    if (!apiKey && !explicitStickerRequest) {
      const result = await getLlmReply({
        apiKey,
        searchApiKey: config.searchApiKey,
        settings,
        userId: `${authorized.scope}:${authorized.userId}`,
        senderQQId: authorized.userId,
        userMessage: authorized.content,
      });
      if (result.reply) {
        try { await sendText(result.reply); } catch {}
      }
      return;
    }
    await acquireImageSlot();
    reservedImageSlot = true;
    try {
      preparedImages = await readIncomingImages(images, sendMessage, {
        collectSources: !forwardedMessages && (tokenExchange || (authorized.scope === "group" && (settings.stickerLearningEnabled || explicitStickerRequest) && settings.stickersEnabled)),
      });
      preloadedImageDataUrls.push(...preparedImages.map((image) => image.dataUrl));
    } catch (error) {
      releaseImageSlot();
      reservedImageSlot = false;
      const reply = error instanceof ImageInputError
        ? error.message
        : "这张图片暂时无法安全读取，请重新发送 JPG、PNG 或 WebP 图片。";
      if (forwardedMessages && !forwardedMessages.directImageCount) {
        forwardedMessages.notes.push("转发内图片未能读取，下面只依据文字记录回答");
        preparedImages = []; preloadedImageDataUrls.length = 0;
      } else { try { await sendText(reply); } catch {} return; }
    }
  }

  try {
    if (forwardedMessages) forwardedMessages.imagesRead = Math.max(0, preloadedImageDataUrls.length - (forwardedMessages.directImageCount ?? 0));
    if (forwardBatchNeeded) {
      if (reservedImageSlot) { releaseImageSlot(); reservedImageSlot = false; }
      await prepareForwardReading(forwardedMessages, {
        allowed: forwardAllowed, userQuestion: authorized.content,
        describe: options => describeForwardBatch({ ...options, apiKey: getCurrentLlmApiKey(), settings, allowed: () => forwardAllowed() && (options.allowed?.() ?? true) }),
        withImages: async (refs, consume) => {
          await acquireImageSlot();
          try { if (!forwardAllowed()) return; return await consume(await readIncomingImages(refs, sendMessage, { maxCount: 9 })); }
          finally { releaseImageSlot(); }
        },
      });
    }
    if (forwardedMessages && !forwardAllowed()) return;
    if (tokenExchange && preparedImages[0]?.sourceBytes && readLlmSettings().stickersEnabled) {
      try {
        const bytes = preparedImages[0].sourceBytes;
        await approveStickerForSending(bytes);
        await sendMessage("send_msg", { message_type: authorized.scope,
          ...(authorized.scope === "group" ? { group_id: authorized.groupId } : { user_id: authorized.userId }),
          message: [{ type: "text", data: { text: "token回" } }, { type: "image", data: { file: `base64://${bytes.toString("base64")}`, sub_type: 1, summary: "[token回]" } }], auto_escape: true });
      } catch (error) { await sendText(error.name === "StickerReviewError" ? error.message.replace("尚未收藏", "这次暂不发送表情") : "这次暂时没能发出表情，请稍后再试。"); }
      return;
    }
    if (explicitStickerRequest && preparedImages.length) {
      if (!readLlmSettings().stickersEnabled) { await sendText("表情包功能当前已关闭，请管理员在管理页开启后再试。"); return; }
      let saved = 0;
      let collectionError = "";
      for (const image of preparedImages) {
        if (!image.sourceBytes) continue;
        try {
          const sticker = await addLearnedSticker({ bytes: image.sourceBytes, groupId: authorized.groupId,
            title: "群友赠送的表情", tags: ["群友赠送", "接梗"], requested: true,
            allowed: () => readLlmSettings().stickersEnabled && readAccessControl().groupIds.includes(authorized.groupId) });
          if (sticker) { saved += 1; queueStickerDescription(sticker.id); }
        } catch (error) { if (error.name === "StickerReviewError") collectionError = error.message; }
      }
      await sendText(saved ? "收下啦，合适的时候我就拿来接话～" : collectionError || "这次没能收藏，表情库可能已满，请管理员整理一下再试。");
      return;
    }
    const result = await getLlmReply({
      apiKey: getCurrentLlmApiKey(),
      searchApiKey: config.searchApiKey,
      settings,
      userId: `${authorized.scope}:${authorized.groupId ?? authorized.userId}:${authorized.userId}`,
      senderQQId: authorized.userId,
      groupId: authorized.scope === "group" ? authorized.groupId : null,
      userMessage: (summaryIntent ? authorized.content : searchIntent?.query ?? authorized.content) || (forwardedMessages ? "看看这段转发记录，简要说说主要内容和你的感受。" : ""),
      searchQuery: searchIntent?.query ?? null,
      attachments: [],
      preloadedImageDataUrls,
      queued: true,
      followup: Boolean(authorized.followup),
      conversationContext: !authorized.recoveryJob && authorized.scope === "group" && settings.conversationFollowupEnabled ? recentGroupContext(authorized.groupId, event.message_id) : [],
      messageContext: authorized.messageContext,
      forwardedMessages,
      requestTime: Number(event.time) * 1000,
      onVideoStart: () => {
        if (authorized.recoveryJob) return;
        if (videoProgressTimer) return;
        videoProgressTimer = setTimeout(() => {
          if (!waitingForVideo) return;
          void sendMessage("send_msg", { message_type: authorized.scope,
            ...(authorized.scope === "group" ? { group_id: authorized.groupId } : { user_id: authorized.userId }),
            message: "我在看这段视频，读语音可能要稍等一会儿～", auto_escape: true }, () => waitingForVideo).catch(() => {});
        }, 20000);
        videoProgressTimer.unref?.();
      },
      onSummaryStart: () => {
        if (authorized.recoveryJob) return;
        if (videoProgressTimer) return;
        videoProgressTimer = setTimeout(() => {
          if (!waitingForVideo) return;
          void sendMessage("send_msg", { message_type: authorized.scope,
            ...(authorized.scope === "group" ? { group_id: authorized.groupId } : { user_id: authorized.userId }),
            message: "我在查资料、读原文，整理重点需要稍等一下。", auto_escape: true }, () => waitingForVideo).catch(() => {});
        }, 20000);
        videoProgressTimer.unref?.();
      },
      onImageStart: () => {},
    });
    waitingForVideo = false;
    if (videoProgressTimer) clearTimeout(videoProgressTimer);
    if (forwardedMessages?.failedImageNumbers?.length && !forwardedMessages.nonRetryableImageFailure) {
      result.recoveryRetryable = true; result.errorCode = "FORWARD_IMAGE_READ";
      if (authorized.recoveryJob) result.status = "forward-partial";
    }
    if (authorized.recoveryJob) return result.recoveryRetryable && result.status === "ok" ? { ...result, status: "recovery-not-ready" } : result;
    if (result.recoveryRetryable && scheduleRecovery(result.errorCode || "TRANSIENT_FAILURE") && result.reply) result.reply += "\n已登记后台重试，恢复后会补发这条回复。";
    if (result.reply || result.stickerId) {
      const latestAccess = readAccessControl();
      if (authorized.scope === "group" ? !latestAccess.groupIds.includes(authorized.groupId) : !latestAccess.userIds.includes(authorized.userId)) return;
      await sendLlmResult(result, {
        message_type: authorized.scope,
        ...(authorized.scope === "group" ? { group_id: authorized.groupId } : { user_id: authorized.userId }),
      }, (action, params, stickerGuard = () => true) => sendMessage(action, params, () => stickerGuard()
        && (!forwardedMessages || forwardAllowed())
        && (authorized.scope !== "group" || result.memberImpressionGeneration === undefined || memberLearningStamp(authorized.groupId, authorized.userId).generation === result.memberImpressionGeneration)
        && (authorized.scope !== "group" || !result.groupPersonaRevision
        || settingsForGroup(readLlmSettings(), authorized.groupId).groupPersonaRevision === result.groupPersonaRevision)), { ...readLlmSettings(), onSent: (sent, metadata) => {
        if (authorized.scope !== "group") return;
        rememberGroupLine({ groupId: authorized.groupId, userId: "bot", text: result.reply || "[发送表情]", messageId: sent?.message_id, isBot: true, stickerId: metadata?.stickerId,
          targetUserId: authorized.userId, followup: Boolean(authorized.followup) });
        if (authorized.followup) try { acknowledgeGroupReply({ groupId: authorized.groupId, mentioned: true }); } catch {}
      } });
    } else if (result.status === "busy") {
      await sendText("我现在正在处理其他问题，请过一会儿再试。");
    }
  } catch (error) {
    if (authorized.recoveryJob) {
      if (error instanceof LlmRequestError) error.recoveryRetryable = /^(?:CONNECTION|TIMEOUT|BODY_|RATE_LIMITED|UPSTREAM_HTTP|EMPTY_|TOOLS_UNFINISHED|TRUNCATED)/u.test(error.code);
      throw error;
    }
    if (error instanceof LlmRequestError) {
      try {
        await sendText(error.message);
      } catch (sendError) {
        console.error("OneBot 消息回复失败：", safeErrorDetails(sendError));
      }
      return;
    }
    console.error("模型消息处理失败：", safeErrorDetails(error));
  } finally {
    waitingForVideo = false;
    if (videoProgressTimer) clearTimeout(videoProgressTimer);
    if (reservedImageSlot) releaseImageSlot();
    if (!authorized.recoveryJob && !forwardedMessages && authorized.scope === "group" && preparedImages.length) void learnIncomingStickers({ groupId: authorized.groupId, images: preparedImages });
  }
}

async function runRecoveredRequest(job, allowed, sendMessage, config) {
  return queueConversationReply(`${job.scope}:${job.peerId}`, async () => {
    if (!allowed()) return null;
    const native = await sendMessage("get_msg", { message_id: job.sourceMessageId });
    if (String(native.message_id) !== job.sourceMessageId || String(native.user_id ?? native.sender?.user_id) !== job.userId
      || (job.scope === "group" ? String(native.group_id) !== job.peerId : Boolean(native.group_id))) { const error = new Error("Recovery source changed"); error.recoveryRetryable = false; throw error; }
    const event = { ...native, post_type: "message", message_type: job.scope, sub_type: "friend", self_id: job.selfId, user_id: job.userId,
      ...(job.scope === "group" ? { group_id: job.peerId } : {}) };
    const access = readAccessControl(), authorized = authorizeEvent(event, access);
    if (!authorized) return null;
    authorized.mentioned = true; authorized.recoveryJob = job;
    authorized.messageContext = await resolveMessageContext({ event, groupId: job.scope === "group" ? job.peerId : null, selfId: job.selfId, sendAction: sendMessage });
    for (const [sourceId, kind] of [[job.forwardSourceMessageId, "forward"], [job.imageSourceMessageId, "image"]]) {
      if (!sourceId) continue;
      const source = sourceId === job.sourceMessageId ? native : await sendMessage("get_msg", { message_id: sourceId });
      const scopeMatches = job.scope === "group" ? String(source.group_id) === job.peerId : !source.group_id;
      const sameUser = String(source.user_id ?? source.sender?.user_id) === job.userId;
      const originalQuote = messageReferences(native.message).replyIds.includes(String(sourceId));
      const ageAtRequest = job.sourceAt - Number(source.time)*1000;
      if (!scopeMatches || (!sameUser && !originalQuote) || !Number.isFinite(ageAtRequest) || ageAtRequest < -30000 || ageAtRequest > (originalQuote ? 15 : 3)*60_000) continue;
      if (kind === "forward" && hasForwardMessage(source.message)) authorized.recoveryForwardMessage = { message: source.message, messageId: sourceId };
      if (kind === "image") authorized.imageReference = { images: imageSegments(source.message), messageId: sourceId };
    }
    if (!allowed()) return null;
    return handleAuthorizedMessage(event, { sendMessage }, config, authorized, access);
  });
}

async function main() {
  const config = getConfig();
  sensitiveValues.add(config.onebotAccessToken);
  if (config.llmApiKey) sensitiveValues.add(config.llmApiKey);
  if (config.searchApiKey) sensitiveValues.add(config.searchApiKey);
  if (getSearchApiKey("serper")) sensitiveValues.add(getSearchApiKey("serper"));
  readCommands();
  readLlmSettings();
  readAccessControl();
  ensureGroupPersonas(readAccessControl().groupIds, readLlmSettings());

  const controller = new AbortController();
  const stop = (signal) => {
    console.log(`收到 ${signal}，正在停止 OneBot 桥接……`);
    clearPassiveContexts();
    clearKnowledgeLearning();
    clearGroupConversations();
    stopStickerLearning();
    controller.abort();
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const bridge = createOneBotBridge({
    port: config.onebotPort,
    path: config.onebotPath,
    accessToken: config.onebotAccessToken,
    onMessage: (event, context) => handleMessage(event, context, config),
  });
  let managementServer;
  let modelProxy;
  let replyRecovery;
  let videoDiscovery;
  let memoryMaintenance;
  try {
    modelProxy = await startConfiguredModelProxy();
    if (controller.signal.aborted) return;
    await bridge.start();
    memoryMaintenance = startMemoryMaintenance();
    replyRecovery = startReplyRecovery({ sendAction: bridge.sendMessage, connected: () => bridge.getStatus().connected,
      run: (job, allowed) => runRecoveredRequest(job, allowed, bridge.sendMessage, config),
      pace:(action,params,sendAction,allowed,selfId)=> {
        if(action!=="send_msg")return sendAction(action,params);
        const settings=settingsForGroup(readLlmSettings(),params.message_type==="group"?String(params.group_id):null);
        // Forward cards cannot carry an outer reply quote. Keep the source in
        // the recovery receipt; only omit that quote when a card can be built.
        const withoutQuote={...params,message:Array.isArray(params.message)?params.message.filter(part=>part.type!=="reply"):params.message};
        if(buildLongReply(withoutQuote,{settings,selfId}))return paceOneBotMessage(action,params,(_action,queued)=>
          sendReplyWithFolding({...queued,message:withoutQuote.message},sendAction,{settings,selfId,allowed}),allowed);
        return paceOneBotMessages(action,buildDirectReplyParts(params),sendAction,allowed);
      } });
    videoDiscovery = startVideoDiscovery({ sendAction: bridge.sendMessage, connected: () => bridge.getStatus().connected, pace: paceOneBotMessage,
      onShared: ({ groupId, text, messageId }) => {
        rememberGroupLine({ groupId, userId: "bot", text, isBot: true, messageId });
        recordExternalProactiveReply({ groupId, text, messageId, pauseWhenIgnored: readLlmSettings().proactivePauseWhenIgnored });
      } });
    managementServer = await startManagementServer({
      getOneBotStatus: () => ({
        ...bridge.getStatus(),
        wsEndpoint: `ws://127.0.0.1:${config.onebotPort}${config.onebotPath}`,
      }),
      onLlmSettingsSaved: (settings) => {
        if (getSearchApiKey("serper")) sensitiveValues.add(getSearchApiKey("serper"));
        if (!settings.conversationFollowupEnabled) clearGroupConversations();
        if (!settings.visionEnabled) clearRecentGroupImages();
        if (settings.forwardReadingEnabled === false) clearForwardContext();
        if (!settings.proactiveChatEnabled) clearPassiveContexts();
        if ((!settings.knowledgeLearningEnabled || !settings.knowledgeEnabled) && (!settings.memberImpressionsEnabled || !settings.memberImpressionsLearningEnabled)
          && !readAccessControl().groupIds.some(groupId => { const growth = growthLearningStamp(groupId); return growth.enabled && growth.learningEnabled; })) clearKnowledgeLearning();
        if (settings.stickersEnabled && settings.visionEnabled) queuePendingStickerDescriptions();
      },
      onGroupPersonaSaved: (groupId) => {
        clearGroupConversations(groupId);
        clearRecentGroupImages(groupId);
        clearForwardContext(groupId);
        cancelPendingGroupTurn(groupId);
        cancelContextExpiry(groupId);
        passiveGroupContexts.delete(groupId);
      },
      onMemberImpressionChanged: (groupId, userId) => {
        clearMemberLearningBuffer(groupId, userId); clearGroupConversations(groupId);
        clearRecentGroupImages(groupId);
        clearForwardContext(groupId);
        cancelPendingGroupTurn(groupId); passiveGroupContexts.delete(groupId);
      },
    });
    console.log("NapCat OneBot 11 桥接已启动，仅监听 127.0.0.1。");
    console.log(`WebSocket 接入地址：ws://127.0.0.1:${config.onebotPort}${config.onebotPath}`);
    queuePendingStickerDescriptions();
    await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
  } finally {
    replyRecovery?.stop();
    videoDiscovery?.stop();
    memoryMaintenance?.stop();
    stopChatGptImageGeneration();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await bridge.close();
    await closeModelConnections();
    await closeSearchConnections();
    await modelProxy?.stop();
    if (managementServer) {
      await new Promise((resolveClose, rejectClose) => {
        managementServer.close((error) => error ? rejectClose(error) : resolveClose());
      });
    }
  }
}

main().catch((error) => {
  console.error("机器人启动失败：", safeErrorDetails(error));
  process.exitCode = 1;
});
