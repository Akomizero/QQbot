import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeRevision } from "./runtime-revision.js";

const folder = new URL("../.local/", import.meta.url);
const file = new URL("bot-health.json", folder);
const temporary = new URL(`bot-health.${process.pid}.tmp`, folder);
const project = fileURLToPath(new URL("../", import.meta.url));
const definitions = [
  ["configuration", "配置与启动预检", true], ["onebot", "OneBot 本机桥接", true],
  ["management", "本机管理页面", true], ["replyRecovery", "失败回复恢复调度", true],
  ["memoryMaintenance", "记忆维护调度", true], ["videoDiscovery", "视频话题发现调度", false],
  ["stickerDescriptions", "表情描述队列入口", false], ["modelProxy", "模型专用出口", false],
];
const componentStates = new Set(["starting", "ready", "listening", "waiting-qq", "started-unverified", "configured-unverified", "disabled", "missing-dependency", "failed", "stopped"]);
const initialized = new Set(["ready", "listening", "started-unverified"]);

// This is a local lifecycle receipt, not an external-provider or task-success probe.
// Getters must return booleans/settings flags only; arbitrary values never enter the snapshot.
export function createServiceHealth({ getSettings, getOneBotStatus, getManagementListening }) {
  const revision = runtimeRevision(), startedAt = Date.now();
  const activation = new Map(definitions.map(([id, label, required]) => [id, { id, label, required, state: "starting" }]));
  let startupComplete = false, stopped = false, startupFailed = false, timer, pending = Promise.resolve();
  let warned = false;
  const optional = (id, label, enabled, dependency, detail) => ({ id, label, required: false,
    state: !enabled ? "disabled" : dependency ? "configured-unverified" : "missing-dependency", ...(enabled && detail ? { detail } : {}) });

  function snapshot() {
    let configurationAvailable = true, settings = {}, onebot = {};
    try { settings = getSettings?.() ?? {}; } catch { configurationAvailable = false; }
    try { const current = getOneBotStatus?.() ?? {}; onebot = { connected: current.connected === true,
      ...(Number.isInteger(current.port) && current.port > 0 && current.port <= 65535 ? { port: current.port } : {}) }; }
    catch { onebot = { connected: false }; }
    let managementListening = false;
    try { managementListening = getManagementListening?.() === true; } catch {}
    const components = [...activation.values()].map(item => ({ ...item }));
    const find = id => components.find(item => item.id === id);
    if (!configurationAvailable) Object.assign(find("configuration"), { state: "failed", detail: "configuration-unavailable" });
    const bridge = find("onebot");
    if (initialized.has(bridge.state)) Object.assign(bridge, { state: onebot.connected ? "ready" : "waiting-qq", detail: "local-websocket-state-only" });
    if (initialized.has(find("management").state) && !managementListening) Object.assign(find("management"), { state: "failed", detail: "management-not-listening" });
    const model = settings.modelConfigured === true;
    const vision = settings.visionEnabled === true;
    const ffmpeg = existsSync(join(project, "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"));
    const asr = ffmpeg && existsSync(join(project, ".local", "video-runtime", "Scripts", "python.exe"))
      && existsSync(join(project, ".local", "video-asr-model", "model.bin")) && existsSync(join(project, "scripts", "video_asr.py"));
    const imageHelper = existsSync(join(project, "tools", "chatgpt-web-imagegen", "chatgpt_web_imagegen.py"))
      || existsSync(join(homedir(), ".codex", "skills", "chatgpt-web-imagegen", "scripts", "chatgpt_web_imagegen.py"));
    components.push(
      optional("model", "模型服务配置", true, model, "provider-not-probed"),
      optional("search", "网页搜索配置", settings.searchEnabled === true, settings.searchConfigured === true, "provider-not-probed"),
      optional("vision", "图片理解", vision, model, "provider-not-probed"),
      optional("characterRecognition", "角色独立辨认", vision && settings.characterRecognitionEnabled === true, model, "provider-not-probed"),
      optional("visualLearning", "角色纠正学习入口", vision && settings.characterRecognitionEnabled === true && settings.visualMemoryLearningEnabled === true, model, "event-driven-not-executed"),
      optional("knowledgeLearning", "群知识积累入口", settings.knowledgeEnabled === true && settings.knowledgeLearningEnabled === true, model, "event-driven-not-executed"),
      optional("memberLearning", "成员印象学习入口", settings.memberImpressionsEnabled === true && settings.memberImpressionsLearningEnabled === true, model, "event-driven-not-executed"),
      optional("stickerLearning", "表情学习入口", vision && settings.stickersEnabled === true && settings.stickerLearningEnabled === true, model, "event-driven-not-executed"),
      optional("proactive", "主动接话处理入口", settings.proactiveChatEnabled === true, model, "event-driven-no-independent-service"),
      optional("videoUnderstanding", "视频理解配置", settings.videoUnderstandingEnabled === true, model, "provider-not-probed"),
      optional("videoAsr", "视频本地语音转写", settings.videoUnderstandingEnabled === true && settings.videoAsrEnabled === true, asr, "local-files-only-not-executed"),
      optional("videoFrames", "视频画面抽取", settings.videoUnderstandingEnabled === true && settings.videoFramesEnabled === true && vision, ffmpeg, "local-files-only-not-executed"),
      optional("chatgptImages", "ChatGPT 网页生图配置", settings.chatgptImageGenerationEnabled === true, imageHelper, "helper-file-only-browser-not-probed"),
      optional("browserSession", "网页浏览会话", settings.chatgptImageGenerationEnabled === true || settings.videoDiscoveryEnabled === true, true, "browser-login-and-connection-not-probed"),
    );
    const discovery = find("videoDiscovery");
    if (initialized.has(discovery.state)) Object.assign(discovery, {
      activation: "started-unverified", state: settings.videoDiscoveryEnabled !== true ? "disabled"
        : model && settings.videoUnderstandingEnabled === true && settings.videoDiscoveryHasScope === true ? "configured-unverified" : "missing-dependency",
      detail: "scheduler-initialized-browser-and-task-not-probed",
    });
    const descriptions = find("stickerDescriptions");
    if (initialized.has(descriptions.state)) Object.assign(descriptions, { activation: "started-unverified",
      state: !vision || settings.stickersEnabled !== true ? "disabled" : model ? "configured-unverified" : "missing-dependency", detail: "queue-entry-initialized-not-executed" });
    const coreReady = !stopped && !startupFailed && startupComplete && onebot.connected === true && managementListening
      && components.filter(item => item.required).every(item => initialized.has(item.state));
    const state = stopped ? "stopped" : startupFailed ? "degraded" : !startupComplete ? "starting" : !onebot.connected ? "waiting-qq"
      : !coreReady || components.some(item => ["failed", "missing-dependency"].includes(item.state)) ? "degraded" : "ready";
    if (stopped) for (const item of components) if (item.required || activation.has(item.id)) item.state = "stopped";
    return { version: 1, pid: process.pid, runtimeRevision: revision, startedAt, updatedAt: Date.now(), state, startupComplete, coreReady,
      onebot: { ...onebot, connected: !stopped && onebot.connected === true }, components };
  }

  function warnOnce() {
    if (!warned) { warned = true; console.warn("本机健康快照暂时无法更新；不影响机器人消息处理。"); }
  }
  function refresh() {
    if (stopped) return pending;
    const current = snapshot();
    pending = pending.catch(() => {}).then(async () => {
      if (stopped) return;
      await mkdir(folder, { recursive: true });
      await writeFile(temporary, JSON.stringify(current), { mode: 0o600 });
      await rename(temporary, file); warned = false;
    }).catch(warnOnce);
    return pending;
  }
  function onExit() {
    stopped = true; clearInterval(timer);
    try { mkdirSync(folder, { recursive: true }); writeFileSync(temporary, JSON.stringify(snapshot()), { mode: 0o600 }); renameSync(temporary, file); }
    catch { /* Process exit must not throw or print configuration. */ }
  }
  timer = setInterval(() => { void refresh(); }, 5000); timer.unref?.();
  process.once("exit", onExit); void refresh();
  return {
    refresh,
    component(id, state, detail) {
      const item = activation.get(id);
      if (stopped || !item || !componentStates.has(state)) return;
      item.state = state;
      if (typeof detail === "string" && /^[a-z][a-z0-9-]{0,99}$/u.test(detail)) item.detail = detail;
      void refresh();
    },
    completeStartup() { if (!stopped) { startupComplete = true; void refresh(); } },
    failStartup() { if (!stopped) { startupFailed = true; activation.get("configuration").state = "failed"; void refresh(); } },
    async stop() {
      if (stopped) return pending;
      stopped = true; clearInterval(timer);
      await pending.catch(() => {});
      try { await mkdir(folder, { recursive: true }); await writeFile(temporary, JSON.stringify(snapshot()), { mode: 0o600 }); await rename(temporary, file); }
      catch { warnOnce(); }
      // The exit handler remains registered as a final synchronous stopped receipt.
    },
  };
}
