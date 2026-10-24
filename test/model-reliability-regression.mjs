import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, copyFile, readFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(join(root, ".local"), { recursive: true });
const fixture = await mkdtemp(join(root, ".local", "model-reliability-"));
await mkdir(join(fixture, "src"));
await mkdir(join(fixture, "public"));
for (const folder of ["src", "public"]) {
  for (const name of await readdir(join(root, folder))) if (/\.(js|html|css)$/u.test(name)) await copyFile(join(root, folder, name), join(fixture, folder, name));
}
process.env.QQBOT_LLM_API_KEY = "synthetic-model-key-not-a-secret";
for (const variable of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "QQBOT_MODEL_PROXY_URL"]) delete process.env[variable];

const load = name => import(pathToFileURL(join(fixture, "src", name)));
const report = { fixture, cases: [] };
async function test(name, task) {
  try { await task(); report.cases.push({ name, passed: true }); console.log("PASS " + name); }
  catch (error) { report.cases.push({ name, passed: false, error: String(error?.message ?? error).slice(0, 500) }); console.log("FAIL " + name + ": " + String(error?.message ?? error).slice(0, 400)); }
}

const nativeSetTimeout = globalThis.setTimeout;
const retryDelays = [];
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay >= 1000 && delay <= 15000) {
    retryDelays.push(delay);
    return nativeSetTimeout(callback, 0, ...args);
  }
  return nativeSetTimeout(callback, delay, ...args);
};
let fetchCount = 0;
let responder = async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: "synthetic reply" } }] });
globalThis.fetch = async (url, options = {}) => {
  assert.equal(new URL(url).hostname, "fixture.invalid", "test must never contact a real model host");
  fetchCount += 1;
  return responder(url, options);
};
const transport = await load("model-transport.js");
const diagnostics = await load("model-diagnostics.js");
const endpoint = "https://fixture.invalid/v1/chat/completions";

await test("transport retries a reset once and succeeds on the second HTTP attempt", async () => {
  fetchCount = 0;
  responder = async () => { if (fetchCount === 1) throw new TypeError("synthetic reset", { cause: { code: "ECONNRESET" } }); return Response.json({ ok: true }); };
  const response = await transport.fetchModel(endpoint, { method: "POST", modelRetries: true });
  assert.equal(response.status, 200); assert.equal(fetchCount, 2);
  const events = diagnostics.readModelDiagnostics().slice(-4);
  assert.deepEqual(events.filter(event => ["start", "transport", "http"].includes(event.kind)).map(event => event.attempt), [1, 1, 2, 2]);
  assert.equal(new Set(events.map(event => event.id)).size, 1);
});

await test("connection refused, DNS and socket timeout codes each get at most one retry", async () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_SOCKET"]) {
    fetchCount = 0;
    responder = async () => { if (fetchCount === 1) throw new TypeError("synthetic transport error", { cause: { code } }); return Response.json({ ok: true }); };
    assert.equal((await transport.fetchModel(endpoint, { method: "POST", modelRetries: true })).status, 200, code);
    assert.equal(fetchCount, 2, code);
  }
});

await test("transport retry budget stops persistent resets after two attempts", async () => {
  fetchCount = 0;
  responder = async () => { throw new TypeError("synthetic reset", { cause: { code: "ECONNRESET" } }); };
  await assert.rejects(transport.fetchModel(endpoint, { method: "POST", modelRetries: true }), error => error?.cause?.code === "ECONNRESET");
  assert.equal(fetchCount, 2);
});

await test("transport retry switch disabled makes one attempt", async () => {
  fetchCount = 0; responder = async () => new Response("", { status: 503 });
  const response = await transport.fetchModel(endpoint, { method: "POST", modelRetries: false });
  assert.equal(response.status, 503); assert.equal(fetchCount, 1);
});

await test("transport retries 500, 502, 503 and 504 once, but not ordinary 4xx", async () => {
  for (const status of [500, 502, 503, 504]) {
    fetchCount = 0;
    responder = async () => fetchCount === 1 ? new Response(status === 503 ? "SYNTHETIC_PROVIDER_BODY_SECRET" : "", { status }) : Response.json({ ok: true });
    assert.equal((await transport.fetchModel(endpoint, { method: "POST", modelRetries: true })).status, 200);
    assert.equal(fetchCount, 2, `HTTP ${status}`);
  }
  fetchCount = 0; responder = async () => new Response("", { status: 404 });
  assert.equal((await transport.fetchModel(endpoint, { method: "POST", modelRetries: true })).status, 404);
  assert.equal(fetchCount, 1);
  fetchCount = 0; responder = async () => new Response("", { status: 401 });
  assert.equal((await transport.fetchModel(endpoint, { method: "POST", modelRetries: true })).status, 401);
  assert.equal(fetchCount, 1);
});

