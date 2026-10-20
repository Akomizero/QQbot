import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";
import sharp from "sharp";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(join(root, ".local"), { recursive: true });
const fixture = await mkdtemp(join(root, ".local", "p0-verification-"));
for (const folder of ["src", "public"]) {
  await mkdir(join(fixture, folder));
  for (const name of await readdir(join(root, folder))) if (/\.(js|html|css)$/u.test(name)) await copyFile(join(root, folder, name), join(fixture, folder, name));
}
process.env.QQBOT_LLM_API_KEY = "isolated-fixture-only-key";
process.env.TAVILY_API_KEY = "isolated-fixture-only-search-key";
for (const variable of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) delete process.env[variable];
const load = name => import(pathToFileURL(join(fixture, "src", name)));
const nativeNow = Date.now, nativeTimeout = globalThis.setTimeout;
let clock = nativeNow();
Date.now = () => clock;
globalThis.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, [1000, 4000, 15000].includes(delay) ? 0 : delay, ...args);
const report = { at: new Date().toISOString(), fixture, level: "isolated", cases: [] };
async function test(name, task) {
  try { await task(); report.cases.push({ name, passed: true }); console.log("PASS " + name); }
  catch (error) { report.cases.push({ name, passed: false, error: String(error.message).slice(0, 700) }); console.log("FAIL " + name + ": " + String(error.message).slice(0, 500)); }
}
const config = await load("llm-settings-store.js");
const access = await load("access-control-store.js");
const base = { ...config.DEFAULT_LLM_SETTINGS, apiEndpoint: "https://fixture.invalid/v1/chat/completions", model: "fixture-model", memory: "", personality: "测试助手", expressionStyle: "简短回答", systemPrompt: "这是隔离验证。", botAliases: ["肥鱼"],
  searchEnabled: false, videoUnderstandingEnabled: false, proactiveChatEnabled: false, stickerLearningEnabled: false, knowledgeLearningEnabled: false, stickersEnabled: false, characterRecognitionEnabled: false };
config.writeLlmSettings(base); access.writeAccessControl({ groupIds: ["111", "222", "333"], userIds: [] });
const llm = await load("llm.js"), diagnostics = await load("model-diagnostics.js");
let fetchCount = 0, responder = () => Response.json({ choices: [{ finish_reason: "stop", message: { content: "隔离回复" } }] });
globalThis.fetch = async (url, options) => { assert.equal(new URL(url).hostname, "fixture.invalid", "Isolated fixture must never reach another host"); fetchCount++; return responder(options); };
const reply = (extra = {}) => { fetchCount = 0; clock += 11000; return llm.getLlmReply({ apiKey: "isolated-fixture-only-key", settings: base, userId: "fixture", senderQQId: "444", userMessage: "SYNTHETIC_SECRET_DO_NOT_SAVE", queued: true, ...extra }); };
const payload = (content = "隔离回复", finish = "stop") => Response.json({ choices: [{ finish_reason: finish, message: { content } }] });

