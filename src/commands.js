import { readCommands } from "./command-store.js";

function cleanContent(content = "") {
  return content
    .replace(/<@!?[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function formatTime() {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "full",
    timeStyle: "medium",
    timeZone: "Asia/Shanghai",
  }).format(new Date());
}

function renderReply(command, input, commands) {
  if (command.type === "echo" && !input) return `用法：${command.name} 你想让我重复的内容`;

  const values = {
    input: command.type === "echo" ? input.slice(0, 300) : input,
    time: formatTime(),
    dice: String(1 + Math.floor(Math.random() * 6)),
    commands: commands.map(({ name, aliases }) => `- ${[name, ...aliases].join(" / ")}`).join("\n"),
  };

  return command.reply.replace(/\{\{(input|time|dice|commands)\}\}/gu, (_match, key) => values[key]);
}

export function getCommandMatch(content) {
  const text = cleanContent(content);
  if (!text) return { kind: "none" };

  const prefixed = text.match(/^(?:\/|!|！)(\S+)(?:\s+([\s\S]*))?$/u);
  const commandToken = prefixed ? prefixed[1] : text.split(/\s+/u, 1)[0];
  const input = prefixed
    ? (prefixed[2] ?? "").trim()
    : text.slice(commandToken.length).trim();
  const key = commandToken.toLocaleLowerCase("zh-CN");
  const commands = readCommands();
  const command = commands.find(({ name, aliases }) =>
    [name, ...aliases].some((trigger) => trigger.toLocaleLowerCase("zh-CN") === key),
  );

  if (!command) return { kind: prefixed ? "unknown" : "none" };

  return { kind: "matched", reply: renderReply(command, input, commands) };
}

export function getCommandReply(content) {
  const result = getCommandMatch(content);
  if (result.kind === "matched") return result.reply;
  if (result.kind === "unknown") return "这个指令我还不认识。发送「帮助」查看可用指令。";
  return null;
}