await test("HTTP 429 Retry-After seconds and date are honored by transport", async () => {
  for (const header of ["6", new Date(Date.now() + 6000).toUTCString()]) {
    fetchCount = 0; retryDelays.length = 0;
    responder = async () => fetchCount === 1
      ? new Response("", { status: 429, headers: { "retry-after": header } })
      : Response.json({ ok: true });
    assert.equal((await transport.fetchModel(endpoint, { method: "POST", modelRetries: true })).status, 200);
    assert.equal(fetchCount, 2); assert.ok(retryDelays.some(delay => delay >= 5000), JSON.stringify(retryDelays));
  }
  fetchCount = 0;
  responder = async () => new Response("", { status: 429, headers: { "retry-after": new Date(Date.now() + 20000).toUTCString() } });
  assert.equal((await transport.fetchModel(endpoint, { method: "POST", modelRetries: true })).status, 429);
  assert.equal(fetchCount, 1, "a server wait beyond the bounded retry window is returned to the caller");
});

await test("a connection-pool setup error is categorized without contacting the endpoint", async () => {
  fetchCount = 0;
  await assert.rejects(transport.fetchModel("not a valid URL", { method: "POST", modelRetries: true }));
  assert.equal(fetchCount, 0);
  const last = diagnostics.readModelDiagnostics().at(-1);
  assert.equal(last?.kind, "transport"); assert.equal(last?.code, "POOL_SETUP_FAILED");
});

await test("abort during transport backoff stops promptly before another attempt", async () => {
  fetchCount = 0; const controller = new AbortController();
  responder = async () => { throw new TypeError("synthetic reset", { cause: { code: "ECONNRESET" } }); };
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => delay === 1000 ? nativeSetTimeout(callback, 250, ...args) : originalSetTimeout(callback, delay, ...args);
  const abortTimer = nativeSetTimeout(() => controller.abort(new DOMException("cancelled", "AbortError")), 10);
  const started = performance.now();
  try {
    await assert.rejects(transport.fetchModel(endpoint, { method: "POST", modelRetries: true, signal: controller.signal }));
    assert.ok(performance.now() - started < 180, "abort should end retry wait promptly");
    assert.equal(fetchCount, 1);
  } finally { clearTimeout(abortTimer); globalThis.setTimeout = originalSetTimeout; }
});

await test("transport diagnostics are bounded, correlated, and omit request secrets", async () => {
  const diagnosticFixture = join(fixture, ".local", "model-diagnostics.json");
  const events = diagnostics.readModelDiagnostics();
  assert.ok(events.length <= 40);
  const latest = events.at(-1);
  assert.ok(latest?.id); assert.ok(Number.isFinite(latest?.attempt));
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (let index = 0; index < 100; index += 1) diagnostics.recordModelDiagnostic("failure", { code: "SYNTHETIC_CAPACITY_EVENT", prompt: "SYNTHETIC_PRIVATE_PROMPT", authorization: "Bearer SYNTHETIC_PRIVATE_KEY" });
  } finally { console.warn = warn; }
  const text = await readFile(diagnosticFixture, "utf8");
  assert.ok(!text.includes("synthetic-model-key-not-a-secret"));
  assert.ok(!text.includes("fixture.invalid"));
  assert.ok(!text.includes("SYNTHETIC_PROVIDER_BODY_SECRET"));
  assert.ok(!text.includes("SYNTHETIC_PRIVATE_PROMPT"));
  assert.ok(!text.includes("SYNTHETIC_PRIVATE_KEY"));
  assert.equal(JSON.parse(text).length, 80);
  assert.equal(diagnostics.readModelDiagnostics().length, 40);
});

await test("diagnostic persistence failures do not escape into the reply path", async () => {
  await mkdir(join(fixture, ".local", "model-diagnostics.json.tmp"));
  assert.doesNotThrow(() => diagnostics.recordModelDiagnostic("transport", { code: "ECONNRESET", prompt: "SYNTHETIC_PRIVATE_PROMPT", authorization: "Bearer SYNTHETIC_PRIVATE_KEY" }));
  await rm(join(fixture, ".local", "model-diagnostics.json.tmp"), { recursive: true, force: true });
});

