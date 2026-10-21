// Capture the image-networking baseline before application dependencies load.
import {
  prepareNapCatImageBase64,
  isNapCatImageFile,
  ImageInputError,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  MAX_TOTAL_IMAGE_BYTES,
  MAX_TOTAL_SOURCE_IMAGE_BYTES,
} from "./image-input.js";
import { getConfig, getLlmApiKey } from "./config.js";
import { readAccessControl } from "./access-control-store.js";
import { getCommandMatch } from "./commands.js";
import { readCommands } from "./command-store.js";
import { getLlmReply, LlmRequestError } from "./llm.js";
import { extractBilibiliReference } from "./bilibili-video.js";
import { readLlmSettings } from "./llm-settings-store.js";
import { ensureGroupPersonas, settingsForGroup } from "./group-personas.js";
import { createOneBotBridge } from "./onebot.js";
import { recordProactiveReply, reserveProactiveEvaluation, recordProactiveWaiting, acknowledgeGroupReply } from "./proactive-chat-state.js";
import { parseSearchIntent } from "./search-intent.js";
import { parseSummaryIntent } from "./content-summary.js";
import { startManagementServer } from "./web.js";
import { observeKnowledgeMessage, clearKnowledgeLearning } from "./knowledge-learning.js";
import { addLearnedSticker, approveStickerForSending, sendLlmResult } from "./sticker-store.js";
import { canLearnSticker, learnIncomingStickers, queuePendingStickerDescriptions, queueStickerDescription, stopStickerLearning } from "./sticker-learning.js";
import { queueConversationReply, paceOneBotMessage } from "./reply-queue.js";
import { sendReplyWithFolding } from "./long-reply.js";
import { rememberGroupLine, warmGroupContext, isPossibleBotFollowup, recentGroupContext, clearGroupConversations, findGroupLine } from "./conversation-context.js";
import { resolveMessageContext, messageReferences } from "./message-context.js";
import { noteStickerFeedback } from "./sticker-preferences.js";
import { memberMemoryCommand, forgetMemberImpression, resumeMemberImpression, memberLearningStamp } from "./member-impressions.js";
import { clearMemberLearningBuffer } from "./knowledge-learning.js";

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

async function readIncomingImages(images, sendMessage, { collectSources = false } = {}) {
  if (!Array.isArray(images) || images.length > MAX_IMAGE_COUNT) throw new ImageInputError("一次最多处理 2 张图片，请减少图片数量后再试。");
  const prepared = [];
  let totalBytes = 0;
  let totalSourceBytes = 0;
  for (const segment of images) {
    const file = segment?.data?.file;
    if (!isNapCatImageFile(file)) throw new ImageInputError("这张图片的 QQ 文件标识无法识别，请从 QQ 重新发送图片或表情。");
    const result = await sendMessage("get_image", { file });
    const image = await prepareNapCatImageBase64(result?.base64, MAX_TOTAL_IMAGE_BYTES - totalBytes, {
      remainingSourceBytes: MAX_TOTAL_SOURCE_IMAGE_BYTES - totalSourceBytes,
      includeSourceBytes: collectSources,
    });
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
    let personaSince = 0;
    try {
      const settings = settingsForGroup(readLlmSettings(), authorized.groupId);
      personaSince = settings.groupPersonaSince;
      followupEnabled = settings.conversationFollowupEnabled;
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
    if (followupEnabled && !authorized.mentioned && isPossibleBotFollowup({ groupId: authorized.groupId, userId: authorized.userId, text: authorized.content,
      replyIds: messageReferences(event.message).replyIds, mentionsOther: hasAnyMention(event.message) })) {
      authorized.mentioned = true;
      authorized.followup = true;
    }
    if (followupEnabled) rememberGroupLine({ groupId: authorized.groupId, userId: authorized.userId, text: authorized.content, messageId: event.message_id,
      name: event.sender?.card || event.sender?.nickname });
    if (authorized.mentioned) {
      cancelPendingGroupTurn(authorized.groupId);
      const context = passiveGroupContexts.get(authorized.groupId);
      if (context) context.updatedAt = Date.now();
    }
  }
  const pacedSend = (action, params, extraGuard = () => true) => {
    const allowed = () => {
      const latest = readAccessControl();
      return (params.message_type === "group" ? latest.groupIds.includes(String(params.group_id)) : latest.userIds.includes(String(params.user_id))) && extraGuard();
    };
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
        cancelPendingGroupTurn(authorized.groupId);
        passiveGroupContexts.delete(authorized.groupId);
        authorized.memberMemoryAction = memoryCommand;
      } catch { authorized.memberMemoryAction = "failed"; }
    }
  }
  const task = async () => {
    const latest = readAccessControl();
    if (authorized.scope === "group" ? !latest.groupIds.includes(authorized.groupId) : !latest.userIds.includes(authorized.userId)) return;
    await handleAuthorizedMessage(event, { sendMessage: pacedSend }, config, authorized, latest);
  };
  if (authorized.scope === "private" || authorized.mentioned) return queueConversationReply(`${authorized.scope}:${authorized.groupId ?? authorized.userId}`, task);
  return task();
}

