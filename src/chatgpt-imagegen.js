import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { buildImageGenerationPrompt } from "./image-prompt.js";
import { imagegenProxyUrl, browserRuntimeHealth, ensureBrowserRuntime, inspectChatGptPage, stopBrowserRuntimeBootstrap } from "./imagegen-runtime.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const folder = join(root, ".local", "chatgpt-images");
const projectHelper = join(root, "tools", "chatgpt-web-imagegen", "chatgpt_web_imagegen.py");
const helper = existsSync(projectHelper) ? projectHelper : join(homedir(), ".codex", "skills", "chatgpt-web-imagegen", "scripts", "chatgpt_web_imagegen.py");
const proxy = imagegenProxyUrl;
let tail = Promise.resolve(), pending = 0, running = false;
let stopping = false, cancelActive = null;
export function stopChatGptImageGeneration() { stopping = true; cancelActive?.(); stopBrowserRuntimeBootstrap(); }

export class ChatGptImageError extends Error {
  constructor(code, message) { super(message); this.name = "ChatGptImageError"; this.code = code; }
}

export function parseImageGenerationIntent(text, aliases = []) {
  let value = String(text ?? "").trim();
  for (const alias of [...aliases].sort((a, b) => b.length - a.length)) {
    if (alias && value.startsWith(alias)) { value = value.slice(alias.length).replace(/^[\s,，:：、]+/u, ""); break; }
  }
  const match = value.match(/^(?:\/(?:生图|画图|draw)(?:\s+|$)|(?:(?:请|麻烦)?(?:你)?(?:帮我|给我)?\s*)(?:(?:用|使用)\s*ChatGPT\s*)?(?:画(?:一张|一幅|一只|一个|只|个|张|幅)|生成(?:一张|一幅|张|幅)|画图|生图|绘图|生成图片|生成肖像)(?:图片|图画|肖像|图)?\s*[:：]?\s*)([\s\S]*)$/iu);
  if (!match) {
    const natural = value.match(/^(?:请|麻烦)?(?:你)?(?:帮我|给我)?\s*(?:生成|画)([\s\S]{1,200}(?:的样子|的图|肖像|画像|插画|表情包|头像|图片))[。！!]?$/u);
    return natural ? { prompt: natural[1].trim() } : null;
  }
  return { prompt: match[1].trim() };
}

const health = browserRuntimeHealth;

export async function readChatGptImageStatus() {
  const connection = await health();
  const page = connection.connected ? await inspectChatGptPage() : { pageReady: false, pageState: connection.state };
  const counts = { generated: 0, delivered: 0, failed: 0, uncertain: 0 };
  try { for (const name of readdirSync(folder)) {
    if (!/^[a-f0-9]{32}\.json$/u.test(name)) continue;
    try { const job = JSON.parse(readFileSync(join(folder, name), "utf8"));
      if (job.state in counts) counts[job.state]++;
      else if (["running", "sending"].includes(job.state)) counts.uncertain++;
    } catch {}
  } } catch {}
  return { installed: existsSync(helper), ...connection, ...page, pending, running, ...counts };
}