await test("model success and correlated diagnostics", async () => { responder = () => payload(); assert.equal((await reply()).reply, "隔离回复"); const events = diagnostics.readModelDiagnostics(); assert.equal(new Set(events.slice(-3).map(x => x.id)).size, 1); });
await test("connection reset recovers with bounded retry", async () => { responder = () => { if (fetchCount < 3) throw new TypeError("synthetic reset", { cause: { code: "ECONNRESET" } }); return payload(); }; assert.ok((await reply()).reply); assert.equal(fetchCount, 3); });
await test("retry disabled makes only one connection", async () => { responder = () => { throw new TypeError("synthetic reset", { cause: { code: "ECONNRESET" } }); }; await assert.rejects(reply({ settings: { ...base, modelRetryEnabled: false } }), e => e.code === "CONNECTION" && /诊断号/u.test(e.message)); assert.equal(fetchCount, 1); });
await test("401 is not retried", async () => { responder = () => new Response("", { status: 401 }); await assert.rejects(reply(), e => e.code === "AUTH_REJECTED"); assert.equal(fetchCount, 1); });
await test("empty retry preserves later authentication failure", async () => { responder = () => fetchCount === 1 ? payload("") : new Response("", { status: 401 }); await assert.rejects(reply(), e => e.code === "AUTH_REJECTED" && !/无法读取/u.test(e.message)); assert.equal(fetchCount, 2); });
await test("empty choices has its own category", async () => { responder = () => Response.json({ choices: [] }); await assert.rejects(reply(), e => e.code === "EMPTY_CHOICES"); assert.equal(fetchCount, 2); });
await test("empty text can recover on one supplemental answer", async () => { responder = () => payload(fetchCount === 1 ? "" : "补试成功"); assert.equal((await reply()).reply, "补试成功"); assert.equal(fetchCount, 2); });
await test("disabled empty retry does not claim a retry", async () => { responder = () => payload(""); await assert.rejects(reply({ settings: { ...base, modelRetryEnabled: false } }), e => e.code === "EMPTY_TEXT" && !/补试后/u.test(e.message)); assert.equal(fetchCount, 1); });
await test("provider refusal is separate and not retried", async () => { responder = () => Response.json({ choices: [{ finish_reason: "content_filter", message: { refusal: "synthetic refusal", content: "" } }] }); await assert.rejects(reply(), e => e.code === "PROVIDER_REFUSAL"); assert.equal(fetchCount, 1); });
await test("invalid JSON is not reported as connection failure", async () => { responder = () => new Response("invalid-json"); await assert.rejects(reply(), e => e.code === "INVALID_JSON"); assert.equal(fetchCount, 2); });
await test("provider HTTP200 error payload is not success", async () => { responder = () => Response.json({ error: { message: "synthetic" } }); await assert.rejects(reply(), e => e.code === "UPSTREAM_PAYLOAD_ERROR"); });
await test("unresolved tool response is classified", async () => { responder = () => Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "missing", arguments: "{}" } }] } }] }); await assert.rejects(reply(), e => e.code === "TOOLS_UNFINISHED"); assert.equal(fetchCount, 2); });
await test("truncation retained text is labelled", async () => { responder = () => payload("部分文字", "length"); assert.match((await reply()).reply, /长度限制/u); assert.equal(fetchCount, 2); });
await test("timeout is not reported as generic connectivity", async () => { responder = () => { throw new DOMException("synthetic", "TimeoutError"); }; await assert.rejects(reply({ settings: { ...base, modelRetryEnabled: false } }), e => e.code === "TIMEOUT"); });
await test("diagnostics contain no prompt or credential", async () => { const text = await readFile(join(fixture, ".local", "model-diagnostics.json"), "utf8"); assert.ok(!/SYNTHETIC_SECRET_DO_NOT_SAVE|isolated-fixture-only-key|fixture\.invalid/u.test(text)); assert.ok(JSON.parse(text).length <= 80); });

