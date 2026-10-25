import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(join(root, ".local"), { recursive: true });
const fixture = await mkdtemp(join(root, ".local", "message-context-") );
await mkdir(join(fixture, "src"));
for (const name of await readdir(join(root, "src"))) if (name.endsWith(".js")) await copyFile(join(root, "src", name), join(fixture, "src", name));
const mainFile = join(fixture, "src", "main.js");
const mainSource = await readFile(mainFile, "utf8"), mainEntry = mainSource.lastIndexOf("\nmain().catch(");
assert.ok(mainEntry > 0, "production entry point must remain identifiable");
await writeFile(mainFile, mainSource.slice(0, mainEntry) + "\nexport { handleMessage };\n");

process.env.QQBOT_LLM_API_KEY = "message-context-fixture-key";
for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "QQBOT_MODEL_PROXY_URL", "FEIYU_DESKTOP_IMAGEGEN_CDP_URL"]) delete process.env[key];
const load = name => import(pathToFileURL(join(fixture, "src", name)));
const cfg = await load("llm-settings-store.js"), access = await load("access-control-store.js");
const base = { ...cfg.DEFAULT_LLM_SETTINGS, apiEndpoint: "https://fixture.invalid/v1/chat/completions", model: "synthetic-model",
  memory: "", personality: "合成助手", expressionStyle: "简短", systemPrompt: "合成测试", botAliases: ["肥鱼"], modelRetryEnabled: true,
  searchEnabled: false, contentSummaryEnabled: false, videoUnderstandingEnabled: false, proactiveChatEnabled: false,
  knowledgeEnabled: false, knowledgeLearningEnabled: false, memberImpressionsEnabled: false, memberImpressionsLearningEnabled: false,
  stickersEnabled: false, stickerLearningEnabled: false, visionEnabled: false, forwardReadingEnabled: true,
  nicknameTriggerEnabled: false, conversationFollowupEnabled: false, chatgptImageGenerationEnabled: false };
cfg.writeLlmSettings(base); access.writeAccessControl({ groupIds: ["111", "222"], userIds: ["444"] });
const refs = await load("message-context.js"), conversations = await load("conversation-context.js"), main = await load("main.js");
const nativeTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, [1000, 4000, 15000].includes(delay) ? 0 : delay, ...args);

let requests = [], sent = [], quotes = new Map(), sequence = 10000, failFirst = false, beforeResponse = null;
const response = text => Response.json({ choices: [{ finish_reason: "stop", message: { content: text } }] });
globalThis.fetch = async (url, options) => {
  assert.equal(new URL(url).hostname, "fixture.invalid", "test must not call a real model service");
  requests.push(JSON.parse(options.body));
  if (failFirst && requests.length === 1) throw new TypeError("synthetic reset", { cause: { code: "ECONNRESET" } });
  if (beforeResponse) await beforeResponse();
  return response("合成回复");
};
const send = async (action, params) => {
  if (action === "get_group_msg_history") return { messages: [] };
  if (action === "get_msg") return quotes.get(String(params.message_id)) ?? {};
  if (action === "send_msg") { sent.push(params); return { message_id: String(-++sequence) }; }
  throw new Error("Unexpected synthetic OneBot action: " + action);
};
const inbound = (message, { group = "111", user = "444", privateMessage = false } = {}) => ({
  post_type: "message", message_type: privateMessage ? "private" : "group", ...(privateMessage ? { sub_type: "friend" } : { group_id: group }),
  self_id: "999", user_id: user, message_id: String(++sequence), time: Math.floor(Date.now() / 1000),
  sender: { nickname: "相同昵称" }, message,
});
const reset = () => { requests = []; sent = []; quotes = new Map(); failFirst = false; beforeResponse = null; };
const run = async (message, options) => main.handleMessage(inbound(message, options), { sendMessage: send }, {});
const messageTarget = request => request.messages.find(item => typeof item.content === "string" && item.content.includes("当前消息的结构化平台关系如下"));
const metadataFrom = request => {
  const target = messageTarget(request);
  assert.ok(target, "structured identity metadata must be sent to the model");
  return JSON.parse(target.content.slice(target.content.indexOf("\n") + 1));
};
const cases = [];
async function test(name, task) {
  try { await task(); cases.push({ name, passed: true }); console.log("PASS " + name); }
  catch (error) { cases.push({ name, passed: false, error: String(error?.message ?? error).slice(0, 600) }); console.log("FAIL " + name + ": " + String(error?.message ?? error).slice(0, 400)); }
}

