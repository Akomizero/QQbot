import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const storePath = resolve(projectRoot, "data", "access-control.json");

export const DEFAULT_ACCESS_CONTROL = {
  userIds: [],
  groupIds: [],
};

function ensureStoreDirectory() {
  mkdirSync(dirname(storePath), { recursive: true });
}

function normalizeIds(ids, label) {
  if (!Array.isArray(ids)) throw new Error(`${label}必须是数组。`);
  const normalized = [];
  const seen = new Set();

  for (const rawId of ids) {
    if (typeof rawId !== "string") throw new Error(`${label}只能包含数字 ID。`);
    const id = rawId.trim();
    if (!/^\d{1,32}$/u.test(id)) throw new Error(`${label}包含无效 ID，请填写非空数字。`);
    if (!seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }

  return normalized;
}

function normalizeAccessControl(accessControl) {
  if (!accessControl || typeof accessControl !== "object" || Array.isArray(accessControl)) {
    throw new Error("接收白名单格式不正确。");
  }

  return {
    userIds: normalizeIds(accessControl.userIds, "允许好友私聊的 QQ 号"),
    groupIds: normalizeIds(accessControl.groupIds, "群号"),
  };
}

export function readAccessControl() {
  ensureStoreDirectory();
  let content;
  try {
    content = readFileSync(storePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return writeAccessControl(DEFAULT_ACCESS_CONTROL);
  }

  const parsed = JSON.parse(content);
  if (parsed?.version !== 1) throw new Error("接收白名单版本不受支持，请检查 data/access-control.json。");
  return normalizeAccessControl(parsed.accessControl);
}

export function writeAccessControl(accessControl) {
  const normalized = normalizeAccessControl(accessControl);
  ensureStoreDirectory();
  const tempPath = `${storePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ version: 1, accessControl: normalized }, null, 2)}\n`, "utf8");
  renameSync(tempPath, storePath);
  return normalized;
}
