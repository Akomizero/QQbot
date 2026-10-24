import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(join(root, ".local"), { recursive: true });
const fixture = await mkdtemp(join(root, ".local", "p0-verification-"));
for (const folder of ["src", "public"]) {
  await mkdir(join(fixture, folder));
  for (const name of await readdir(join(root, folder))) if (/\.(js|html|css)$/u.test(name)) await copyFile(join(root, folder, name), join(fixture, folder, name));
}
// Stub only public-video acquisition; model and message handling stay the real source.
const videoFixturePath = join(fixture, "src", "bilibili-video.js");
await writeFile(videoFixturePath, (await readFile(videoFixturePath, "utf8")).replace("export async function readBilibiliVideo(", "async function unusedReadBilibiliVideo(") + '\nexport async function readBilibiliVideo(reference) { if (!String(reference).includes("BV1234567890")) throw new VideoReadError("隔离视频读取失败。"); return { title: "虚构测试视频", transcript: "虚构字幕。", frames: [], notes: [] }; }\n');
process.env.QQBOT_LLM_API_KEY = "isolated-fixture-only-key";
process.env.TAVILY_API_KEY = "isolated-fixture-only-search-key";
for (const variable of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "QQBOT_MODEL_PROXY_URL"]) delete process.env[variable];
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
  searchEnabled: false, videoUnderstandingEnabled: false, proactiveChatEnabled: false, stickerLearningEnabled: false, knowledgeLearningEnabled: false, memberImpressionsEnabled: false, memberImpressionsLearningEnabled: false, stickersEnabled: false, characterRecognitionEnabled: false };
config.writeLlmSettings(base); access.writeAccessControl({ groupIds: ["111", "222", "333"], userIds: [] });
const llm = await load("llm.js"), diagnostics = await load("model-diagnostics.js");
let fetchCount = 0, responder = () => Response.json({ choices: [{ finish_reason: "stop", message: { content: "隔离回复" } }] });
globalThis.fetch = async (url, options) => { assert.equal(new URL(url).hostname, "fixture.invalid", "Isolated fixture must never reach another host"); fetchCount++; return responder(options); };
const reply = (extra = {}) => { fetchCount = 0; clock += 11000; return llm.getLlmReply({ apiKey: "isolated-fixture-only-key", settings: base, userId: "fixture", senderQQId: "444", userMessage: "SYNTHETIC_SECRET_DO_NOT_SAVE", queued: true, ...extra }); };
const payload = (content = "隔离回复", finish = "stop") => Response.json({ choices: [{ finish_reason: finish, message: { content } }] });

