import test from "node:test";
import assert from "node:assert/strict";
import { stickerLearningCapacity, recentStickerAllows, stickerGroupLimit } from "../src/sticker-policy.js";
import { sendLlmResult } from "../src/sticker-store.js";
const A = { id: "10000000-0000-4000-8000-000000000001", enabled: true, reviewStatus: "approved", reviewHash: "a".repeat(64), title: "合成A", tags: [], usage: "合成场景", bytes: Buffer.from("synthetic-image-A") };
const B = { ...A, id: "10000000-0000-4000-8000-000000000002", reviewHash: "b".repeat(64), bytes: Buffer.from("synthetic-image-B") };
function fixture(stock = [A]) {
  const scopes = new Map(), writes = [];
  const services = { choices: scope => stock.filter(e => recentStickerAllows(e, scopes.get(scope.startsWith("group:") ? scope.slice(6) : scope) ?? [])), read: id => stock.find(e => e.id === id), list: () => stock,
    policy: (entry, scope) => recentStickerAllows(entry, scopes.get(scope) ?? []),
    record: (scope, id, contentHash) => { const events = [...scopes.get(scope) ?? [], { id, contentHash, at: Date.now() }]; scopes.set(scope, events); writes.push({ scope, id }); } };
  return { services, scopes, writes, stock };
}
const destination = group => ({ message_type: "group", group_id: group });
const hasImage = params => Array.isArray(params.message) && params.message.some(e => e.type === "image");
test("one-candidate pool uses text after a successful use instead of repeating", async () => {
  const f = fixture(), sent = []; const send = async (_a, p) => { sent.push(p); return { message_id: "synthetic" }; };
  await sendLlmResult({ reply: "合成回复", stickerId: A.id }, destination("800000011"), send, f);
  await sendLlmResult({ reply: "继续合成回复", stickerId: A.id }, destination("800000011"), send, f);
  assert(hasImage(sent[0])); assert(!hasImage(sent[1])); assert.equal(f.writes.length, 1);
});
test("multiple relevant candidates can alternate and a newly learned candidate is usable", async () => {
  const f = fixture([A]), sent = []; const send = async (_a, p) => { sent.push(p); return {}; };
  await sendLlmResult({ reply: "合成回复", stickerId: A.id }, destination("800000012"), send, f);
  f.stock.push(B); await sendLlmResult({ reply: "新的合成回复", stickerId: B.id }, destination("800000012"), send, f);
  assert(sent.every(hasImage)); assert.deepEqual(f.writes.map(w => w.id), [A.id, B.id]);
});
test("failed sends do not create successful-use history and allow a safe retry", async () => {
  const f = fixture(); await assert.rejects(sendLlmResult({ reply: "合成回复", stickerId: A.id }, destination("800000013"), async () => { throw new Error("synthetic failed"); }, f));
  assert.equal(f.writes.length, 0); let image = false; await sendLlmResult({ reply: "重试合成回复", stickerId: A.id }, destination("800000013"), async (_a, p) => { image = hasImage(p); return {}; }, f); assert(image);
});
test("concurrent in-flight requests cannot queue the same sticker twice", async () => {
  const f = fixture(), sent = []; let release;
  const first = sendLlmResult({ reply: "合成回复", stickerId: A.id }, destination("800000014"), async (_a, p) => { sent.push(p); return new Promise(r => { release = r; }); }, f);
  await sendLlmResult({ reply: "并发合成回复", stickerId: A.id }, destination("800000014"), async (_a, p) => { sent.push(p); return {}; }, f);
  release({}); await first; assert.equal(sent.filter(hasImage).length, 1); assert.equal(f.writes.length, 1);
});
test("private chats and different groups keep separate successful-use histories", async () => {
  const f = fixture(); const send = async () => ({});
  for (const d of [destination("800000015"), destination("800000016"), { message_type: "private", user_id: "900000015" }]) await sendLlmResult({ reply: "合成回复", stickerId: A.id }, d, send, f);
  assert.deepEqual(f.writes.map(w => w.scope), ["800000015", "800000016", "private:900000015"]);
});
test("queue-time policy changes cancel a stale selected sticker", async () => {
  const f = fixture(); let cancelled = false;
  await sendLlmResult({ reply: "合成回复", stickerId: A.id }, destination("800000019"), async (_a, _p, guard) => {
    f.scopes.set("800000019", [{ id: A.id, contentHash: A.reviewHash, at: Date.now() }]); cancelled = !guard(); return { cancelled };
  }, f);
  assert(cancelled); assert.equal(f.writes.length, 0);
});
test("content-equivalent IDs and persisted history cannot bypass deduplication", () => {
  const copy = { ...A, id: B.id }; const recent = JSON.parse(JSON.stringify([{ id: A.id, at: 1, contentHash: A.reviewHash }]));
  assert(!recentStickerAllows(copy, recent)); assert(!recentStickerAllows(copy, [{ id: A.id, at: 1 }], { equivalentIds: [A.id] }));
  assert(!recentStickerAllows(A, [{ id: A.id, at: Date.now() }, { id: B.id, at: Date.now() }]));
});
test("confirmed group saturation gets five bounded slots, not unlimited learning", () => {
  const stock = Array.from({ length: 15 }, () => ({ groupId: "800000017", origin: "group", size: 100 }));
  assert(stickerLearningCapacity(stock, "800000017").allowed); assert.equal(stickerGroupLimit, 20);
  while (stock.length < 20) stock.push(stock[0]); assert.equal(stickerLearningCapacity(stock, "800000017").reason, "group-count");
  assert(!stickerLearningCapacity(Array.from({ length: 50 }, () => ({ size: 1 })), "800000018").allowed);
  assert(!stickerLearningCapacity([{ size: 60 * 1024 * 1024 }], "800000018").allowed);
});
