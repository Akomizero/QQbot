import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root,'.local'),{recursive:true});
const fixture = await mkdtemp(join(root,'.local','sticker-integration-'));
await mkdir(join(fixture,'src'));
const hashes = [];
for (const name of await readdir(join(root,'src'))) if (name.endsWith('.js')) {
  const source=join(root,'src',name),target=join(fixture,'src',name);await copyFile(source,target);
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(await readFile(source)),digest(await readFile(target)));
  hashes.push({name,sha256:digest(await readFile(target))});
}
await writeFile(join(fixture,'package.json'),JSON.stringify({type:'module',private:true}));
// No real .env, config, login, stock or history is copied. Child processes use
// fake credentials and their global fetch rejects every non-fixture endpoint.
const env={...process.env,QQBOT_LLM_API_KEY:'isolated-sticker-fixture-only',TAVILY_API_KEY:'',SERPER_API_KEY:'',ONEBOT_ACCESS_TOKEN:''};
for(const key of Object.keys(env)) if(/proxy/i.test(key)||key.startsWith('FEIYU_DESKTOP_'))delete env[key];
const cases=[];
for(const phase of ['learn-A','send-A','learn-B','restart-dedup','group-isolation','reject']) {
  const child=spawnSync(process.execPath,[join(root,'test','fixtures','sticker-learning-worker.mjs'),fixture,phase],{cwd:fixture,env,encoding:'utf8',timeout:30_000,windowsHide:true});
  let result;try{result=JSON.parse(child.stdout.trim());}catch{}
  assert.equal(child.status,0,`Isolated phase ${phase} failed: ${(child.stderr??'').slice(0,1500)}`);
  assert(result?.passed,`Missing phase result: ${phase}`); cases.push(result); console.log(`PASS ${phase} (${result.checks.length} assertions groups, process ${result.pid})`);
}
assert.equal(new Set(cases.map(c=>c.pid)).size,cases.length);
const report={at:new Date().toISOString(),level:'isolated-production-integration',fixture,productionSourceCopiesIdentical:true,sourceHashes:hashes,cases,
  externalModel:'mocked JSON responses; actual review parser and image conversion used',qqTransport:'simulated successful/failed receipts; no real QQ connection',
  realProductionDataReadOrWritten:false,browserUsed:false,coverageLimits:['not a real visual model accuracy test','not a live QQ incoming-event or delivery test','not proof that actual group pictures satisfy the learning candidate gate or contextual relevance']};
await writeFile(join(fixture,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:cases.length,total:cases.length,distinctProcesses:new Set(cases.map(c=>c.pid)).size,report:join(fixture,'report.json')}));