await test("every direct model helper passes the global retry setting to transport", async () => {
  for (const [file, variable] of [["knowledge-learning.js", "settings"], ["sticker-review.js", "settings"], ["visual-learning.js", "current"], ["visual-verification.js", "current"]]) {
    const source = await readFile(join(fixture, "src", file), "utf8");
    assert.match(source, new RegExp(`modelRetries:\\s*${variable}\\.modelRetryEnabled\\s*!==\\s*false`), file);
  }
});

await test("knowledge extraction honors automatic retry disabled at the actual call site", async () => {
  const settingsStore = await load("llm-settings-store.js"), learner = await load("knowledge-learning.js");
  const settings = { ...settingsStore.DEFAULT_LLM_SETTINGS, apiEndpoint: endpoint, model: "synthetic-model", modelRetryEnabled: false };
  fetchCount = 0; responder = async () => new Response("", { status: 503 });
  await assert.rejects(learner.extractLearningBatch({ apiKey: "synthetic-model-key-not-a-secret", settings, batch: [{ userId: "444", text: "synthetic learning input" }] }));
  assert.equal(fetchCount, 1);
});

await test("LLM main path honors HTTP-date Retry-After within the shared request budget", async () => {
  const settingsStore = await load("llm-settings-store.js");
  const access = await load("access-control-store.js");
  const settings = { ...settingsStore.DEFAULT_LLM_SETTINGS, apiEndpoint: endpoint, model: "synthetic-model", systemPrompt: "synthetic system", personality: "synthetic", expressionStyle: "short", searchEnabled: false, videoUnderstandingEnabled: false, proactiveChatEnabled: false, memberImpressionsEnabled: false, stickersEnabled: false, characterRecognitionEnabled: false };
  settingsStore.writeLlmSettings(settings); access.writeAccessControl({ groupIds: ["111"], userIds: [] });
  const llm = await load("llm.js");
  fetchCount = 0; retryDelays.length = 0;
  responder = async () => fetchCount === 1
    ? new Response("", { status: 429, headers: { "retry-after": new Date(Date.now() + 10000).toUTCString() } })
    : Response.json({ choices: [{ finish_reason: "stop", message: { content: "date retry success" } }] });
  const result = await llm.getLlmReply({ apiKey: "synthetic-model-key-not-a-secret", settings, userId: "synthetic", senderQQId: "444", userMessage: "synthetic question", queued: true });
  assert.equal(result.reply, "date retry success"); assert.equal(fetchCount, 2); assert.ok(retryDelays.some(delay => delay >= 9000), JSON.stringify(retryDelays));
  fetchCount = 0;
  responder = async () => new Response("", { status: 429, headers: { "retry-after": new Date(Date.now() + 20000).toUTCString() } });
  await assert.rejects(llm.getLlmReply({ apiKey: "synthetic-model-key-not-a-secret", settings, userId: "synthetic-ratelimit", senderQQId: "445", userMessage: "synthetic question", queued: true }), error => error?.code === "RATE_LIMITED");
  assert.equal(fetchCount, 1, "a Retry-After beyond the bounded wait window is not retried early");
});

await test("interrupted response body is classified and gets one bounded retry", async () => {
  const settingsStore = await load("llm-settings-store.js"), access = await load("access-control-store.js"), llm = await load("llm.js");
  const settings = { ...settingsStore.DEFAULT_LLM_SETTINGS, apiEndpoint: endpoint, model: "synthetic-model", systemPrompt: "synthetic system", personality: "synthetic", expressionStyle: "short", searchEnabled: false, videoUnderstandingEnabled: false, proactiveChatEnabled: false, memberImpressionsEnabled: false, stickersEnabled: false, characterRecognitionEnabled: false };
  settingsStore.writeLlmSettings(settings); access.writeAccessControl({ groupIds: ["111"], userIds: [] });
  fetchCount = 0;
  responder = async () => fetchCount === 1
    ? new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("synthetic body interruption")); } }), { headers: { "content-type": "application/json" } })
    : Response.json({ choices: [{ finish_reason: "stop", message: { content: "recovered after body interruption" } }] });
  const result = await llm.getLlmReply({ apiKey: "synthetic-model-key-not-a-secret", settings, userId: "synthetic", senderQQId: "444", userMessage: "synthetic question", queued: true });
  assert.equal(result.reply, "recovered after body interruption"); assert.equal(fetchCount, 2);
});