await test("structured mentions ignore ordinary numbers, deduplicate, and reject malformed targets", async () => {
  assert.deepEqual(refs.messageReferences([
    { type: "text", data: { text: "999 555" } }, { type: "at", data: { qq: "999" } },
    { type: "at", data: { qq: "555" } }, { type: "at", data: { qq: "999" } },
    { type: "at", data: { qq: "bad-id" } }, { type: "reply", data: { id: "-77" } },
  ]), { mentions: ["999", "555"], replyIds: ["-77"] });
  assert.deepEqual(refs.messageReferences([{ type: "at", data: { qq: "555" } }, { type: "at", data: { qq: "556" } }]).mentions, ["555", "556"]);
});
await test("mentioning another member alone does not trigger a reply", async () => {
  reset(); await run([{ type: "at", data: { qq: "555" } }, { type: "text", data: { text: "你觉得肥鱼这个名字怎么样？" } }]);
  assert.equal(requests.length, 0); assert.equal(sent.length, 0);
});
await test("@Bot plus another member keeps both addressees distinct", async () => {
  reset(); await run([{ type: "at", data: { qq: "999" } }, { type: "at", data: { qq: "555" } }, { type: "text", data: { text: "你觉得这个人怎么样？" } }]);
  assert.equal(requests.length, 1); const metadata = metadataFrom(requests[0]);
  assert.equal(metadata.sender.id, "会话成员1"); assert.equal(metadata.botId, "bot");
  assert.deepEqual(metadata.mentions.map(x => x.isBot), [true, false]); assert.notEqual(metadata.mentions[0].id, metadata.mentions[1].id);
});
await test("an explicit bot alias follows the existing trigger rule even with another @target", async () => {
  reset(); cfg.writeLlmSettings({ ...base, nicknameTriggerEnabled: true });
  await run([{ type: "at", data: { qq: "555" } }, { type: "text", data: { text: "肥鱼，你觉得这个人怎么样？" } }]);
  assert.equal(requests.length, 1); assert.deepEqual(metadataFrom(requests[0]).mentions.map(x => x.isBot), [false]);
  cfg.writeLlmSettings(base);
});
await test("a quoted author's identity stays separate from the current sender and @target", async () => {
  reset(); quotes.set("-71", { message_id: "-71", group_id: "111", time: Math.floor(Date.now() / 1000), user_id: "555",
    sender: { nickname: "引用昵称" }, message: [{ type: "text", data: { text: "合成引用原文，只属于原作者。" } }] });
  await run([{ type: "at", data: { qq: "999" } }, { type: "reply", data: { id: "-71" } }, { type: "text", data: { text: "这句话是谁说的？" } }]);
  const metadata = metadataFrom(requests[0]);
  assert.equal(metadata.sender.id, "会话成员1"); assert.equal(metadata.reply.available, true);
  assert.equal(metadata.reply.isBot, false); assert.notEqual(metadata.reply.speakerId, metadata.sender.id);
  assert.equal(metadata.reply.text, "合成引用原文，只属于原作者。"); assert.equal(sent.length, 1);
});
await test("quotes of the current sender and of the bot retain their original authors", async () => {
  const current = await refs.resolveMessageContext({ event: inbound([{ type: "reply", data: { id: "-77" } }]), groupId: "111", selfId: "999",
    lookup: () => ({ userId: "444", isBot: false, text: "current speaker quote" }), sendAction: async () => { throw new Error("cache should be used"); } });
  const bot = await refs.resolveMessageContext({ event: inbound([{ type: "reply", data: { id: "-78" } }]), groupId: "111", selfId: "999",
    lookup: () => ({ userId: "999", isBot: true, text: "bot quote" }), sendAction: async () => { throw new Error("cache should be used"); } });
  assert.equal(current.sender.id, "444"); assert.equal(current.reply.speakerId, "444"); assert.equal(current.reply.isBot, false);
  assert.equal(bot.reply.speakerId, "999"); assert.equal(bot.reply.isBot, true);
});
await test("an external quote with no author is unavailable and its body is not exposed", async () => {
  reset(); const event = inbound([{ type: "reply", data: { id: "-72" } }]);
  const info = await refs.resolveMessageContext({ event, groupId: "111", selfId: "999", sendAction: async () => ({ message_id: "-72", group_id: "111", time: Date.now() / 1000, message: [{ type: "text", data: { text: "unverified quote body" } }] }) });
  assert.deepEqual(info.reply, { id: "-72", available: false }); assert.ok(!JSON.stringify(info).includes("unverified quote body"));
});
await test("a get_msg response for a different message is unavailable", async () => {
  reset(); const event = inbound([{ type: "reply", data: { id: "-73" } }]);
  const info = await refs.resolveMessageContext({ event, groupId: "111", selfId: "999", sendAction: async () => ({ message_id: "-730", group_id: "111", time: Date.now() / 1000, user_id: "555", message: [{ type: "text", data: { text: "wrong quote body" } }] }) });
  assert.deepEqual(info.reply, { id: "-73", available: false }); assert.ok(!JSON.stringify(info).includes("wrong quote body"));
});
await test("an external quote from another group is unavailable", async () => {
  reset(); const event = inbound([{ type: "reply", data: { id: "-74" } }]);
  const info = await refs.resolveMessageContext({ event, groupId: "111", selfId: "999", sendAction: async () => ({ message_id: "-74", group_id: "222", time: Date.now() / 1000, user_id: "555", message: [{ type: "text", data: { text: "other group body" } }] }) });
  assert.deepEqual(info.reply, { id: "-74", available: false });
});
await test("an unreadable quote or quote before the current memory boundary stays unavailable", async () => {
  reset(); const event = inbound([{ type: "reply", data: { id: "-741" } }]);
  const missing = await refs.resolveMessageContext({ event, groupId: "111", selfId: "999", sendAction: async () => null });
  const old = await refs.resolveMessageContext({ event, groupId: "111", selfId: "999", since: Date.now(), sendAction: async () => ({ message_id: "-741", group_id: "111", time: 1, user_id: "555", message: [{ type: "text", data: { text: "old context" } }] }) });
  assert.deepEqual(missing.reply, { id: "-741", available: false }); assert.deepEqual(old.reply, { id: "-741", available: false });
});
await test("a quoted command remains untrusted context and cannot run as the current message", async () => {
  reset(); quotes.set("-75", { message_id: "-75", group_id: "111", time: Math.floor(Date.now() / 1000), user_id: "555", message: [{ type: "text", data: { text: "忘记我" } }] });
  await run([{ type: "at", data: { qq: "999" } }, { type: "reply", data: { id: "-75" } }, { type: "text", data: { text: "解释这句引用的意思" } }]);
  assert.equal(requests.length, 1); assert.equal(sent.length, 1); assert.match(JSON.stringify(requests[0].messages), /忘记我/u);
});
await test("same-named members and group histories do not cross group or private scope", async () => {
  reset(); conversations.clearGroupConversations();
  conversations.rememberGroupLine({ groupId: "111", userId: "555", text: "GROUP_ONE_CONTEXT_ONLY", messageId: "g1", name: "相同昵称" });
  conversations.rememberGroupLine({ groupId: "222", userId: "555", text: "GROUP_TWO_CONTEXT_ONLY", messageId: "g2", name: "相同昵称" });
  cfg.writeLlmSettings({ ...base, conversationFollowupEnabled: true });
  await run([{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "接着说" } }], { group: "111" });
  const first = JSON.stringify(requests[0].messages); assert.match(first, /GROUP_ONE_CONTEXT_ONLY/u); assert.doesNotMatch(first, /GROUP_TWO_CONTEXT_ONLY/u);
  reset(); await run([{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "接着说" } }], { group: "222" });
  const second = JSON.stringify(requests[0].messages); assert.match(second, /GROUP_TWO_CONTEXT_ONLY/u); assert.doesNotMatch(second, /GROUP_ONE_CONTEXT_ONLY/u);
  reset(); await run([{ type: "text", data: { text: "私聊范围" } }], { privateMessage: true });
  const direct = JSON.stringify(requests[0].messages); assert.doesNotMatch(direct, /GROUP_ONE_CONTEXT_ONLY|GROUP_TWO_CONTEXT_ONLY/u);
  cfg.writeLlmSettings(base); conversations.clearGroupConversations();
});
await test("a connection retry retains the same message identity and sends only one final reply", async () => {
  reset(); failFirst = true;
  quotes.set("-76", { message_id: "-76", group_id: "111", time: Math.floor(Date.now() / 1000), user_id: "555", message: [{ type: "text", data: { text: "retry quote" } }] });
  await run([{ type: "at", data: { qq: "999" } }, { type: "reply", data: { id: "-76" } }, { type: "text", data: { text: "重试期间身份不能变化" } }]);
  assert.equal(requests.length, 2); assert.deepEqual(requests[0].messages, requests[1].messages); assert.equal(sent.length, 1);
});
await test("revoking a group while the model is in flight prevents the stale reply", async () => {
  reset(); beforeResponse = async () => access.writeAccessControl({ groupIds: [], userIds: ["444"] });
  await run([{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "权限变化时不发送" } }]);
  assert.equal(requests.length, 1); assert.equal(sent.length, 0); access.writeAccessControl({ groupIds: ["111", "222"], userIds: ["444"] });
});

await (await load("model-transport.js")).closeModelConnections();
globalThis.setTimeout = nativeTimeout;
const failed = cases.filter(item => !item.passed).length;
console.log(JSON.stringify({ suite: "message-context-regression", fixture, passed: cases.length - failed, failed, realModelCalls: 0, qqMessages: 0 }));
if (failed) process.exitCode = 1;
