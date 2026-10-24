import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { ensureBrowserRuntime, browserRuntimeHealth, inspectChatGptPage, chatGptPageProbe } from "../src/imagegen-runtime.js";
import { parseImageGenerationIntent } from "../src/chatgpt-imagegen.js";
test("natural image commands are routed to image generation without catching code generation", () => {
  for (const text of ["肥鱼，帮我画一只合成小猫", "帮我画一个合成角色", "生成测试角色的样子", "帮我生成测试角色的头像", "/生图 合成森林"]) assert(parseImageGenerationIntent(text, ["肥鱼"]));
  for (const text of ["生成一段代码", "你会不会生图", "这张图挺可爱"]) assert.equal(parseImageGenerationIntent(text), null);
});
test("healthy shared browser runtime is reused without starting another service", async () => {
  let starts = 0; const s = await ensureBrowserRuntime({ health: async () => ({ connected: true }), bootstrap: async () => { starts++; } }); assert(s.connected); assert.equal(starts, 0);
});
test("cold start and concurrent requests share a reconnect attempt", async () => {
  let connected = false, starts = 0;
  const options = { health: async () => ({ connected }), bootstrap: async () => { starts++; await new Promise(r => setTimeout(r, 10)); connected = true; } };
  const results = await Promise.all([ensureBrowserRuntime(options), ensureBrowserRuntime(options)]); assert(results.every(s => s.connected)); assert.equal(starts, 1);
});
test("next cold start can restore dependencies after a previous lifecycle", async () => {
  let connected = false, starts = 0;
  const options = { health: async () => ({ connected }), bootstrap: async () => { starts++; connected = true; } };
  await ensureBrowserRuntime(options); connected = false; assert((await ensureBrowserRuntime(options)).connected); assert.equal(starts, 2);
});
test("proxy offline remains distinct from browser login", async () => {
  const s = await browserRuntimeHealth({ fetcher: async () => { throw new Error("synthetic offline"); } }); assert.equal(s.state, "proxy-unavailable"); assert(!s.connected);
});
test("browser connected without a composer is not reported as image ready", async () => {
  const fetcher = async url => ({ json: async () => url.endsWith("/targets") ? [{ targetId: "synthetic", url: "https://chatgpt.com/" }] : { value: JSON.stringify({ composer: false, login: false }) } });
  const s = await inspectChatGptPage({ fetcher }); assert(!s.pageReady); assert.equal(s.pageState, "page-unavailable");
});
test("explicit login requirement and usable composer are classified separately", async () => {
  for (const login of [true, false]) {
    const fetcher = async url => ({ json: async () => url.endsWith("/targets") ? [{ targetId: "synthetic", url: "https://chatgpt.com/" }] : { value: JSON.stringify({ composer: !login, login }) } });
    const s = await inspectChatGptPage({ fetcher }); assert.equal(s.pageState, login ? "login-required" : "composer-ready");
  }
});
test("current visible role textbox is detected without the old prompt-textarea id", () => {
  const editor={tagName:'DIV',isContentEditable:true,getClientRects:()=>[{}]};
  const document={querySelectorAll:selector=>selector.includes('[contenteditable="true"][role="textbox"]')?[editor]:[]};
  const probe=()=>JSON.parse(runInNewContext(chatGptPageProbe,{document,getComputedStyle:()=>({visibility:'visible',display:'block'})}));
  assert.equal(probe().composer,true);
  editor.getClientRects=()=>[];assert.equal(probe().composer,false);
  editor.getClientRects=()=>[{}];editor.isContentEditable=false;assert.equal(probe().composer,false);
  editor.isContentEditable=true;editor.disabled=true;assert.equal(probe().composer,false);
});
