import { mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from "node:fs";

// Only identifiers, counters and times; the original stores remain authoritative.
const file = new URL("../data/memory-index.json", import.meta.url);
const validGroup = value => typeof value === "string" && /^\d{1,32}$/u.test(value);
const validEntry = value => typeof value === "string" && /^[a-zA-Z0-9_:-]{1,160}$/u.test(value);
const day = 86400_000;
function read() {
  try {
    if (statSync(file).size > 1024 * 1024) throw new Error("Memory index too large");
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data.version !== 1 || !data.groups || typeof data.groups !== "object" || Array.isArray(data.groups)) throw new Error("Memory index invalid");
    return data;
  } catch (error) { if (error.code === "ENOENT") return { version: 1, groups: {} }; throw error; }
}
function write(data) {
  const source = JSON.stringify(data);
  if (Buffer.byteLength(source) > 1024 * 1024) throw new Error("Memory index too large");
  mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
  const temp = new URL(file.href + `.${process.pid}.tmp`);
  writeFileSync(temp, source, { mode: 0o600 }); renameSync(temp, file);
}
export function memoryIndex(groupId) {
  if (!validGroup(groupId)) return { recalls: {}, maintenance: null };
  try {
    const group = read().groups[groupId] ?? { recalls: {}, maintenance: null };
    if (!group.recalls || typeof group.recalls !== "object" || Array.isArray(group.recalls)) throw new Error("Memory index invalid");
    return group;
  }
  catch { return { recalls: {}, maintenance: null, unavailable: true }; }
}
export function recordMemoryRecall(groupId, kind, ids, now = Date.now()) {
  if (!validGroup(groupId) || !["knowledge", "member"].includes(kind)) return;
  try {
    const data = read(), group = data.groups[groupId] ?? { recalls: {} };
    let changed = false;
    for (const id of [...new Set(ids)].filter(validEntry).slice(0, 10)) {
      const idKey = `${kind}:${id}`, previous = group.recalls[idKey];
      // Repeated retrievals in a single turn/minute don't inflate popularity.
      if (previous && now - previous.lastAt < 60_000) continue;
      group.recalls[idKey] = { count: Math.min(1000000, (previous?.count ?? 0) + 1), lastAt: now }; changed = true;
    }
    if (!changed) return;
    group.recalls = Object.fromEntries(Object.entries(group.recalls).filter(([, value]) => now - value.lastAt < 90 * day)
      .sort((a, b) => b[1].lastAt - a[1].lastAt).slice(0, 1000));
    data.groups[groupId] = group;
    if (Object.keys(data.groups).length <= 128) write(data);
  } catch { /* Optional popularity metadata must never prevent a reply. */ }
}
export function recordMemoryMaintenance(groupId, outcome, now = Date.now()) {
  if (!validGroup(groupId)) return;
  const data = read(), group = data.groups[groupId] ?? { recalls: {} };
  group.maintenance = { ...outcome, at: now }; data.groups[groupId] = group;
  if (Object.keys(data.groups).length > 128) throw new Error("记忆维护群数量超过存储边界。");
  write(data);
}
export function clearMemberRecall(groupId, userId) {
  if (!validGroup(groupId) || !validGroup(userId)) return;
  try {
    const data = read(), group = data.groups[groupId];
    if (!group) return;
    const prefix = `member:${userId}:`;
    group.recalls = Object.fromEntries(Object.entries(group.recalls).filter(([id]) => !id.startsWith(prefix)));
    write(data);
  } catch { /* The index holds no impression content and is never a recall source. */ }
}
export function recallScore(record, now = Date.now()) {
  if (!record || now - record.lastAt > 30 * day) return 0;
  return Math.log2(1 + record.count) / (1 + Math.max(0, now - record.lastAt) / (7 * day));
}
