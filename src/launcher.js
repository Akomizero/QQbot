import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const entryPoint = fileURLToPath(new URL("./main.js", import.meta.url));
function loadProxyEnvironmentFromFile() {
  let source;
  try {
    source = readFileSync(new URL("../.env", import.meta.url), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^\s*(HTTP_PROXY|HTTPS_PROXY|NO_PROXY)\s*=(.*)$/iu);
    if (!match) continue;
    const name = match[1].toUpperCase();
    if (process.env[name] !== undefined) continue;

    let value = match[2].trim();
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
    }
    if (value) process.env[name] = value;
  }
}

loadProxyEnvironmentFromFile();
const hasHttpProxyEnvironment = Object.keys(process.env).some((name) => {
  const normalizedName = name.toUpperCase();
  if (normalizedName !== "HTTP_PROXY" && normalizedName !== "HTTPS_PROXY") return false;
  // Only check whether a value is present; never print or retain it.
  return typeof process.env[name] === "string" && process.env[name].trim().length > 0;
});
const useProxyFlag = process.allowedNodeEnvironmentFlags.has("--use-env-proxy") && hasHttpProxyEnvironment
  ? ["--use-env-proxy"]
  : [];
const watchFlag = process.argv.slice(2).includes("--watch") ? ["--watch"] : [];
const child = spawnSync(process.execPath, [...useProxyFlag, ...watchFlag, entryPoint], {
  stdio: "inherit",
  env: process.env,
});

if (child.error) {
  console.error("启动机器人进程失败：", child.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = child.status ?? 1;
}