const modelProxy = await load("network-proxy.js");
const localProxy = await load("local-model-proxy.js");
const localProxyFixture = { version: 1, corePath: join(root, "FlClashCore.exe"), port: 17890, params: { config: { "mixed-port": 17890, "bind-address": "127.0.0.1", "allow-lan": false, tun: { enable: false }, dns: { enable: false }, proxies: [{ name: "fixture" }], authentication: ["fixture:synthetic-secret"] } } };
await test("optional model proxy accepts authenticated loopback only configuration", async () => { assert.equal(localProxy.validateLocalModelProxyConfig(localProxyFixture), localProxyFixture); });
await test("model proxy refuses additional listeners and network exposure", async () => {
  for (const patch of [{ "allow-lan": true }, { "bind-address": "0.0.0.0" }, { tun: { enable: true } }, { dns: { enable: true } }, { "external-controller": "127.0.0.1:9999" }, { listeners: [{}] }, { authentication: [] }, { "proxy-providers": {} }]) {
    assert.throws(() => localProxy.validateLocalModelProxyConfig({ ...localProxyFixture, params: { config: { ...localProxyFixture.params.config, ...patch } } }));
  }
});
await test("missing optional model proxy config does not launch a process", async () => { const result = await localProxy.startConfiguredModelProxy({ configFile: join(fixture, ".local/missing-proxy.json") }); assert.equal(result.configured, false); await result.stop(); });
await test("model proxy override is selected without changing the general proxy", async () => {
  const url = pathToFileURL(join(fixture, "src/network-proxy.js")).href;
  const code = `const n=await import(${JSON.stringify(url)});const r=await n.createModelDispatcher("https://fixture.invalid");console.log(r.route);await r.dispatcher.close();`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, QQBOT_MODEL_PROXY_URL: "http://127.0.0.1:17890" }, encoding: "utf8", windowsHide: true });
  assert.equal(child.status, 0); assert.equal(child.stdout.trim(), "model_proxy");
});
const { createModelConnectionPool } = await load("model-connection-pool.js");
function fakeConnection() { return { route: "proxy_ipv4", dispatcher: { closed: false, destroyed: false, closes: 0, async close() { this.closed = true; this.closes++; }, async destroy() { this.destroyed = true; } } }; }
await test("healthy model pools are reused and separate origins stay isolated", async () => {
  let builds = 0; const pool = createModelConnectionPool({ create: async () => { builds++; return fakeConnection(); } });
  const a = await pool.acquire("https://first.example/chat"), b = await pool.acquire("https://first.example/other"), c = await pool.acquire("https://second.example/chat");
  assert.equal(a.entry, b.entry); assert.equal(b.reused, true); assert.notEqual(a.entry, c.entry); assert.equal(builds, 2); await pool.close();
});
await test("concurrent model pool setup is shared", async () => {
  let release, builds = 0; const pool = createModelConnectionPool({ create: async () => { builds++; await new Promise(resolve => { release = resolve; }); return fakeConnection(); } });
  const first = pool.acquire("https://first.example"), second = pool.acquire("https://first.example"); release();
  const [a, b] = await Promise.all([first, second]); assert.equal(a.entry, b.entry); assert.equal(builds, 1); await pool.close();
});
await test("failed model pool is replaced without invalidating a newer pool", async () => {
  const pool = createModelConnectionPool({ create: async () => fakeConnection() }); const old = (await pool.acquire("https://first.example")).entry;
  pool.invalidate(old); const fresh = (await pool.acquire("https://first.example")).entry; pool.invalidate(old);
  assert.notEqual(old, fresh); assert.equal((await pool.acquire("https://first.example")).entry, fresh); await pool.close();
});
await test("retiring model pools drains responses rather than destroying active sockets", async () => {
  const pool = createModelConnectionPool({ create: async () => fakeConnection() }); const { entry } = await pool.acquire("https://first.example");
  pool.invalidate(entry); assert.equal(entry.dispatcher.closed, true); assert.equal(entry.dispatcher.destroyed, false); await pool.close();
});
await test("model pool lifetime and entry count are bounded", async () => {
  let time = 0; const pool = createModelConnectionPool({ create: async () => fakeConnection(), now: () => time, ttlMs: 100, maxEntries: 2 });
  const first = (await pool.acquire("https://first.example")).entry; time = 101;
  const replacement = (await pool.acquire("https://first.example")).entry; assert.notEqual(first, replacement); assert.equal(first.dispatcher.closed, true);
  await pool.acquire("https://second.example"); await pool.acquire("https://third.example"); assert.equal(replacement.dispatcher.closed, true); await pool.close();
});
await test("a cancelled waiter cannot cancel another request's shared model setup", async () => {
  let release; const pool = createModelConnectionPool({ create: async (_, options) => { assert.equal(options.signal, undefined); await new Promise(resolve => { release = resolve; }); return fakeConnection(); } });
  const abort = new AbortController(); const first = pool.acquire("https://first.example", { signal: abort.signal }); const rejected = assert.rejects(first);
  const second = pool.acquire("https://first.example"); abort.abort(); await rejected; release(); assert.ok((await second).entry.dispatcher); await pool.close();
});
await test("closing model pools rejects further acquisitions", async () => {
  const pool = createModelConnectionPool({ create: async () => fakeConnection() }); const { entry } = await pool.acquire("https://first.example");
  await pool.close(); assert.equal(entry.dispatcher.closed, true); await assert.rejects(pool.acquire("https://first.example"));
});
await test("model proxy resolves IPv4 and rotates addresses within the existing retry budget", async () => {
  const resolver = async () => ["203.0.113.10", "2001:db8::1", "203.0.113.11", "203.0.113.10"];
  assert.equal(await modelProxy.resolveModelConnectAddress("https://model.example/v1/chat/completions", { resolver }), "203.0.113.10");
  assert.equal(await modelProxy.resolveModelConnectAddress("https://model.example/v1/chat/completions", { resolver, attempt: 2 }), "203.0.113.11");
});
await test("model proxy retains the endpoint TLS identity and certificate validation", async () => {
  const options = modelProxy.modelProxyOptions("http://127.0.0.1:7890", "https://model.example:8443/v1/chat/completions", "203.0.113.10");
  assert.equal(options.requestTls.servername, "model.example"); assert.equal(options.requestTls.rejectUnauthorized, true);
  assert.throws(() => modelProxy.modelProxyOptions("http://127.0.0.1:7890", "https://model.example", "not-an-ip"));
});
await test("model proxy CONNECT authority and Host both use the resolved address", async () => {
  let seen;
  const proxy = createServer(); proxy.on("connect", (request, socket) => { seen = { path: request.url, host: request.headers.host }; socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const origin = new URL(`http://127.0.0.1:${proxy.address().port}`);
  const options = modelProxy.modelProxyOptions(origin.href, "https://model.example:8443", "203.0.113.10");
  const pool = options.clientFactory(origin, {});
  try {
    const result = await pool.connect({ path: "model.example:8443", headers: { host: "model.example:8443" } }); result.socket?.destroy();
    assert.deepEqual(seen, { path: "203.0.113.10:8443", host: "203.0.113.10:8443" });
  } finally { await pool.destroy(); await new Promise(resolve => proxy.close(resolve)); }
});
await test("model DNS failure falls back to the configured proxy and honors cancellation", async () => {
  assert.equal(await modelProxy.resolveModelConnectAddress("https://model.example", { resolver: async () => { throw Error("DNS unavailable"); } }), null);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(modelProxy.resolveModelConnectAddress("https://model.example", { signal: controller.signal }));
  assert.equal(await modelProxy.resolveModelConnectAddress("http://127.0.0.1:3010", { resolver: () => { throw Error("Must not resolve"); } }), null);
});
await test("model transport keeps the healthy dispatcher for the next model step", async () => {
  const seen = []; responder = options => { seen.push(options.dispatcher); return payload(); };
  await reply(); await reply(); assert.equal(seen[0], seen[1]);
  const last = diagnostics.readModelDiagnostics().filter(e => e.kind === "start").at(-1);
  if (seen[0]) assert.equal(last.reused, 1);
});
await test("model transport replaces the failed dispatcher within the two request limit", async () => {
  const seen = []; responder = options => { seen.push(options.dispatcher); if (fetchCount === 1) throw new TypeError("synthetic reset", { cause: { code: "ECONNRESET" } }); return payload(); };
  assert.ok((await reply()).reply); assert.equal(fetchCount, 2); if (seen[0]) assert.notEqual(seen[0], seen[1]);
});

await test("model success and correlated diagnostics", async () => { responder = () => payload(); assert.equal((await reply()).reply, "隔离回复"); const events = diagnostics.readModelDiagnostics(); assert.equal(new Set(events.slice(-3).map(x => x.id)).size, 1); });
await test("connection reset recovers with one retry", async () => { responder = () => { if (fetchCount < 2) throw new TypeError("synthetic reset", { cause: { code: "ECONNRESET" } }); return payload(); }; assert.ok((await reply()).reply); assert.equal(fetchCount, 2); });
await test("persistent connection failure stops after two HTTP attempts", async () => { responder = () => { throw new TypeError("synthetic reset", { cause: { code: "ECONNRESET" } }); }; await assert.rejects(reply(), e => e.code === "CONNECTION"); assert.equal(fetchCount, 2); const events = diagnostics.readModelDiagnostics(); const id = events.at(-1).id; assert.deepEqual(events.filter(x => x.id === id && x.kind === "start").map(x => x.attempt), [1, 2]); });
await test("persistent HTTP503 stops after two requests", async () => { responder = () => new Response("", { status: 503 }); await assert.rejects(reply(), e => e.code === "UPSTREAM_HTTP"); assert.equal(fetchCount, 2); });
await test("connection failure then empty text cannot add a third request", async () => { responder = () => { if (fetchCount === 1) throw new TypeError("synthetic reset", { cause: { code: "ECONNRESET" } }); return payload(""); }; await assert.rejects(reply(), e => e.code === "EMPTY_TEXT"); assert.equal(fetchCount, 2); });
await test("empty text then reset shares the same two request budget", async () => { responder = () => { if (fetchCount === 1) return payload(""); throw new TypeError("synthetic reset", { cause: { code: "ECONNRESET" } }); }; await assert.rejects(reply(), e => e.code === "CONNECTION"); assert.equal(fetchCount, 2); });
await test("HTTP503 then empty text cannot replenish the budget", async () => { responder = () => fetchCount === 1 ? new Response("", { status: 503 }) : payload(""); await assert.rejects(reply(), e => e.code === "EMPTY_TEXT"); assert.equal(fetchCount, 2); });
await test("retries share one deadline signal", async () => { const signals = []; responder = options => { signals.push(options.signal); return fetchCount === 1 ? new Response("", { status: 503 }) : payload(); }; assert.ok((await reply()).reply); assert.equal(signals.length, 2); assert.equal(signals[0], signals[1]); });
await test("HTTP503 retry switch disabled makes one request", async () => { responder = () => new Response("", { status: 503 }); await assert.rejects(reply({ settings: { ...base, modelRetryEnabled: false } }), e => e.code === "UPSTREAM_HTTP"); assert.equal(fetchCount, 1); });
await test("retry disabled makes only one connection", async () => { responder = () => { throw new TypeError("synthetic reset", { cause: { code: "ECONNRESET" } }); }; await assert.rejects(reply({ settings: { ...base, modelRetryEnabled: false } }), e => e.code === "CONNECTION" && /诊断号/u.test(e.message)); assert.equal(fetchCount, 1); });
await test("401 is not retried", async () => { responder = () => new Response("", { status: 401 }); await assert.rejects(reply(), e => e.code === "AUTH_REJECTED"); assert.equal(fetchCount, 1); });
await test("empty retry preserves later authentication failure", async () => { responder = () => fetchCount === 1 ? payload("") : new Response("", { status: 401 }); await assert.rejects(reply(), e => e.code === "AUTH_REJECTED" && !/无法读取/u.test(e.message)); assert.equal(fetchCount, 2); });
await test("empty choices has its own category", async () => { responder = () => Response.json({ choices: [] }); await assert.rejects(reply(), e => e.code === "EMPTY_CHOICES"); assert.equal(fetchCount, 2); });
await test("empty text can recover on one supplemental answer", async () => { responder = () => payload(fetchCount === 1 ? "" : "补试成功"); assert.equal((await reply()).reply, "补试成功"); assert.equal(fetchCount, 2); });
await test("disabled empty retry does not claim a retry", async () => { responder = () => payload(""); await assert.rejects(reply({ settings: { ...base, modelRetryEnabled: false } }), e => e.code === "EMPTY_TEXT" && !/补试后/u.test(e.message)); assert.equal(fetchCount, 1); });
await test("provider refusal is separate and not retried", async () => { responder = () => Response.json({ choices: [{ finish_reason: "content_filter", message: { refusal: "synthetic refusal", content: "" } }] }); await assert.rejects(reply(), e => e.code === "PROVIDER_REFUSAL"); assert.equal(fetchCount, 1); });
await test("invalid JSON is not reported as connection failure", async () => { responder = () => new Response("invalid-json"); await assert.rejects(reply(), e => e.code === "INVALID_JSON"); assert.equal(fetchCount, 2); });
await test("provider HTTP200 error payload is not success", async () => { responder = () => Response.json({ error: { message: "synthetic" } }); await assert.rejects(reply(), e => e.code === "UPSTREAM_PAYLOAD_ERROR"); });
await test("unresolved tool responses respect tool rounds, final-answer retry budget and error classification", async () => {
  assert.deepEqual(llm.completionBudget,{toolRounds:3,attemptsPerStep:2});
  for(const retryEnabled of [true,false]){
    const requests=[];
    responder=options=>{requests.push(JSON.parse(options.body));return Response.json({choices:[{finish_reason:"tool_calls",message:{content:null,tool_calls:[{id:"t"+requests.length,type:"function",function:{name:"missing",arguments:"{}"}}]}}]});};
    await assert.rejects(reply({groupId:'111',settings:{...base,modelRetryEnabled:retryEnabled}}),e=>e.code==="TOOLS_UNFINISHED");
    const {toolRounds,attemptsPerStep}=llm.completionBudget;
    assert.equal(fetchCount,toolRounds+(retryEnabled?attemptsPerStep:1));
    assert(requests.slice(0,toolRounds).every(r=>r.tools?.length>0));
    assert(requests.slice(toolRounds).every(r=>!r.tools?.length));
    assert.deepEqual(requests.slice(0,toolRounds).map(r=>r.messages.filter(m=>m.role==='tool').length),[0,1,2]);
    assert(requests.slice(toolRounds).every(r=>r.messages.filter(m=>m.role==='tool').length===toolRounds),'final retries cannot execute another tool round');
    const events=diagnostics.readModelDiagnostics(),id=events.at(-1).id;
    assert.equal(events.filter(e=>e.id===id&&e.kind==='retry'&&e.code==='TOOLS_UNFINISHED').length,retryEnabled?1:0);
  }
});
await test("truncation retained text is labelled", async () => { responder = () => payload("部分文字", "length"); assert.match((await reply()).reply, /长度限制/u); assert.equal(fetchCount, 2); });
await test("timeout is not reported as generic connectivity", async () => { responder = () => { throw new DOMException("synthetic", "TimeoutError"); }; await assert.rejects(reply({ settings: { ...base, modelRetryEnabled: false } }), e => e.code === "TIMEOUT"); });
await test("diagnostics contain no prompt or credential", async () => { const text = await readFile(join(fixture, ".local", "model-diagnostics.json"), "utf8"); assert.ok(!/SYNTHETIC_SECRET_DO_NOT_SAVE|isolated-fixture-only-key|fixture\.invalid/u.test(text)); assert.ok(JSON.parse(text).length <= 80); });
await test("video material success then model failure identifies the right stage", async () => { responder = () => { throw new TypeError("synthetic reset", { cause: { code: "ECONNRESET" } }); }; await assert.rejects(reply({ userMessage: "看看 BV1234567890", settings: { ...base, videoUnderstandingEnabled: true } }), e => e.code === "CONNECTION" && /视频素材已经读到/u.test(e.message)); assert.equal(fetchCount, 2); });
await test("video acquisition failure does not claim model connectivity failed", async () => { responder = () => { throw Error("Model must not be called"); }; const result = await reply({ userMessage: "看看 BV0000000000", settings: { ...base, videoUnderstandingEnabled: true } }); assert.equal(result.status, "video-error"); assert.equal(fetchCount, 0); assert.ok(!/视频素材已经读到/u.test(result.reply)); });

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
await test("postposed dislike creates a quoted sticker candidate", async () => { const rule = prefs.noteStickerFeedback("444", "这个表情我不想再看到", sticker.id); assert.equal(rule.kind, "sticker"); assert.equal(rule.value, sticker.id); assert.equal(rule.status, "candidate"); assert.equal(prefs.stickerPolicyAllows(sticker, "444"), false); });
await test("postposed named dislike creates a term candidate", async () => { const rule = prefs.noteStickerFeedback("444", "测试猫猫的表情我不喜欢"); assert.equal(rule.kind, "term"); assert.equal(rule.value, "测试猫猫"); });
await test("both word orders and negative false positives share one parser", async () => { for (const text of ["这个表情我不想再看到", "这张表情别再发了", "测试猫猫表情我不喜欢", "不用发测试猫猫的表情了", "我不想再看测试猫猫表情"]) assert.ok(prefs.parseStickerRejection(text), text); for (const text of ["我不是不喜欢这个表情", "我不想写作业，发个表情吧", "不要钱的表情真好看", "不要禁用测试猫猫的表情", "这个表情好可爱"]) assert.equal(prefs.parseStickerRejection(text), null, text); });
await test("ambiguous sticker rejection does not invent a persistent target", async () => { assert.equal(prefs.noteStickerFeedback("666", "这个表情我不想再看到"), null); assert.equal(prefs.readStickerPreferences("666").rules.length, 0); });
await test("postposed rejection disables the model sticker tool for this reply", async () => { let tools; responder = options => { tools = JSON.parse(options.body).tools ?? []; return payload(); }; await reply({ groupId: "555", userMessage: "这个表情我不想再看到", settings: { ...base, stickersEnabled: true } }); assert.ok(!tools.some(x => x.function?.name === "select_sticker")); });
await test("a positive request still exposes an approved sticker", async () => { let tools; responder = options => { tools = JSON.parse(options.body).tools ?? []; return payload(); }; await reply({ groupId: "555", userMessage: "发个测试猫猫的表情", settings: { ...base, stickersEnabled: true } }); assert.ok(tools.some(x => x.function?.name === "select_sticker")); });
await test("member dislike creates scoped temporary candidate", async () => { const rule = prefs.noteStickerFeedback("111", "肥鱼，别发测试猫猫的表情包了"); assert.equal(rule.value, "测试猫猫"); assert.equal(rule.status, "candidate"); assert.equal(prefs.stickerPolicyAllows(sticker, "111"), false); assert.equal(prefs.stickerPolicyAllows(sticker, "222"), true); });
await test("admin rejection removes temporary suppression", async () => { const state = prefs.readStickerPreferences("111"); prefs.saveStickerPreferences("111", state.rules.map(rule => ({ ...rule, status: "dismissed" })), state.revision); assert.equal(prefs.stickerPolicyAllows(sticker, "111"), true); assert.equal(prefs.noteStickerFeedback("111", "别发测试猫猫的表情包了").ignored, true); });
await test("confirmed specific sticker block survives reload", async () => { const state = prefs.readStickerPreferences("111"); prefs.saveStickerPreferences("111", [{ id: "12345678-1234-1234-1234-123456789012", kind: "sticker", value: sticker.id, status: "blocked" }], state.revision); assert.equal(store.stickerChoices("group:111").length, 0); assert.ok(store.stickerChoices("group:222").some(x => x.id === sticker.id)); });
await test("preference conflict rejects stale write", async () => { const state = prefs.readStickerPreferences("222"); prefs.noteStickerFeedback("222", "别发测试猫猫表情了"); assert.throws(() => prefs.saveStickerPreferences("222", [], state.revision), e => e.statusCode === 409); const current = prefs.readStickerPreferences("222"); prefs.saveStickerPreferences("222", [], current.revision); });
await test("recent stickers stay group scoped and the last identical image stays suppressed after ten minutes", async () => { prefs.recordStickerSent("222", sticker.id); assert.equal(prefs.stickerPolicyAllows(sticker, "222", { includeRecent: true }), false); assert.equal(prefs.stickerPolicyAllows(sticker, "333", { includeRecent: true }), true); clock += 10 * 60_000 + 1; assert.equal(prefs.stickerPolicyAllows(sticker, "222", { includeRecent: true }), false); });
await test("queued send rechecks a newly added block", async () => { let transmitted = false; const result = await store.sendLlmResult({ reply: "测试文字", stickerId: sticker.id }, { message_type: "group", group_id: "333" }, async (_action, _params, guard) => {
  const state = prefs.readStickerPreferences("333"); prefs.saveStickerPreferences("333", [{ id: "23456789-1234-1234-1234-123456789012", kind: "sticker", value: sticker.id, status: "blocked" }], state.revision); transmitted = guard(); return { cancelled: !transmitted };
}); assert.equal(transmitted, false); assert.equal(result, false); });

const mainFile = join(fixture, "src", "main.js"), mainSource = await readFile(mainFile, "utf8"), cut = mainSource.lastIndexOf("\nmain().catch(");
assert.ok(cut > 0); await writeFile(mainFile, mainSource.slice(0, cut) + "\nexport { handleMessage };\n");
const main = await load("main.js");
const recentImages = await load("recent-group-images.js");
const imageSegment = { type: "image", data: { file: "ABCDEF0123456789ABCDEF0123456789.jpg", sub_type: 0 } };
const imageEvent = (groupId = "111", userId = "444", at = clock, messageId = "-321") => ({ group_id: groupId, user_id: userId, message_id: messageId, time: Math.floor(at / 1000), message: [imageSegment] });
const imageQuestion = (group = "111", user = "444") => ({ event: { user_id: user, message_id: "-322", message: [] }, groupId: group, selfId: "999", text: "如何评价", sendAction: async () => ({ messages: [] }) });
await test("recent images associate with the same sender in every group", async () => {
  recentImages.clearRecentGroupImages();
  for (const groupId of ["111", "222", "333"]) {
    recentImages.rememberGroupImages({ event: imageEvent(groupId), groupId, selfId: "999" });
    const found = await recentImages.resolveRecentGroupImages(imageQuestion(groupId)); assert.equal(found.messageId, "-321"); assert.equal(found.groupId, groupId);
  }
});
await test("recent image references do not cross groups or users", async () => {
  recentImages.clearRecentGroupImages(); recentImages.rememberGroupImages({ event: imageEvent(), groupId: "111", selfId: "999" });
  assert.equal(await recentImages.resolveRecentGroupImages(imageQuestion("222")), null);
  assert.equal(await recentImages.resolveRecentGroupImages(imageQuestion("111", "555")), null);
});
await test("expired image references and pre-persona history are not selected", async () => {
  const question = imageQuestion(); question.now = clock + 181000;
  assert.equal(await recentImages.resolveRecentGroupImages(question), null);
  recentImages.rememberGroupImages({ event: imageEvent(), groupId: "111", selfId: "999" });
  assert.equal(await recentImages.resolveRecentGroupImages({ ...imageQuestion(), since: clock + 1 }), null);
});
await test("ordinary text and messages addressed to others do not inherit images", async () => {
  recentImages.clearRecentGroupImages(); recentImages.rememberGroupImages({ event: imageEvent(), groupId: "111", selfId: "999" });
  assert.equal(await recentImages.resolveRecentGroupImages({ ...imageQuestion(), text: "今天天气如何" }), null);
  const question = imageQuestion(); question.event.message = [{ type: "at", data: { qq: "555" } }];
  assert.equal(await recentImages.resolveRecentGroupImages(question), null);
});
await test("images addressed to another member are not cached for bot", async () => {
  recentImages.clearRecentGroupImages(); const event = imageEvent(); event.message.push({ type: "at", data: { qq: "555" } });
  recentImages.rememberGroupImages({ event, groupId: "111", selfId: "999" });
  assert.equal(await recentImages.resolveRecentGroupImages(imageQuestion()), null);
});
await test("recent same-group history recovers image association after restart", async () => {
  recentImages.clearRecentGroupImages();
  const found = await recentImages.resolveRecentGroupImages({ ...imageQuestion(), sendAction: async () => ({ messages: [imageEvent()] }) });
  assert.equal(found.messageId, "-321"); assert.ok(!JSON.stringify(found).includes("base64"));
});
await test("explicit quoted image wins while cross-group quotes never substitute a recent image", async () => {
  const question = imageQuestion(); question.event.message = [{ type: "reply", data: { id: "-9991" } }];
  const found = await recentImages.resolveRecentGroupImages({ ...question, sendAction: async () => imageEvent("111", "555", clock, "-9991") });
  assert.equal(found.userId, "555"); assert.equal(found.messageId, "-9991");
  assert.equal(await recentImages.resolveRecentGroupImages({ ...question, sendAction: async () => imageEvent("222", "555", clock, "-9991") }), null);
});
await test("invalid platform image identifiers never enter recent references", async () => {
  recentImages.clearRecentGroupImages(); const event = imageEvent(); event.message = [{ type: "image", data: { file: "C:/private/file.jpg" } }];
  recentImages.rememberGroupImages({ event, groupId: "111", selfId: "999" });
  assert.equal(await recentImages.resolveRecentGroupImages(imageQuestion()), null);
});
await test("queued image references recheck expiry and changed context cutoff", async () => {
  recentImages.clearRecentGroupImages(); recentImages.rememberGroupImages({ event: imageEvent(), groupId: "111", selfId: "999" });
  const reference = await recentImages.resolveRecentGroupImages(imageQuestion());
  assert.equal(recentImages.canUseRecentGroupImages(reference, { groupId: "111" }), true);
  assert.equal(recentImages.canUseRecentGroupImages(reference, { groupId: "222" }), false);
  assert.equal(recentImages.canUseRecentGroupImages(reference, { groupId: "111", since: clock + 1 }), false);
  assert.equal(recentImages.canUseRecentGroupImages(reference, { groupId: "111", now: clock + 181000 }), false);
});
let messagesSent = [], sequence = 1000;
const fakeOneBot = async (action, params) => { if (action === "get_group_msg_history") return { messages: [] }; if (action === "get_msg") return { group_id: "111", time: Math.floor(clock / 1000), user_id: "555", message: [{ type: "text", data: { text: "群友原话" } }] }; if (action === "send_msg") { messagesSent.push(params); return { message_id: String(-++sequence) }; } throw new Error("Unexpected fake action: " + action); };
function inbound(message, group = "111") { clock += 11000; return { post_type: "message", message_type: "group", group_id: group, self_id: "999", user_id: "444", message_id: String(++sequence), sender: { nickname: "测试成员" }, message }; }
await test("real handler does not interrupt an @other message", async () => { messagesSent = []; fetchCount = 0; responder = () => payload(); await main.handleMessage(inbound([{ type: "at", data: { qq: "555" } }, { type: "text", data: { text: "你觉得肥鱼怎么样？" } }]), { sendMessage: fakeOneBot }, {}); assert.equal(messagesSent.length, 0); assert.equal(fetchCount, 0); });
await test("real handler injects structured quote context into model", async () => { messagesSent = []; responder = options => { const content = JSON.parse(options.body).messages.map(x => typeof x.content === "string" ? x.content : "").join("\n"); assert.match(content, /群友原话/u); assert.match(content, /speakerId/u); return payload("是另一位群友说的。"); }; await main.handleMessage(inbound([{ type: "at", data: { qq: "999" } }, { type: "reply", data: { id: "-555" } }, { type: "text", data: { text: "这是谁说的？" } }]), { sendMessage: fakeOneBot }, {}); assert.equal(messagesSent.length, 1); });
await test("a successful automatic model retry actually sends its reply exactly once", async () => {
  messagesSent = []; fetchCount = 0; responder = () => { if (fetchCount === 1) throw new TypeError("synthetic reset", { cause: { code: "ECONNRESET" } }); return payload("补试成功后的实际回复"); };
  await main.handleMessage(inbound([{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "连接恢复后回复我" } }]), { sendMessage: fakeOneBot }, {});
  assert.equal(fetchCount, 2); assert.equal(messagesSent.length, 1); assert.ok(JSON.stringify(messagesSent[0]).includes("补试成功后的实际回复"));
  assert.ok(!JSON.stringify(messagesSent[0]).includes("暂时无法连接"));
});
const syntheticImage = (await sharp({ create: { width: 8, height: 8, channels: 3, background: "green" } }).png().toBuffer()).toString("base64");
await test("real handler attaches a separately sent image to the later mentioned question", async () => {
  config.writeLlmSettings(base); recentImages.clearRecentGroupImages(); context.clearGroupConversations(); messagesSent = []; fetchCount = 0; let imageReads = 0;
  const imageOneBot = (action, params) => action === "get_image" ? (imageReads++, Promise.resolve({ base64: syntheticImage })) : fakeOneBot(action, params);
  await main.handleMessage(inbound([imageSegment]), { sendMessage: imageOneBot }, {});
  assert.equal(imageReads, 0); assert.equal(fetchCount, 0);
  responder = options => { const messages = JSON.parse(options.body).messages; assert.ok(messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url"))); assert.match(JSON.stringify(messages), /这次请bot看的图片/u); return payload("这张表情是在调皮地接话。"); };
  await main.handleMessage(inbound([{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "如何评价" } }]), { sendMessage: imageOneBot }, {});
  assert.equal(imageReads, 1,"image download count"); assert.equal(messagesSent.length, 1,"reply transport count"); assert.match(JSON.stringify(messagesSent[0]), /调皮地接话/u);
});
await test("same member image follow-up without @ still carries the image", async () => {
  messagesSent = []; let imageReads = 0;
  const imageOneBot = (action, params) => action === "get_image" ? (imageReads++, Promise.resolve({ base64: syntheticImage })) : fakeOneBot(action, params);
  responder = options => { assert.ok(JSON.parse(options.body).messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url"))); return payload("是在这个表情里装可爱呀。"); };
  await main.handleMessage(inbound([{ type: "text", data: { text: "这个图片" } }]), { sendMessage: imageOneBot }, {});
  assert.equal(imageReads, 1,"image download count"); assert.equal(messagesSent.length, 1,"reply transport count");
});
await test("image-only reply to bot during an active turn is understood as addressed to bot", async () => {
  messagesSent = []; let imageReads = 0;
  const imageOneBot = (action, params) => action === "get_image" ? (imageReads++, Promise.resolve({ base64: syntheticImage })) : fakeOneBot(action, params);
  responder = () => payload("这张也挺会接梗。");
  await main.handleMessage(inbound([imageSegment]), { sendMessage: imageOneBot }, {});
  assert.equal(imageReads, 1,"image download count"); assert.equal(messagesSent.length, 1,"reply transport count");
});
await test("disabled vision never reads an inherited image", async () => {
  config.writeLlmSettings({ ...base, visionEnabled: false }); messagesSent = []; let imageReads = 0;
  responder = options => { assert.ok(!JSON.parse(options.body).messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url"))); return payload("现在不能看图。"); };
  await main.handleMessage(inbound([{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "这个图片" } }]), { sendMessage: (action, params) => action === "get_image" ? (imageReads++, Promise.resolve({ base64: syntheticImage })) : fakeOneBot(action, params) }, {});
  assert.equal(imageReads, 0); config.writeLlmSettings(base); recentImages.clearRecentGroupImages(); context.clearGroupConversations();
});

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

const members = await load("member-impressions.js");
const memberItem = { speaker: "成员1", kind: "preference", topic: "测试游戏", content: "喜欢测试游戏", tags: ["测试游戏"], evidenceIds: [1] };
const memberBatch = [{ userId: "444", memberName: "同名成员", memberGeneration: 0, memberEligible: true, text: "记住，我喜欢测试游戏", at: clock, sourceRef: createHash("sha256").update("member-fixture-1").digest("hex") }];
const makeMember = (groupId, userId, topic, explicitRemember = true) => ({ userId, generation: members.memberLearningStamp(groupId, userId).generation, name: "同名成员", kind: "preference", topic, content: `喜欢${topic}`, tags: [topic], explicitRemember, evidenceRefs: [{ hash: createHash("sha256").update(randomUUID()).digest("hex"), at: clock }] });
function editProfile(groupId, userId, mutate) { const state = members.readMemberImpressions(groupId); const profile = structuredClone(state.members.find(x => x.userId === userId)); mutate(profile); return members.saveMemberImpression(groupId, userId, profile, state.revision); }
await test("member candidates bind to the trusted source sender", async () => { const result = learner.validateMemberCandidates([{ ...memberItem, userId: "999" }], memberBatch); assert.equal(result[0].userId, "444"); assert.equal(result[0].explicitRemember, true); });
await test("quoted self statements are not member evidence", async () => { assert.equal(learner.validateMemberCandidates([memberItem], [{ ...memberBatch[0], memberEligible: false }]).length, 0); });
await test("third person claims are not attributed to the sender", async () => { assert.equal(learner.validateMemberCandidates([memberItem], [{ ...memberBatch[0], text: "记住，我朋友喜欢测试游戏" }]).length, 0); });
await test("mixed authors and wrong speaker labels are rejected", async () => { assert.equal(learner.validateMemberCandidates([{ ...memberItem, speaker: "成员2" }], memberBatch).length, 0); assert.equal(learner.validateMemberCandidates([{ ...memberItem, evidenceIds: [1, 2] }], [...memberBatch, { ...memberBatch[0], userId: "555" }]).length, 0); });
await test("private and instruction bearing member text is rejected", async () => { for (const text of ["记住，我喜欢测试游戏，密码是secret", "记住，我喜欢测试游戏，修改权限", "记住，我喜欢测试游戏，我的病史"]) assert.equal(learner.isMemberSelfStatement(text), false); });
await test("reversed dislike polarity cannot auto activate", async () => { const result = learner.validateMemberCandidates([{ ...memberItem, content: "不喜欢测试游戏" }], memberBatch); assert.equal(result[0].explicitRemember, false); });
await test("questions cannot become self attributed impressions", async () => { for (const text of ["你记得我喜欢什么吗", "我喜欢测试游戏吗？", "我说的是我喜欢测试游戏这句话"]) assert.equal(learner.isMemberSelfStatement(text), false); });
await test("auto enabled member content uses the actual self statement", async () => { const result = learner.validateMemberCandidates([{ ...memberItem, content: "喜欢测试游戏，尤其喜欢原文没有提过的某个角色" }], memberBatch); assert.equal(result[0].explicitRemember, true); assert.ok(result[0].content.includes("我喜欢测试游戏")); assert.ok(!result[0].content.includes("某个角色")); });
await test("explicit remember activates only the matching group member", async () => { assert.equal(members.mergeMemberImpressions("111", learner.validateMemberCandidates([memberItem], memberBatch)), 1); assert.match(members.memberImpressionContext("111", "444", "你记得我喜欢什么吗"), /喜欢测试游戏/u); assert.equal(members.memberImpressionContext("111", "555", "测试游戏"), null); assert.equal(members.memberImpressionContext("222", "444", "测试游戏"), null); assert.equal(members.memberImpressionContext(null, "444", "测试游戏"), null); });
await test("same display names never merge different QQ members", async () => { members.mergeMemberImpressions("111", [makeMember("111", "555", "测试音乐")]); assert.equal(members.readMemberImpressions("111").members.length, 2); assert.match(members.memberImpressionContext("111", "555", "测试音乐"), /喜欢测试音乐/u); assert.ok(!members.memberImpressionContext("111", "555", "我的兴趣").includes("测试游戏")); });
await test("member impressions persist in a fresh process", async () => { const url = pathToFileURL(join(fixture, "src/member-impressions.js")).href; const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const m=await import(${JSON.stringify(url)});console.log(m.memberImpressionContext("111","444","测试游戏"));`], { encoding: "utf8", windowsHide: true }); assert.equal(child.status, 0); assert.match(child.stdout, /喜欢测试游戏/u); });
await test("ordinary self statements wait for administrator review", async () => { members.mergeMemberImpressions("222", [makeMember("222", "444", "测试动画", false)]); assert.equal(members.memberImpressionContext("222", "444", "测试动画"), null); const state = editProfile("222", "444", profile => { profile.facts[0].reviewStatus = "approved"; profile.facts[0].enabled = true; }); assert.match(members.memberImpressionContext("222", "444", "测试动画"), /喜欢测试动画/u); assert.ok(state.revision); });
await test("member revision conflicts do not overwrite newer data", async () => { const state = members.readMemberImpressions("222"), profile = structuredClone(state.members[0]); editProfile("222", "444", value => { value.name = "新显示名"; }); assert.throws(() => members.saveMemberImpression("222", "444", profile, state.revision), error => error.statusCode === 409); });
await test("deleting a fact blocks relearning its topic", async () => { editProfile("111", "555", profile => { profile.facts = []; }); assert.equal(members.memberImpressionContext("111", "555", "测试音乐"), null); assert.equal(members.mergeMemberImpressions("111", [makeMember("111", "555", "测试音乐")]), 0); });
await test("pausing member learning preserves approved recall", async () => { editProfile("222", "444", profile => { profile.learningEnabled = false; }); assert.match(members.memberImpressionContext("222", "444", "测试动画"), /测试动画/u); assert.equal(members.mergeMemberImpressions("222", [makeMember("222", "444", "测试新主题")]), 0); });
await test("disabling a member prevents recall", async () => { editProfile("222", "444", profile => { profile.enabled = false; }); assert.equal(members.memberImpressionContext("222", "444", "测试动画"), null); });
await test("LLM receives only explicitly reply-authorized current-group current-sender impressions", async () => { config.writeLlmSettings({...config.readLlmSettings(),memberImpressionsEnabled:true}); let prompt; responder = options => { prompt = JSON.stringify(JSON.parse(options.body).messages); return payload(); }; await reply({ groupId: "111", senderQQId: "444", userMessage: "测试游戏", settings: { ...base, memberImpressionsEnabled: true } }); assert.ok(!prompt.includes('喜欢测试游戏'));editProfile('111','444',profile=>{for(const fact of profile.facts)fact.replyAllowed=true;});await reply({ groupId: "111", senderQQId: "444", userMessage: "测试游戏", settings: { ...base, memberImpressionsEnabled: true } });assert.match(prompt, /喜欢测试游戏/u);await reply({ groupId: "111", senderQQId: "555", userMessage: "测试游戏", settings: { ...base, memberImpressionsEnabled: true } }); assert.ok(!prompt.includes("喜欢测试游戏"));config.writeLlmSettings({...config.readLlmSettings(),memberImpressionsEnabled:false}); });
await test("forget prevents an in flight extraction from restoring facts", async () => { const candidate = makeMember("111", "444", "旧任务主题"); members.forgetMemberImpression("111", "444"); assert.equal(members.memberImpressionContext("111", "444", "测试游戏"), null); assert.equal(members.mergeMemberImpressions("111", [candidate]), 0); assert.equal(members.memberLearningStamp("111", "444").learningEnabled, false); members.resumeMemberImpression("111", "444"); assert.equal(members.mergeMemberImpressions("111", [candidate]), 0); assert.equal(members.readMemberImpressions("111").members.find(x => x.userId === "444").facts.length, 0); clock += 1000; });
await test("forgetting one group preserves the other group", async () => { const profile = members.readMemberImpressions("222").members.find(x => x.userId === "444"); assert.equal(profile.facts.length, 1); });
await test("member forget cannot be triggered by a negated command", async () => { assert.equal(members.memberMemoryCommand("不要忘记我"), null); assert.equal(members.memberMemoryCommand("肥鱼，忘记我"), "forget"); assert.equal(members.memberMemoryCommand("继续记住我"), "resume"); });
await test("forgotten context cannot be imported again from QQ history", async () => { context.clearGroupConversations("111"); await context.warmGroupContext({ groupId: "111", selfId: "999", sendAction: async () => ({ messages: [{ group_id: "111", user_id: "444", message_id: "-812", time: Math.floor((clock - 2000) / 1000), message: [{ type: "text", data: { text: "喜欢测试游戏" } }] }] }) }); assert.ok(!JSON.stringify(context.recentGroupContext("111")).includes("喜欢测试游戏")); });
await test("member learning shares one knowledge extraction model call", async () => { config.writeLlmSettings({ ...base, knowledgeEnabled: false, memberImpressionsEnabled: true, memberImpressionsLearningEnabled: true }); fetchCount = 0; responder = () => payload(JSON.stringify({ knowledge: [], impressions: [{ ...memberItem, topic: "测试动漫", content: "喜欢测试动漫", tags: ["测试动漫"] }] })); learner.observeKnowledgeMessage({ groupId: "333", userId: "777", text: "记住，我喜欢测试动漫", settings: config.readLlmSettings(), messageId: "synthetic-member-learning", memberName: "测试成员" }); await learner.flushKnowledgeLearning("333"); assert.equal(fetchCount, 1); assert.match(members.memberImpressionContext("333", "777", "测试动漫"), /测试动漫/u); assert.equal(learner.getKnowledgeLearningStatus().groups.find(x => x.groupId === "333").lastMemberAddedCount, 1); });
await test("a cleared member cannot receive a stale queued model reply", async () => { config.writeLlmSettings({ ...base, memberImpressionsEnabled: true, memberImpressionsLearningEnabled: false }); members.mergeMemberImpressions("111", [makeMember("111", "444", "测试新游戏")]); messagesSent = []; responder = () => { members.forgetMemberImpression("111", "444"); return payload("包含旧印象的测试回复"); }; await main.handleMessage(inbound([{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "测试新游戏" } }]), { sendMessage: fakeOneBot }, {}); assert.equal(messagesSent.length, 0); });
await test("real handler forgets only the authenticated sender without model use", async () => { messagesSent = []; fetchCount = 0; await main.handleMessage(inbound([{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "忘记我" } }]), { sendMessage: fakeOneBot }, {}); assert.equal(fetchCount, 0); assert.equal(messagesSent.length, 1); assert.match(messagesSent[0].message, /已清除本群/u); assert.equal(members.memberLearningStamp("111", "444").learningEnabled, false); assert.equal(members.readMemberImpressions("222").members.find(x => x.userId === "444").facts.length, 1); });
config.writeLlmSettings(base); learner.clearKnowledgeLearning();

let server;
await test("management API authentication and scoped reads", async () => {
  const probe = createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); process.env.QQBOT_WEB_PORT = String(port);
  server = await (await load("web.js")).startManagementServer({ getOneBotStatus: () => ({ connected: true }) });
  const api = (path, method = "GET", body = null, cookie = "") => new Promise((resolve, reject) => { const req = httpRequest({ hostname: "127.0.0.1", port, path, method, headers: { ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(JSON.stringify(body)) } : {}), ...(cookie ? { cookie } : {}) } }, res => { let raw = ""; res.on("data", chunk => raw += chunk); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(raw) })); }); req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined); });
  assert.equal((await api("/api/model-diagnostics")).status, 401);
  assert.equal((await api("/api/member-impressions?groupId=111")).status, 401);
  const setup = await api("/api/auth/setup", "POST", { password: "isolatedFixturePassword2026!" }); assert.equal(setup.status, 201); const cookie = setup.headers["set-cookie"][0].split(";")[0];
  assert.equal((await api("/api/model-diagnostics", "GET", null, cookie)).status, 200);
  await test("member API rejects unauthorized groups", async () => { assert.equal((await api("/api/member-impressions?groupId=9999", "GET", null, cookie)).status, 404); });
  await test("member API reads only the chosen group", async () => { const result = await api("/api/member-impressions?groupId=333", "GET", null, cookie); assert.equal(result.status, 200); assert.equal(result.data.groupId, "333"); assert.deepEqual(result.data.members.map(x => x.userId), ["777"]); });
  await test("member API clears with revision protection", async () => { const state = (await api("/api/member-impressions?groupId=333", "GET", null, cookie)).data; const cleared = await api("/api/member-impressions", "DELETE", { groupId: "333", userId: "777", revision: state.revision }, cookie); assert.equal(cleared.status, 200); assert.equal(cleared.data.members[0].facts.length, 0); assert.equal(cleared.data.members[0].learningEnabled, false); assert.equal((await api("/api/member-impressions", "DELETE", { groupId: "333", userId: "777", revision: state.revision }, cookie)).status, 409); });
  assert.equal((await api("/api/sticker-preferences?groupId=9999", "GET", null, cookie)).status, 404);
  const group = await api("/api/knowledge?groupId=222", "GET", null, cookie); assert.equal(group.status, 200); assert.ok(group.data.entries.every(x => x.groupId === "222"));
  assert.equal((await api("/api/knowledge/learn", "POST", { groupId: "111" }, cookie)).status, 409);
});
if (server) await new Promise(resolve => server.close(resolve));
await (await load("model-transport.js")).closeModelConnections();
Date.now = nativeNow; globalThis.setTimeout = nativeTimeout;
report.passed = report.cases.filter(x => x.passed).length; report.failed = report.cases.length - report.passed;
await writeFile(join(root, ".local", "p0-check-metadata.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ fixture, passed: report.passed, failed: report.failed }));
if (report.failed) process.exitCode = 1;
