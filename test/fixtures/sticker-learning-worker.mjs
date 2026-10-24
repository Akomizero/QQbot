import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const [root, phase] = process.argv.slice(2);
assert(root && phase);
const load = name => import(pathToFileURL(join(root, 'src', name)).href);
const G1 = '800000081', G2 = '800000082';
let modelCalls = 0;
// Only the external model boundary is replaced; the production review parser,
// trust branding, learning quotas, image processing, stores and send code run.
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'https://sticker-fixture.invalid/v1/chat/completions', 'No real network is permitted');
  modelCalls++;
  const request = JSON.parse(options.body);
  assert(request.messages[1].content.some(p => p.type === 'image_url' && p.image_url.url.startsWith('data:image/jpeg;base64,')));
  const rejected = phase === 'reject';
  return Response.json({ choices: [{ message: { content: JSON.stringify({
    allowed: !rejected, reusable: !rejected, category: rejected ? 'private' : 'ok',
    title: phase === 'learn-B' ? '合成方块' : '合成圆点', tags: ['合成', '问候'],
    usage: '普通合成问候时表达友好', avoid: '严肃求助时避免使用',
  }) } }] });
};
const image = async color => sharp({ create: { width: 40, height: 40, channels: 3, background: color } }).png().toBuffer();
const settings = await load('llm-settings-store.js');
const access = await load('access-control-store.js');
if (phase === 'learn-A') {
  settings.writeLlmSettings({ ...settings.DEFAULT_LLM_SETTINGS, apiEndpoint: 'https://sticker-fixture.invalid/v1/chat/completions', model: 'synthetic-review',
    memory: '', systemPrompt: '合成验收助手', personality: '合成助手', expressionStyle: '简短',
    stickersEnabled: true, stickerLearningEnabled: true, visionEnabled: true });
  access.writeAccessControl({ groupIds: [G1, G2], userIds: [] });
}
const store = await load('sticker-store.js');
const learning = await load('sticker-learning.js');
const prefs = await load('sticker-preferences.js');
const transport = await load('model-transport.js');
const idsFile = join(root, 'synthetic-ids.json');
let ids = {}; try { ids = JSON.parse(await readFile(idsFile, 'utf8')); } catch {}
let sends = 0, imageSends = 0, guarded = 0;
const send = async (action, params, guard) => {
  assert.equal(action, 'send_msg'); assert.equal(params.message_type, 'group');
  assert([G1, G2].includes(params.group_id));
  if (guard) { assert.equal(guard(), true); guarded++; }
  const part = Array.isArray(params.message) && params.message.find(p => p.type === 'image');
  if (part) { const bytes = Buffer.from(part.data.file.slice('base64://'.length), 'base64'); assert.equal((await sharp(bytes).metadata()).width, 40); imageSends++; }
  sends++;
  return { message_id: 'synthetic-local-receipt' };
};
const sendSticker = (id, group = G1, handler = send) => store.sendLlmResult({ reply: '合成验收回复', stickerId: id }, { message_type: 'group', group_id: group }, handler);
let checks = [];
try {
  if (phase === 'learn-A') {
    assert.equal(store.listStickers().length, 0);
    const bytes = await image('#3498db');
    assert.equal(await learning.learnIncomingStickers({ groupId: G1, images: [{ stickerCandidate: true, sourceBytes: bytes }] }), 1);
    const [entry] = store.listStickers();
    assert.equal(entry.reviewStatus, 'approved'); assert.equal(entry.needsDescription, false); assert(entry.usage.includes('问候'));
    assert.equal(entry.groupId, G1); assert.equal(entry.sourceHash, createHash('sha256').update(bytes).digest('hex'));
    const persisted = store.readSticker(entry.id, { approvedOnly: true, enabledOnly: true }); assert(persisted.bytes.equals(bytes));
    ids.A = entry.id; await writeFile(idsFile, JSON.stringify(ids));
    assert.equal(learning.stickerLearningStatus().find(s => s.groupId === G1).last.code, 'saved');
    assert.equal(modelCalls, 1);
    checks = ['production learning entry', 'real review parser and trust object', 'real image and metadata files', 'description and saved observation'];
  } else if (phase === 'send-A') {
    assert.equal(store.listStickers().length, 1);
    assert(store.stickerChoices('group:' + G1).some(s => s.id === ids.A));
    assert.equal(store.stickerChoices('group:' + G2).length, 0);
    assert.equal(store.stickerChoices('private:900000081').length, 0);
    await sendSticker(ids.A); assert.equal(imageSends, 1); assert.equal(guarded, 1);
    const recent = prefs.readStickerPreferences(G1).recent;
    assert.equal(recent.length, 1); assert.equal(recent[0].id, ids.A); assert(/^[a-f\d]{64}$/.test(recent[0].contentHash));
    checks = ['new process production store read', 'source-group isolation', 'production selection', 'simulated receipt writes actual preference file'];
  } else if (phase === 'learn-B') {
    assert(!store.stickerChoices('group:' + G1).some(s => s.id === ids.A), 'new process must read prior successful send');
    await sendSticker(ids.A); assert.equal(imageSends, 0);
    assert.equal(prefs.readStickerPreferences(G1).recent.length, 1);
    const previous = prefs.readStickerPreferences(G1).recent.at(-1).at;
    Date.now = () => previous + 3 * 60_000;
    assert.equal(await learning.learnIncomingStickers({ groupId: G1, images: [{ stickerCandidate: true, sourceBytes: await image('#f39c12') }] }), 1);
    ids.B = store.listStickers().find(s => s.id !== ids.A).id; await writeFile(idsFile, JSON.stringify(ids));
    assert(store.stickerChoices('group:' + G1).some(s => s.id === ids.B));
    await sendSticker(ids.B); assert.equal(imageSends, 1);
    assert.deepEqual(prefs.readStickerPreferences(G1).recent.map(s => s.id), [ids.A, ids.B]);
    assert.equal(modelCalls, 1);
    checks = ['cross-process anti-repeat reads actual persisted file', 'real second learning after cooldown', 'newly learned choice', 'second actual success history write'];
  } else if (phase === 'restart-dedup') {
    const before = prefs.readStickerPreferences(G1).recent;
    assert.deepEqual(before.map(s => s.id), [ids.A, ids.B]);
    Date.now = () => before.at(-1).at + 11 * 60_000;
    const choices = store.stickerChoices('group:' + G1);
    assert(choices.some(s => s.id === ids.A)); assert(!choices.some(s => s.id === ids.B));
    await sendSticker(ids.B); assert.equal(imageSends, 0);
    await assert.rejects(sendSticker(ids.A, G1, async () => { throw Error('synthetic send failure'); }));
    assert.deepEqual(prefs.readStickerPreferences(G1).recent, before);
    await sendSticker(ids.A); assert.equal(imageSends, 1);
    assert.equal(prefs.readStickerPreferences(G1).recent.at(-1).id, ids.A);
    checks = ['another real process restart', 'last content blocked beyond ten minutes', 'older relevant choice returns', 'failed receipt does not write, retry succeeds'];
  } else if (phase === 'group-isolation') {
    const before = prefs.readStickerPreferences(G1).recent;
    assert.equal(await learning.learnIncomingStickers({ groupId: G2, images: [{ stickerCandidate: true, sourceBytes: await image('#3498db') }] }), 1);
    const entry = store.listStickers().find(s => s.groupId === G2);
    assert(entry && entry.id !== ids.A);
    assert(store.stickerChoices('group:' + G2).some(s => s.id === entry.id));
    assert(!store.stickerChoices('group:' + G1).some(s => s.id === entry.id));
    await sendSticker(entry.id, G2); assert.equal(imageSends, 1);
    assert.deepEqual(prefs.readStickerPreferences(G1).recent, before);
    assert.equal(prefs.readStickerPreferences(G2).recent.at(-1).id, entry.id);
    checks = ['same synthetic image independently learned in another group', 'group choices remain separate', 'success history remains separate'];
  } else if (phase === 'reject') {
    // A third synthetic group avoids altering production quotas or delaying.
    const G3 = '800000083'; access.writeAccessControl({groupIds:[G1,G2,G3],userIds:[]});
    const before = store.listStickers().length;
    assert.equal(await learning.learnIncomingStickers({ groupId: G3, images: [{ stickerCandidate: true, sourceBytes: await image('#222222') }] }), 0);
    assert.equal(store.listStickers().length, before);
    assert.equal(learning.stickerLearningStatus().find(s => s.groupId === G3).last.code, 'content-rejected');
    checks = ['real rejection parser prevents file insertion', 'learning rejection observation persisted'];
  } else throw Error('Unknown isolated phase');
  console.log(JSON.stringify({ phase, passed: true, pid: process.pid, modelCalls, sends, imageSends, guarded, checks }));
} finally { learning.stopStickerLearning(); await transport.closeModelConnections(); }
