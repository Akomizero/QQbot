import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environmentPath = resolve(projectRoot, ".env");

function unquote(value) {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed.at(-1);

  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

export function loadEnvironment() {
  let source;

  try {
    source = readFileSync(environmentPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const line of source.split(/\r?\n/u)) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#")) continue;

    const separator = entry.indexOf("=");
    if (separator < 1) continue;

    const name = entry.slice(0, separator).trim();
    const value = unquote(entry.slice(separator + 1));
    if (name && process.env[name] === undefined) process.env[name] = value;
  }
}

export function getConfig() {
  loadEnvironment();

  const onebotAccessToken = process.env.ONEBOT_ACCESS_TOKEN?.trim() ?? "";
  if (!/^[A-Za-z0-9._~-]{32,512}$/u.test(onebotAccessToken) || onebotAccessToken === "请生成至少32位随机令牌") {
    throw new Error("请先在 .env 中设置至少 32 位的 ONEBOT_ACCESS_TOKEN。此密钥不会显示在管理页或日志中。");
  }

  const rawPort = process.env.QQBOT_ONEBOT_PORT?.trim() || "16700";
  const onebotPort = Number(rawPort);
  if (!Number.isInteger(onebotPort) || onebotPort < 1 || onebotPort > 65535) {
    throw new Error("QQBOT_ONEBOT_PORT 必须是 1 到 65535 之间的端口号。");
  }

  const onebotPath = process.env.QQBOT_ONEBOT_PATH?.trim() || "/onebot/v11/ws";
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/u.test(onebotPath)) {
    throw new Error("QQBOT_ONEBOT_PATH 必须是安全的本地 WebSocket 路径。");
  }

  return {
    onebotAccessToken,
    onebotPort,
    onebotPath,
    llmApiKey: getLlmApiKey(),
    searchApiKey: getSearchApiKey(),
  };
}

export function getLlmApiKey() {
  loadEnvironment();
  const apiKey = process.env.QQBOT_LLM_API_KEY?.trim() ?? "";
  return apiKey === "填入主线提供的APIKey" ? "" : apiKey;
}

export function getSearchApiKey() {
  loadEnvironment();
  const apiKey = process.env.TAVILY_API_KEY?.trim() ?? "";
  return apiKey === "填入自行申请的TavilyAPIKey" ? "" : apiKey;
}

export function validateLlmApiKey(apiKey) {
  if (typeof apiKey !== "string" || apiKey.length < 8 || apiKey.length > 2048) {
    throw new Error("模型 API key 格式不正确。");
  }
  if (!/^[\x21-\x7E]+$/u.test(apiKey) || apiKey.includes("\"") || apiKey.includes("'")) {
    throw new Error("模型 API key 只能包含不带空格的可见 ASCII 字符。");
  }
  return apiKey;
}

export function updateLlmApiKey(apiKey) {
  const normalizedKey = apiKey === null ? null : validateLlmApiKey(apiKey);
  let source;
  try {
    source = readFileSync(environmentPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("无法读取本机模型配置文件。");
    source = "";
  }

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = /(?:\r\n|\n)$/u.test(source);
  const lines = source.replace(/\r\n/gu, "\n").split("\n");
  if (hadFinalNewline) lines.pop();
  let found = false;
  const nextLines = [];
  for (const line of lines) {
    const bom = line.startsWith("\uFEFF") ? "\uFEFF" : "";
    const plainLine = line.slice(bom.length);
    if (/^\s*QQBOT_LLM_API_KEY\s*=/u.test(plainLine)) {
      if (!found && normalizedKey !== null) {
        const leadingWhitespace = plainLine.match(/^\s*/u)?.[0] ?? "";
        nextLines.push(`${bom}${leadingWhitespace}QQBOT_LLM_API_KEY=${normalizedKey}`);
      }
      found = true;
      continue;
    }
    nextLines.push(line);
  }
  let finalNewline = hadFinalNewline;
  if (normalizedKey !== null && !found) {
    nextLines.push(`QQBOT_LLM_API_KEY=${normalizedKey}`);
    finalNewline = true;
  }

  const tempPath = `${environmentPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, `${nextLines.join(newline)}${finalNewline ? newline : ""}`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, environmentPath);
  } catch {
    try { unlinkSync(tempPath); } catch {}
    throw new Error("无法安全保存本机模型配置。");
  }

  if (normalizedKey === null) delete process.env.QQBOT_LLM_API_KEY;
  else process.env.QQBOT_LLM_API_KEY = normalizedKey;
  return Boolean(normalizedKey);
}