const refs = await load("message-context.js"), context = await load("conversation-context.js");
const event = { user_id: "444", sender: { nickname: "测试成员" }, message: [{ type: "at", data: { qq: "999" } }, { type: "at", data: { qq: "555" } }, { type: "reply", data: { id: "-1" } }] };
await test("structured mentions and quoted author stay distinct", async () => { const info = await refs.resolveMessageContext({ event, groupId: "111", selfId: "999", lookup: () => ({ userId: "555", isBot: false, text: "他人的话" }), sendAction: async () => { throw new Error("must use cache"); } }); assert.equal(info.sender.id, "444"); assert.equal(info.mentions[0].isBot, true); assert.equal(info.reply.speakerId, "555"); assert.equal(info.reply.text, "他人的话"); });
await test("CQ string references are parsed", async () => { assert.deepEqual(refs.messageReferences("[CQ:at,qq=999] [CQ:reply,id=-1]"), { mentions: ["999"], replyIds: ["-1"] }); });
await test("cross-group quoted content is not imported", async () => { const info = await refs.resolveMessageContext({ event, groupId: "111", selfId: "999", sendAction: async () => ({ group_id: "222", time: Math.floor(clock / 1000), user_id: "555", message: [{ type: "text", data: { text: "other group secret" } }] }) }); assert.equal(info.reply.available, false); assert.ok(!JSON.stringify(info).includes("other group secret")); });
await test("sensitive quoted content is redacted", async () => { const info = await refs.resolveMessageContext({ event, groupId: "111", selfId: "999", lookup: () => ({ userId: "555", text: "api key SECRET" }), sendAction: async () => null }); assert.ok(!info.reply.text.includes("SECRET")); });
await test("quoting others cannot be accidental follow-up", async () => { context.rememberGroupLine({ groupId: "111", userId: "bot", text: "bot previous", messageId: "-100", isBot: true, targetUserId: "444" }); assert.equal(context.isPossibleBotFollowup({ groupId: "111", userId: "444", text: "你什么意思？", replyIds: ["-101"] }), false); });

const prefs = await load("sticker-preferences.js"), store = await load("sticker-store.js");
const reviewPayload = () => payload(JSON.stringify({ allowed: true, reusable: true, category: "ok", title: "测试猫猫", tags: ["开心", "接梗"], usage: "开心闲聊", avoid: "严肃求助" }));
let sticker;
await test("synthetic sticker creation uses mocked review only", async () => { responder = reviewPayload; const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer(); sticker = await store.addSticker({ title: "测试猫猫", tags: ["开心"], base64: png.toString("base64") }); assert.equal(sticker.reviewStatus, "approved"); assert.equal(sticker.needsDescription, false); });
await test("member dislike creates scoped temporary candidate", async () => { const rule = prefs.noteStickerFeedback("111", "肥鱼，别发测试猫猫的表情包了"); assert.equal(rule.value, "测试猫猫"); assert.equal(rule.status, "candidate"); assert.equal(prefs.stickerPolicyAllows(sticker, "111"), false); assert.equal(prefs.stickerPolicyAllows(sticker, "222"), true); });
await test("admin rejection removes temporary suppression", async () => { const state = prefs.readStickerPreferences("111"); prefs.saveStickerPreferences("111", state.rules.map(rule => ({ ...rule, status: "dismissed" })), state.revision); assert.equal(prefs.stickerPolicyAllows(sticker, "111"), true); assert.equal(prefs.noteStickerFeedback("111", "别发测试猫猫的表情包了").ignored, true); });
await test("confirmed specific sticker block survives reload", async () => { const state = prefs.readStickerPreferences("111"); prefs.saveStickerPreferences("111", [{ id: "12345678-1234-1234-1234-123456789012", kind: "sticker", value: sticker.id, status: "blocked" }], state.revision); assert.equal(store.stickerChoices("group:111").length, 0); assert.ok(store.stickerChoices("group:222").some(x => x.id === sticker.id)); });
await test("preference conflict rejects stale write", async () => { const state = prefs.readStickerPreferences("222"); prefs.noteStickerFeedback("222", "别发测试猫猫表情了"); assert.throws(() => prefs.saveStickerPreferences("222", [], state.revision), e => e.statusCode === 409); const current = prefs.readStickerPreferences("222"); prefs.saveStickerPreferences("222", [], current.revision); });
await test("recent three stickers suppress duplicates only in their group", async () => { prefs.recordStickerSent("222", sticker.id); assert.equal(prefs.stickerPolicyAllows(sticker, "222", { includeRecent: true }), false); assert.equal(prefs.stickerPolicyAllows(sticker, "333", { includeRecent: true }), true); clock += 10 * 60_000 + 1; assert.equal(prefs.stickerPolicyAllows(sticker, "222", { includeRecent: true }), true); });
await test("queued send rechecks a newly added block", async () => { let transmitted = false; const result = await store.sendLlmResult({ reply: "测试文字", stickerId: sticker.id }, { message_type: "group", group_id: "333" }, async (_action, _params, guard) => {
  const state = prefs.readStickerPreferences("333"); prefs.saveStickerPreferences("333", [{ id: "23456789-1234-1234-1234-123456789012", kind: "sticker", value: sticker.id, status: "blocked" }], state.revision); transmitted = guard(); return { cancelled: !transmitted };
}); assert.equal(transmitted, false); assert.equal(result, false); });

