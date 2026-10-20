import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const context = new AsyncLocalStorage();
const file = new URL("../.local/model-diagnostics.json", import.meta.url);
const kinds = new Set(["start", "http", "transport", "body", "json", "empty", "refusal", "truncated", "tools", "retry", "success", "failure"]);
let events = [];
try { const saved = JSON.parse(readFileSync(file, "utf8")); if (Array.isArray(saved)) events = saved.slice(-80); } catch {}
export function modelOperationId() { return context.getStore()?.id ?? randomUUID().slice(0, 8); }
export function recordModelDiagnostic(kind, values = {}) {
  if (!kinds.has(kind)) return;
  const event = { at: Date.now(), id: context.getStore()?.id ?? values.id ?? modelOperationId(), kind };
  for (const key of ["attempt", "status", "elapsedMs", "tokens"]) if (Number.isFinite(values[key])) event[key] = values[key];
  for (const key of ["code", "route", "phase", "finish"]) if (typeof values[key] === "string" && /^[a-zA-Z0-9_-]{1,60}$/u.test(values[key])) event[key] = values[key];
  events.push(event); events = events.slice(-80);
  try { mkdirSync(new URL("../.local/", import.meta.url), { recursive: true }); const temp = new URL(file.href + ".tmp"); writeFileSync(temp, JSON.stringify(events), { mode: 0o600 }); renameSync(temp, file); } catch {}
  if (kind !== "start" && kind !== "success") console.warn("模型诊断 " + JSON.stringify(event));
}
export function withModelOperation(task) {
  if (context.getStore()) return task();
  return context.run({ id: randomUUID().slice(0, 8) }, task);
}
export function readModelDiagnostics() {
  // Only fixed categories and counters are retained; never prompts, URLs or provider bodies.
  return events.slice(-40).map(({ at, id, kind, attempt, status, elapsedMs, tokens, code, route, phase, finish }) => ({ at, id, kind, attempt, status, elapsedMs, tokens, code, route, phase, finish }));
}
