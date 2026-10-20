import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const storePath = resolve(projectRoot, "data", "commands.json");
const commandTypes = new Set(["text", "time", "dice", "echo"]);

export const DEFAULT_COMMANDS = [
  {
    id: "help",
    name: "帮助",
    aliases: ["菜单", "help", "指令"],
    type: "text",
    reply: "可用指令：\n{{commands}}\n\n在群里 @机器人 后发送指令即可。",
  },
  { id: "ping", name: "ping", aliases: [], type: "text", reply: "pong 🏓" },
  { id: "time", name: "时间", aliases: ["现在几点", "time"], type: "time", reply: "现在是 {{time}}" },
  { id: "dice", name: "骰子", aliases: ["roll", "dice"], type: "dice", reply: "🎲 {{dice}}" },
  { id: "echo", name: "重复", aliases: ["echo"], type: "echo", reply: "{{input}}" },
];

function ensureStoreDirectory() {
  mkdirSync(dirname(storePath), { recursive: true });
}

function normalizeCommands(commands) {
  if (!Array.isArray(commands)) throw new Error("指令配置必须是数组。");
  if (commands.length > 100) throw new Error("最多只能保存 100 条指令。");

  const ids = new Set();
  const names = new Set();

  const normalized = commands.map((command, index) => {
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      throw new Error(`第 ${index + 1} 条指令格式不正确。`);
    }

    const { id, name, aliases, type, reply } = command;
    if (typeof id !== "string" || id.length < 1 || id.length > 100 || ids.has(id)) {
      throw new Error(`第 ${index + 1} 条指令的编号无效或重复。`);
    }
    if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 32 || /[\s/!！]/u.test(name.trim())) {
      throw new Error(`第 ${index + 1} 条指令名称不能为空，且不能包含空格、斜杠或感叹号。`);
    }
    if (!Array.isArray(aliases) || aliases.length > 20 || aliases.some((alias) => typeof alias !== "string")) {
      throw new Error(`指令“${name}”的别名格式不正确（每条最多 20 个）。`);
    }
    if (!commandTypes.has(type)) throw new Error(`指令“${name}”的响应方式无效。`);
    if (typeof reply !== "string" || reply.trim().length < 1 || reply.length > 4000) {
      throw new Error(`指令“${name}”的回复不能为空，且最多 4000 个字符。`);
    }

    const cleanAliases = aliases.map((alias) => alias.trim());
    if (cleanAliases.some((alias) => alias.length < 1 || alias.length > 32 || /[\s/!！]/u.test(alias))) {
      throw new Error(`指令“${name}”包含无效别名。别名不能有空格、斜杠或感叹号。`);
    }

    const item = { id, name: name.trim(), aliases: [...new Set(cleanAliases)], type, reply };
    ids.add(id);
    for (const trigger of [item.name, ...item.aliases]) {
      const key = trigger.toLocaleLowerCase("zh-CN");
      if (names.has(key)) throw new Error(`触发词“${trigger}”重复了，请检查指令名称和别名。`);
      names.add(key);
    }
    return item;
  });

  return normalized;
}

export function validateCommands(commands) {
  return normalizeCommands(commands);
}

export function readCommands() {
  ensureStoreDirectory();
  let content;
  try {
    content = readFileSync(storePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const defaults = normalizeCommands(DEFAULT_COMMANDS);
    writeCommands(defaults);
    return defaults;
  }

  const parsed = JSON.parse(content);
  if (parsed?.version !== 1) throw new Error("指令配置版本不受支持，请检查 data/commands.json。");
  return normalizeCommands(parsed.commands);
}

export function writeCommands(commands) {
  const normalized = normalizeCommands(commands);
  ensureStoreDirectory();
  const tempPath = `${storePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ version: 1, commands: normalized }, null, 2)}\n`, "utf8");
  renameSync(tempPath, storePath);
  return normalized;
}