const mainFile = join(fixture, "src", "main.js"), mainSource = await readFile(mainFile, "utf8"), cut = mainSource.lastIndexOf("\nmain().catch(");
assert.ok(cut > 0); await writeFile(mainFile, mainSource.slice(0, cut) + "\nexport { handleMessage };\n");
const main = await load("main.js");
let messagesSent = [], sequence = 1000;
const fakeOneBot = async (action, params) => { if (action === "get_group_msg_history") return { messages: [] }; if (action === "get_msg") return { group_id: "111", time: Math.floor(clock / 1000), user_id: "555", message: [{ type: "text", data: { text: "群友原话" } }] }; if (action === "send_msg") { messagesSent.push(params); return { message_id: String(-++sequence) }; } throw new Error("Unexpected fake action: " + action); };
function inbound(message, group = "111") { clock += 11000; return { post_type: "message", message_type: "group", group_id: group, self_id: "999", user_id: "444", message_id: String(++sequence), sender: { nickname: "测试成员" }, message }; }
await test("real handler does not interrupt an @other message", async () => { messagesSent = []; fetchCount = 0; responder = () => payload(); await main.handleMessage(inbound([{ type: "at", data: { qq: "555" } }, { type: "text", data: { text: "你觉得肥鱼怎么样？" } }]), { sendMessage: fakeOneBot }, {}); assert.equal(messagesSent.length, 0); assert.equal(fetchCount, 0); });
await test("real handler injects structured quote context into model", async () => { messagesSent = []; responder = options => { const content = JSON.parse(options.body).messages.map(x => typeof x.content === "string" ? x.content : "").join("\n"); assert.match(content, /群友原话/u); assert.match(content, /speakerId/u); return payload("是另一位群友说的。"); }; await main.handleMessage(inbound([{ type: "at", data: { qq: "999" } }, { type: "reply", data: { id: "-555" } }, { type: "text", data: { text: "这是谁说的？" } }]), { sendMessage: fakeOneBot }, {}); assert.equal(messagesSent.length, 1); });