await test("body-read timeout cancels the logical request without another HTTP attempt", async () => {
  const settingsStore = await load("llm-settings-store.js"), access = await load("access-control-store.js"), llm = await load("llm.js");
  const settings = { ...settingsStore.DEFAULT_LLM_SETTINGS, apiEndpoint: endpoint, model: "synthetic-model", systemPrompt: "synthetic system", personality: "synthetic", expressionStyle: "short", searchEnabled: false, videoUnderstandingEnabled: false, proactiveChatEnabled: false, memberImpressionsEnabled: false, stickersEnabled: false, characterRecognitionEnabled: false };
  settingsStore.writeLlmSettings(settings); access.writeAccessControl({ groupIds: ["111"], userIds: [] });
  const originalTimeout = AbortSignal.timeout, controller = new AbortController();
  AbortSignal.timeout = () => controller.signal;
  fetchCount = 0;
  responder = async (_url, options) => new Response(new ReadableStream({ start(stream) {
    options.signal.addEventListener("abort", () => stream.error(options.signal.reason), { once: true });
  } }), { headers: { "content-type": "application/json" } });
  const timer = nativeSetTimeout(() => controller.abort(new DOMException("synthetic timeout", "TimeoutError")), 10);
  try {
    await assert.rejects(llm.getLlmReply({ apiKey: "synthetic-model-key-not-a-secret", settings, userId: "synthetic", senderQQId: "444", userMessage: "synthetic question", queued: true }), error => error?.code === "BODY_TIMEOUT");
    assert.equal(fetchCount, 1);
  } finally { clearTimeout(timer); AbortSignal.timeout = originalTimeout; }
});

await test("three tool rounds plus the final answer have a tested eight-attempt upper bound", async () => {
  const settingsStore = await load("llm-settings-store.js"), access = await load("access-control-store.js"), llm = await load("llm.js");
  const settings = { ...settingsStore.DEFAULT_LLM_SETTINGS, apiEndpoint: endpoint, model: "synthetic-model", systemPrompt: "synthetic system", personality: "synthetic", expressionStyle: "short", searchEnabled: false, knowledgeEnabled: true, videoUnderstandingEnabled: false, proactiveChatEnabled: false, memberImpressionsEnabled: false, stickersEnabled: false, characterRecognitionEnabled: false };
  settingsStore.writeLlmSettings(settings); access.writeAccessControl({ groupIds: ["111"], userIds: [] });
  fetchCount = 0; let completedSteps = 0;
  responder = async () => {
    if (fetchCount % 2 === 1) throw new TypeError("synthetic reset", { cause: { code: "ECONNRESET" } });
    completedSteps += 1;
    if (completedSteps <= 3) return Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: `synthetic-tool-${completedSteps}`, type: "function", function: { name: "search_meme_knowledge", arguments: '{"query":"synthetic"}' } }] } }] });
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "bounded final answer" } }] });
  };
  const result = await llm.getLlmReply({ apiKey: "synthetic-model-key-not-a-secret", settings, userId: "synthetic-tool-budget", groupId: "111", senderQQId: "444", userMessage: "synthetic question", queued: true });
  assert.equal(result.reply, "bounded final answer");
  assert.equal(fetchCount, 8, "each of three tool rounds and the final answer has one retry maximum");
});

await test("uncertain OneBot send receipt prevents blind duplicate delivery", async () => {
  const delivery = await load("recovery-delivery.js");
  let sends = 0;
  const options = { scope: "group", peerId: "111", sourceMessageId: "901", text: "synthetic recovered reply", selfId: "999", sendAction: async () => {
    sends += 1; const error = new Error("synthetic unconfirmed result"); error.code = "ONEBOT_ACTION_UNCONFIRMED"; throw error;
  } };
  await assert.rejects(delivery.sendRecoveredReply(options), error => error.code === "ONEBOT_ACTION_UNCONFIRMED");
  const second = await delivery.sendRecoveredReply(options);
  assert.equal(second.duplicate, true); assert.equal(second.state, "uncertain"); assert.equal(sends, 1);
  await rm(join(fixture, ".local", "recovery-deliveries"), { recursive: true, force: true });
});

globalThis.setTimeout = nativeSetTimeout;
console.log(JSON.stringify({ fixture, passed: report.cases.filter(item => item.passed).length, failed: report.cases.filter(item => !item.passed).length, cases: report.cases }));
if (report.cases.some(item => !item.passed)) process.exitCode = 1;