async function handleAuthorizedMessage(event, { sendMessage }, config, authorized, accessControl) {
  if (authorized.scope === "group" && authorized.mentioned) cancelPendingGroupTurn(authorized.groupId);

  const sendText = async (text) => sendMessage("send_msg", {
    message_type: authorized.scope,
    ...(authorized.scope === "group" ? { group_id: authorized.groupId } : { user_id: authorized.userId }),
    message: text,
    auto_escape: true,
  });

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
  const images = imageSegments(event.message);
  const imageRequested = images === null || images.length > 0;
  if (authorized.scope === "group" && command.kind === "none" && !searchIntent && !summaryIntent
    && segmentsOf(event.message).every((segment) => ["text", "at", "image", "reply"].includes(segment?.type))) {
    try { observeKnowledgeMessage({ groupId: authorized.groupId, userId: authorized.userId, text: authorized.content.replaceAll("[QQ表情]", "").trim(), settings: readLlmSettings(),
      messageId: event.message_id, relatedStickerId: authorized.messageContext?.reply?.stickerId,
      memberName: event.sender?.card || event.sender?.nickname || "", hasQuote: messageReferences(event.message).replyIds.length > 0 }); } catch {}
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

  if (command.kind === "unknown" && !searchIntent && !summaryIntent && !/^\/看视频\s/u.test(authorized.content)) {
    try {
      await sendText("这个指令我还不认识。发送「帮助」查看可用指令。");
    } catch (error) {
      console.error("OneBot 消息回复失败：", safeErrorDetails(error));
    }
    return;
  }

  if (!authorized.content && !searchIntent && !imageRequested) return;

  let settings;
  try {
    settings = readLlmSettings();
  } catch {
    return;
  }

  const preloadedImageDataUrls = [];
  if (authorized.scope === "group" && authorized.mentioned && !authorized.messageContext?.mentions.some(x => !x.isBot)) {
    try {
      const feedback = noteStickerFeedback(authorized.groupId, authorized.content, authorized.messageContext?.reply?.stickerId);
      if (feedback && !feedback.ignored) {
        await sendText(feedback.status === "blocked" ? "这项表情偏好已经对本群生效，我会避开。" : "收到，先避开这类表情。已放入本群的待确认偏好，管理员可以在表情包页确认或撤销。");
        return;
      }
    } catch { console.warn("本群表情偏好暂未保存。"); }
  }
  let preparedImages = [];
  const tokenExchange = /\btoken\s*来/iu.test(authorized.content) && imageRequested;
  const explicitStickerRequest = authorized.scope === "group" && authorized.mentioned && isStickerCollectionRequest(authorized.content);
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
        collectSources: tokenExchange || (authorized.scope === "group" && (settings.stickerLearningEnabled || explicitStickerRequest) && settings.stickersEnabled),
      });
      preloadedImageDataUrls.push(...preparedImages.map((image) => image.dataUrl));
    } catch (error) {
      releaseImageSlot();
      reservedImageSlot = false;
      const reply = error instanceof ImageInputError
        ? error.message
        : "这张图片暂时无法安全读取，请重新发送 JPG、PNG 或 WebP 图片。";
      try { await sendText(reply); } catch {}
      return;
    }
  }

  try {
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
      userMessage: summaryIntent ? authorized.content : searchIntent?.query ?? authorized.content,
      searchQuery: searchIntent?.query ?? null,
      attachments: [],
      preloadedImageDataUrls,
      queued: true,
      followup: Boolean(authorized.followup),
      conversationContext: authorized.scope === "group" && settings.conversationFollowupEnabled ? recentGroupContext(authorized.groupId, event.message_id) : [],
      messageContext: authorized.messageContext,
      onVideoStart: () => {
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
        if (videoProgressTimer) return;
        videoProgressTimer = setTimeout(() => {
          if (!waitingForVideo) return;
          void sendMessage("send_msg", { message_type: authorized.scope,
            ...(authorized.scope === "group" ? { group_id: authorized.groupId } : { user_id: authorized.userId }),
            message: "我在查资料、读原文，整理重点需要稍等一下。", auto_escape: true }, () => waitingForVideo).catch(() => {});
        }, 20000);
        videoProgressTimer.unref?.();
      },
      onImageStart: () => {
        if (videoProgressTimer) return;
        videoProgressTimer = setTimeout(() => {
          if (!waitingForVideo) return;
          void sendMessage("send_msg", { message_type: authorized.scope,
            ...(authorized.scope === "group" ? { group_id: authorized.groupId } : { user_id: authorized.userId }),
            message: "我在仔细看这张图，辨认一下角色，稍等一会儿～", auto_escape: true }, () => waitingForVideo).catch(() => {});
        }, 20000);
        videoProgressTimer.unref?.();
      },
    });
    waitingForVideo = false;
    if (videoProgressTimer) clearTimeout(videoProgressTimer);
    if (result.reply || result.stickerId) {
      const latestAccess = readAccessControl();
      if (authorized.scope === "group" ? !latestAccess.groupIds.includes(authorized.groupId) : !latestAccess.userIds.includes(authorized.userId)) return;
      await sendLlmResult(result, {
        message_type: authorized.scope,
        ...(authorized.scope === "group" ? { group_id: authorized.groupId } : { user_id: authorized.userId }),
      }, (action, params, stickerGuard = () => true) => sendMessage(action, params, () => stickerGuard()
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
    if (authorized.scope === "group" && preparedImages.length) void learnIncomingStickers({ groupId: authorized.groupId, images: preparedImages });
  }
}

async function main() {
  const config = getConfig();
  sensitiveValues.add(config.onebotAccessToken);
  if (config.llmApiKey) sensitiveValues.add(config.llmApiKey);
  if (config.searchApiKey) sensitiveValues.add(config.searchApiKey);
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
  try {
    await bridge.start();
    managementServer = await startManagementServer({
      getOneBotStatus: () => ({
        ...bridge.getStatus(),
        wsEndpoint: `ws://127.0.0.1:${config.onebotPort}${config.onebotPath}`,
      }),
      onLlmSettingsSaved: (settings) => {
        if (!settings.conversationFollowupEnabled) clearGroupConversations();
        if (!settings.proactiveChatEnabled) clearPassiveContexts();
        if ((!settings.knowledgeLearningEnabled || !settings.knowledgeEnabled) && (!settings.memberImpressionsEnabled || !settings.memberImpressionsLearningEnabled)) clearKnowledgeLearning();
        if (settings.stickersEnabled && settings.visionEnabled) queuePendingStickerDescriptions();
      },
      onGroupPersonaSaved: (groupId) => {
        clearGroupConversations(groupId);
        cancelPendingGroupTurn(groupId);
        cancelContextExpiry(groupId);
        passiveGroupContexts.delete(groupId);
      },
      onMemberImpressionChanged: (groupId, userId) => {
        clearMemberLearningBuffer(groupId, userId); clearGroupConversations(groupId);
        cancelPendingGroupTurn(groupId); passiveGroupContexts.delete(groupId);
      },
    });
    console.log("NapCat OneBot 11 桥接已启动，仅监听 127.0.0.1。");
    console.log(`WebSocket 接入地址：ws://127.0.0.1:${config.onebotPort}${config.onebotPath}`);
    queuePendingStickerDescriptions();
    await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await bridge.close();
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