const kb = await load("knowledge-base.js"), learner = await load("knowledge-learning.js");
await test("quoted teaching reaches learner with a specific sticker link", async () => {
  config.writeLlmSettings({ ...base, knowledgeLearningEnabled: true });
  context.rememberGroupLine({ groupId: "222", userId: "bot", text: "[发送表情]", messageId: "-900", isBot: true, stickerId: sticker.id });
  responder = options => JSON.parse(options.body).messages[0].content.includes("你只提炼") ? payload(JSON.stringify([{ title: "蓝莓鱼干", tags: ["蓝莓鱼干"], content: "本群测试梗，表示晚安。", evidenceIds: [1] }])) : payload("收到。");
  await main.handleMessage(inbound([{ type: "at", data: { qq: "999" } }, { type: "reply", data: { id: "-900" } }, { type: "text", data: { text: "记住，蓝莓鱼干表示晚安。" } }], "222"), { sendMessage: fakeOneBot }, {});
  await learner.flushKnowledgeLearning("222"); const saved = kb.readScopedKnowledge("222").find(x => x.title === "蓝莓鱼干"); assert.ok(saved); assert.equal(saved.reviewStatus, "candidate"); assert.equal(saved.enabled, false); assert.equal(saved.relatedStickerIds[0], sticker.id); assert.equal(saved.evidenceRefs.length, 1);
});
await test("admin rejection cannot be auto-promoted by learning", async () => { let entries = kb.readScopedKnowledge("222"); kb.writeScopedKnowledge("222", entries.map(x => ({ ...x, enabled: false, reviewStatus: "rejected", reviewDecision: "rejected" })), kb.knowledgeRevision(entries)); const saved = kb.readScopedKnowledge("222")[0]; kb.mergeLearnedKnowledge("222", [{ ...saved, confirmed: true, evidenceCount: 2 }]); assert.equal(kb.readScopedKnowledge("222")[0].reviewStatus, "rejected"); assert.equal(kb.readScopedKnowledge("222")[0].enabled, false); });
await test("new correction does not overwrite approved knowledge", async () => { kb.mergeLearnedKnowledge("111", [{ title: "修正词", tags: ["修正词"], content: "旧的已确认含义。", evidenceCount: 2, confirmed: true }]); kb.mergeLearnedKnowledge("111", [{ title: "修正词", tags: ["修正词"], content: "不同的新含义。", evidenceCount: 2, confirmed: true }]); const entries = kb.readScopedKnowledge("111"); assert.equal(entries.length, 2); assert.ok(entries.find(x => x.content === "旧的已确认含义。").enabled); assert.equal(entries.find(x => x.supersedesId).reviewStatus, "candidate"); });
await test("knowledge scope and candidate search exclusion", async () => { assert.equal(kb.searchKnowledge("蓝莓鱼干", { groupId: "111" }).length, 0); assert.equal(kb.searchKnowledge("蓝莓鱼干", { groupId: "222" }).length, 0); assert.equal(kb.searchKnowledge("蓝莓鱼干").length, 0); });
await test("persisted learning status survives a fresh process", async () => { const url = pathToFileURL(join(fixture, "src", "knowledge-learning.js")).href; const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(url)}); console.log(JSON.stringify(m.getKnowledgeLearningStatus()));`], { encoding: "utf8", windowsHide: true }); assert.equal(child.status, 0); const state = JSON.parse(child.stdout).groups.find(x => x.groupId === "222"); assert.ok(state.lastSavedAt); assert.equal(state.bufferedMessages, 0); });
learner.clearKnowledgeLearning(); (await load("sticker-learning.js")).stopStickerLearning();

let server;
await test("management API authentication and scoped reads", async () => {
  const probe = createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); process.env.QQBOT_WEB_PORT = String(port);
  server = await (await load("web.js")).startManagementServer({ getOneBotStatus: () => ({ connected: true }) });
  const api = (path, method = "GET", body = null, cookie = "") => new Promise((resolve, reject) => { const req = httpRequest({ hostname: "127.0.0.1", port, path, method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) } }, res => { let raw = ""; res.on("data", chunk => raw += chunk); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(raw) })); }); req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined); });
  assert.equal((await api("/api/model-diagnostics")).status, 401);
  const setup = await api("/api/auth/setup", "POST", { password: "isolatedFixturePassword2026!" }); assert.equal(setup.status, 201); const cookie = setup.headers["set-cookie"][0].split(";")[0];
  assert.equal((await api("/api/model-diagnostics", "GET", null, cookie)).status, 200);
  assert.equal((await api("/api/sticker-preferences?groupId=9999", "GET", null, cookie)).status, 404);
  const group = await api("/api/knowledge?groupId=222", "GET", null, cookie); assert.equal(group.status, 200); assert.ok(group.data.entries.every(x => x.groupId === "222"));
  assert.equal((await api("/api/knowledge/learn", "POST", { groupId: "111" }, cookie)).status, 409);
});
if (server) await new Promise(resolve => server.close(resolve));
Date.now = nativeNow; globalThis.setTimeout = nativeTimeout;
report.passed = report.cases.filter(x => x.passed).length; report.failed = report.cases.length - report.passed;
await writeFile(join(root, ".local", "p0-check-metadata.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ fixture, passed: report.passed, failed: report.failed }));
if (report.failed) process.exitCode = 1;