function runHelper(prompt, output, allowed, referenceFiles) {
  return new Promise((resolveJob, rejectJob) => {
    const args = [...(process.platform === "win32" ? ["-3"] : []), helper,
      "--prompt-stdin", "--out", output, "--proxy-url", proxy, "--timeout", "300"];
    for (const file of referenceFiles) args.push("--reference", file);
    const child = spawn(process.platform === "win32" ? "py" : "python3", args, {
      windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", PYTHONIOENCODING: "utf-8" },
    });
    let stdout = "", stderr = "", finished = false;
    const done = (error, value) => {
      if (finished) return; finished = true; clearInterval(guard); clearTimeout(timeout); cancelActive = null;
      if (error) rejectJob(error); else resolveJob(value);
    };
    const cancel = code => { child.kill(); done(new ChatGptImageError(code, code === "CANCELLED" ? "这次画图请求已取消。" : "网页生图等待超时，请稍后查看 ChatGPT 页面。")); };
    const guard = setInterval(() => { try { if (!allowed()) cancel("CANCELLED"); } catch { cancel("CANCELLED"); } }, 2000);
    const timeout = setTimeout(() => cancel("TIMEOUT"), 8 * 60_000);
    cancelActive = () => cancel("CANCELLED");
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 16000) cancel("OUTPUT_LIMIT"); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", () => done(new ChatGptImageError("HELPER_START", "无法启动网页生图组件，请管理员检查 Python 和 skill 安装。")));
    child.on("close", code => {
      if (code !== 0) {
        const message = /not logged|log in|登录/iu.test(stderr) ? "ChatGPT 网页需要重新登录，请管理员在 Edge 中登录后再试。"
          : /no browser-control|proxy|connection|urlopen/iu.test(stderr) ? "Edge 网页生图连接已断开，请管理员检查浏览器授权。"
          : /rate.limit|quota|额度|限额|次数/iu.test(stderr) ? "ChatGPT 网页提示额度或频率限制，请稍后再试。"
          : "ChatGPT 网页这次没有完成出图，请管理员查看 Edge 页面；没有切换到其他生图服务。";
        done(new ChatGptImageError("WEB_GENERATION_FAILED", message)); return;
      }
      try { const metadata = JSON.parse(stdout.trim()); if (resolve(metadata.path) !== output) throw new Error(); done(null, metadata); }
      catch { done(new ChatGptImageError("INVALID_RESULT", "网页生图结果未能确认，请管理员检查本机图片记录。")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

export async function generateChatGptImage({ prompt, sourceKey, allowed = () => true, referenceFiles = [], referenceDataUrls = [] }) {
  if (stopping) throw new ChatGptImageError("CANCELLED", "网页生图服务正在停止。");
  if (!prompt || prompt.length > 3000) throw new ChatGptImageError("PROMPT", "请给出 1～3000 字的画图描述，例如‘肥鱼，画一张橙发少女的肖像’。");
  if (/(?:血肉模糊|真实(?:尸体|内脏)|排泄物|粪便|猎奇血腥)/u.test(prompt)) throw new ChatGptImageError("CONTENT", "这种令人不适的图片不适合发到群里，换个画面吧。");
  if (!existsSync(helper)) throw new ChatGptImageError("NOT_INSTALLED", "网页生图 skill 尚未安装，请管理员先完成本机配置。");
  if (pending >= 3) throw new ChatGptImageError("BUSY", "画图队列已满，请等前面的图片完成后再试。");
  const id = createHash("sha256").update(String(sourceKey)).digest("hex").slice(0, 32);
  const jobFile = join(folder, `${id}.json`), output = join(folder, `${id}.png`);
  mkdirSync(folder, { recursive: true });
  try { writeFileSync(jobFile, JSON.stringify({ id, state: "queued", at: Date.now() }), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code === "EEXIST") throw new ChatGptImageError("DUPLICATE", "这条画图请求已经处理过，请勿重复提交；需要重画时请发送新消息。"); throw error; }
  pending++;
  const work = tail.catch(() => {}).then(async () => {
    if (stopping || !allowed()) throw new ChatGptImageError("CANCELLED", "这次画图请求已取消。");
    if (!(await ensureBrowserRuntime()).connected) throw new ChatGptImageError("DISCONNECTED", "已尝试恢复网页连接，但 Edge 生图连接仍未就绪；请打开原浏览器并确认授权。");
    running = true;
    writeFileSync(jobFile, JSON.stringify({ id, state: "running", at: Date.now() }), { mode: 0o600 });
    if (referenceDataUrls.length > 2) throw new ChatGptImageError("REFERENCES", "一次最多使用两张参考图。");
    const localReferences = [...referenceFiles];
    for (const [index, value] of referenceDataUrls.entries()) {
      if (typeof value !== "string" || value.length > 9 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,/u.test(value)) throw new ChatGptImageError("REFERENCE_FORMAT", "参考图格式无法确认。");
      const bytes = Buffer.from(value.slice(value.indexOf(",") + 1), "base64");
      const reference = join(folder, `${id}-reference-${index}.png`);
      writeFileSync(reference, await sharp(bytes, { limitInputPixels: 32_000_000 }).png().toBuffer(), { mode: 0o600 });
      localReferences.push(reference);
    }
    const brief = buildImageGenerationPrompt(prompt, { referenceCount: localReferences.length });
    const promptMetadata = { promptVersion: brief.version, promptMode: brief.mode, promptProfile: brief.profile, promptCharacters: brief.characters };
    writeFileSync(jobFile, JSON.stringify({ id, state: "running", at: Date.now(), ...promptMetadata }), { mode: 0o600 });
    await runHelper(brief.text, output, allowed, localReferences);
    if (!allowed()) throw new ChatGptImageError("CANCELLED", "这次画图请求已取消。");
    const original = readFileSync(output);
    if (original.length > 24 * 1024 * 1024) throw new ChatGptImageError("IMAGE_SIZE", "生成的图片过大，暂时无法发送。");
    const image = sharp(original, { limitInputPixels: 32_000_000 });
    const metadata = await image.metadata();
    if (!["png", "webp", "jpeg"].includes(metadata.format)) throw new ChatGptImageError("IMAGE_FORMAT", "网页返回的内容不是可确认的图片。");
    const bytes = await image.resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    if (bytes.length > 8 * 1024 * 1024) throw new ChatGptImageError("IMAGE_SIZE", "生成的图片过大，暂时无法发送。");
    writeFileSync(jobFile, JSON.stringify({ id, state: "generated", at: Date.now(), width: metadata.width, height: metadata.height, ...promptMetadata }), { mode: 0o600 });
    return { id, bytes, path: output, width: metadata.width, height: metadata.height };
  }).catch(error => {
    writeFileSync(jobFile, JSON.stringify({ id, state: "failed", at: Date.now(), code: error.code ?? "FAILED" }), { mode: 0o600 });
    throw error;
  }).finally(() => { pending--; running = false; });
  tail = work.catch(() => {});
  return work;
}

export function recordGeneratedImageDelivery(id, state, messageId = null) {
  if (!/^[a-f0-9]{32}$/u.test(id) || !["sending", "delivered", "uncertain"].includes(state)) throw new Error("Invalid image receipt");
  const file = join(folder, `${id}.json`);
  let previous = {};
  try { previous = JSON.parse(readFileSync(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  writeFileSync(file, JSON.stringify({ ...previous, id, state, at: Date.now(), ...(messageId ? { messageId: String(messageId) } : {}) }), { mode: 0o600 });
}
