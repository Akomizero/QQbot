// P0-03: synthetic data, production modules, fake model and local fake OneBot only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, copyFile, writeFile, readFile, unlink, utimes } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
const root=fileURLToPath(new URL('../',import.meta.url));
await mkdir(join(root,'.local'),{recursive:true});
const fixture=await mkdtemp(join(root,'.local','p0-03-memory-'));
await mkdir(join(fixture,'src'));
const sourceRoot=process.env.P0_03_SOURCE_ROOT??root;
for(const name of await readdir(join(sourceRoot,'src')))if(name.endsWith('.js'))await copyFile(join(sourceRoot,'src',name),join(fixture,'src',name));
// Expose the unchanged handler while removing only the executable startup call.
const mainPath=join(fixture,'src','main.js'),mainSource=await readFile(mainPath,'utf8'),startup=mainSource.lastIndexOf('\nmain().catch(');
assert(startup>0);await writeFile(mainPath,mainSource.slice(0,startup)+'\nexport { handleMessage };\n');
await writeFile(join(fixture,'package.json'),JSON.stringify({type:'module',private:true}));
// Hold only the external rendering adapter; production send, queue, folding and bridge stay intact.
await writeFile(join(fixture,'src','announcement-card.js'),'export async function renderSummaryImages(){await globalThis.p0RenderGate?.();return [Buffer.from("synthetic-image")];}');
for(const key of Object.keys(process.env))if(/proxy/i.test(key)||key.startsWith('FEIYU_DESKTOP_'))delete process.env[key];
process.env.QQBOT_LLM_API_KEY='synthetic-p0-03-key';process.env.SERPER_API_KEY='';process.env.TAVILY_API_KEY='';
const load=name=>import(pathToFileURL(join(fixture,'src',name)).href);
const config=await load('llm-settings-store.js'),personas=await load('group-personas.js'),members=await load('member-impressions.js');
const access=await load('access-control-store.js'),kb=await load('knowledge-base.js'),privacy=await load('privacy-boundary.js');
const llm=await load('llm.js'),store=await load('sticker-store.js'),queue=await load('reply-queue.js'),fold=await load('long-reply.js');
const G='810000031',H='810000032',U='910000031',V='910000032';
const privateMemory='合成蓝砂仪式要在玻璃圆盘上摆放三枚彩色贝壳。';
const groupMemory='合成珊瑚茶会约定用紫色纸鲸鱼装饰圆形茶盘。';
const fact='偏爱用银色纸张折出虚构的珊瑚鲸鱼模型';
const fact2='偏爱用橙色黏土制作虚构的月亮海豚模型';
const knowledge='合成星沙节的装饰顺序是蓝旗、白灯和纸贝壳。';
const fid='10000000-0000-4000-8000-000000000031';
const base={...config.DEFAULT_LLM_SETTINGS,apiEndpoint:'https://p0-03.invalid/v1/chat/completions',model:'synthetic-p0-03',
 systemPrompt:'合成测试助手。',personality:'合成测试角色',expressionStyle:'自然简短',memory:privateMemory,memoryReplyUserIds:[],
 searchEnabled:false,videoUnderstandingEnabled:false,characterRecognitionEnabled:false,stickersEnabled:false,contentSummaryEnabled:false,
 proactiveChatEnabled:false,detailedDiscussionEnabled:false,knowledgeEnabled:true,memberImpressionsEnabled:true};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const waitFor=async(promise)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Synthetic gate timed out')),5000);})]);}finally{clearTimeout(timer);}};
let captures=[],modelOutput='合成检查结束。',onFetch=async()=>{},onPacket=()=>{};
globalThis.fetch=async(url,options)=>{assert.equal(String(url),base.apiEndpoint);captures.push(JSON.parse(options.body));const response=await onFetch();return response??Response.json({choices:[{finish_reason:'stop',message:{content:modelOutput}}]});};
const profile=()=>personas.ensureGroupPersonas([G],config.readLlmSettings())[0];
const editGroup=changes=>{const p=profile();return personas.saveGroupPersona(G,{...p,...changes},p.revision,[G,H]);};
const editMember=changes=>{const d=members.readMemberImpressions(G,{maintain:false}),m=d.members.find(v=>v.userId===U);return members.saveMemberImpression(G,U,{...m,...changes},d.revision);};
const grantFact=()=>editMember({facts:[{id:fid,kind:'interest',topic:'折纸',content:fact,tags:['折纸'],enabled:true,reviewStatus:'approved',replyAllowed:true}]});
async function reset(){
 for(const name of ['llm-settings.json','group-personas.json','member-impressions.json','knowledge-base.json','access-control.json'])await unlink(join(fixture,'data',name)).catch(e=>{if(e.code!=='ENOENT')throw e;});
 config.writeLlmSettings(base);config.writeLlmSettings({...config.readLlmSettings(),memoryReplyUserIds:[U]});
 access.writeAccessControl({groupIds:[G,H],userIds:[U,V]});personas.ensureGroupPersonas([G,H],config.readLlmSettings());
 editGroup({memory:groupMemory,memoryReplyEnabled:false});editGroup({memoryReplyEnabled:true});
 members.saveMemberImpression(G,U,{name:'合成成员',enabled:true,learningEnabled:true,facts:[]},members.readMemberImpressions(G).revision);grantFact();
 kb.writeKnowledgeEntries([{id:'star-sand',title:'合成星沙节',content:knowledge,tags:['合成星沙节'],enabled:true,groupId:G}]);
 captures=[];modelOutput='合成检查结束。';onFetch=async()=>{};onPacket=()=>{};delete globalThis.p0RenderGate;
}
const ask=(groupId=G,user=U,settings=config.readLlmSettings())=>llm.getLlmReply({apiKey:process.env.QQBOT_LLM_API_KEY,settings,
 groupId,senderQQId:user,userId:groupId?'group:'+groupId:'private:'+user,queued:true,userMessage:'我的兴趣你记得吗，合成星沙节怎么布置？'});
const prompt=()=>JSON.stringify(captures.at(-1)?.messages??[]);
const dest=(groupId=G)=>({message_type:'group',group_id:groupId});
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
const bridge=(await load('onebot.js')).createOneBotBridge({port,path:'/p0-03',accessToken:'synthetic-local-p0-03'});await bridge.start();
const ws=new WebSocket(`ws://127.0.0.1:${port}/p0-03`,{headers:{authorization:'Bearer synthetic-local-p0-03'}});await once(ws,'open');
const packets=[];ws.on('message',bytes=>{const p=JSON.parse(bytes.toString());packets.push(p);onPacket(p);ws.send(JSON.stringify({status:'ok',retcode:0,echo:p.echo,data:{message_id:'synthetic-'+packets.length}}));});
const checks=[];
async function check(name,fn){try{await reset();await fn();checks.push({name,passed:true});console.log('PASS '+name);}catch(e){checks.push({name,passed:false,error:String(e.message).slice(0,240)});console.log('FAIL '+name+': '+String(e.message).slice(0,240));}}
async function queued(result,mutation,{long=false}={}){
 let now=0;const entered=deferred(),release=deferred();const c=queue.createReplyCoordinator({intervalMs:10,now:()=>now,sleep:async ms=>{entered.resolve();await release.promise;now+=ms;}});
 await c.send('send_msg',{...dest(),message:'安全队列占位。'},bridge.sendMessage);
 const start=packets.length;
 const task=store.sendLlmResult(result,dest(),(a,p,allowed)=>c.send(a,p,(qa,qp)=>long?fold.sendReplyWithFolding({...qp,foldLongReply:true},bridge.sendMessage,{settings:{longReplyForwardEnabled:true,longReplyThreshold:100},selfId:'710000031',allowed}):bridge.sendMessage(qa,qp),allowed));
 await waitFor(Promise.race([entered.promise,task.then(()=>{throw Error('Queue did not reach synthetic wait');})]));await mutation();release.resolve();await task;
 assert(!JSON.stringify(packets.slice(start)).includes(groupMemory),'queued transport disclosed stale source text');
}
try{
 await check('A scopes and repeated session switches are enforced in actual model requests',async()=>{
  await ask();assert(prompt().includes(groupMemory));assert(prompt().includes(fact));assert(prompt().includes(knowledge));
  await ask(H);assert(!prompt().includes(groupMemory)&&!prompt().includes(fact)&&!prompt().includes(knowledge)&&!prompt().includes(privateMemory));
  await ask(null,V);assert(!prompt().includes(privateMemory)&&!prompt().includes(groupMemory));
  await ask(null,U);assert(prompt().includes(privateMemory)&&!prompt().includes(groupMemory)&&!prompt().includes(fact));
  await ask(G,V);assert(!prompt().includes(fact));await ask(G,U);assert(prompt().includes(fact));
 });
 await check('B restricted private clauses remain excluded despite ordinary memory grants',async()=>{
  editGroup({memory:groupMemory+'内部身份：合成隐藏名字。QQ账号：991110031。密钥：sk-syntheticp003secretvalue。'});editGroup({memoryReplyEnabled:true});
  await ask();for(const value of ['合成隐藏名字','991110031','sk-syntheticp003secretvalue'])assert(!prompt().includes(value));
 });
 await check('B member body edits through production save invalidate inherited consent',async()=>{
  const d=members.readMemberImpressions(G),m=d.members[0];editMember({facts:m.facts.map(f=>({...f,content:fact2}))});
  assert.equal(members.memberImpressionContext(G,U,'我的兴趣你记得吗',{replyOnly:true}),null);
 });
 for(const state of ['disabled','rejected','archived','superseded','deleted'])await check('B '+state+' member facts cannot be recalled',async()=>{
  const path=join(fixture,'data','member-impressions.json'),data=JSON.parse(await readFile(path,'utf8')),m=data.groups[G].members[U];
  if(state==='deleted')m.facts=[];else if(state==='disabled')m.enabled=false;else if(state==='rejected')m.facts[0].reviewStatus='rejected';else if(state==='archived')m.facts[0].archivedAt=Date.now();else m.facts[0].supersededAt=Date.now();
  await writeFile(path,JSON.stringify(data));await ask();assert(!prompt().includes(fact));
 });
 await check('B candidate rejected archived and disabled knowledge do not enter requests',async()=>{
  for(const state of [{enabled:false},{reviewStatus:'candidate'},{reviewStatus:'rejected'},{archivedAt:Date.now()}]){
   kb.writeKnowledgeEntries([{id:'star-sand',title:'合成星沙节',content:knowledge,tags:['合成星沙节'],enabled:true,groupId:G,...state}]);await ask();assert(!prompt().includes(knowledge));
  }
 });
 await check('C stale caller settings cannot inject deleted private memory',async()=>{
  const stale=config.readLlmSettings();config.writeLlmSettings({...stale,memory:'',memoryReplyUserIds:[]});await ask(null,U,stale);assert(!prompt().includes(privateMemory));
 });
 await check('B new groups never copy private default memory into their stored profiles',async()=>{assert.equal(personas.ensureGroupPersonas([H],base)[0].memory,'');});
 await check('B configured memory edits clear inherited grants before explicit reauthorization',async()=>{
  editGroup({memory:'合成的新橙色纸船欢迎仪式。',memoryReplyEnabled:true});assert.equal(profile().memoryReplyEnabled,false);
  config.writeLlmSettings({...config.readLlmSettings(),memory:'合成新的紫色圆桌布置方法。',memoryReplyUserIds:[U]});assert.deepEqual(config.readLlmSettings().memoryReplyUserIds,[]);
 });
 await check('B stale feature settings cannot resurrect disabled recall',async()=>{
  const stale=config.readLlmSettings();config.writeLlmSettings({...stale,knowledgeEnabled:false,memberImpressionsEnabled:false});await ask(G,U,stale);assert(!prompt().includes(fact)&&!prompt().includes(knowledge));
 });
 await check('C revocation between tool rounds prevents the next model request',async()=>{
  onFetch=async()=>{editGroup({memory:'',memoryReplyEnabled:false});return Response.json({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'synthetic-tool',type:'function',function:{name:'search_meme_knowledge',arguments:'{"query":"合成星沙节"}'}}]}}]});};
  await assert.rejects(ask(),e=>e.code==='MEMORY_AUTH_CHANGED');assert.equal(captures.length,1);
 });
 await check('C deletion while model is generating invalidates stale reply',async()=>{
  modelOutput=groupMemory;onFetch=async()=>{editGroup({memory:'',memoryReplyEnabled:false});};const before=packets.length;
  try{const r=await ask();await store.sendLlmResult(r,dest(),bridge.sendMessage);}catch(e){assert(['MEMORY_AUTH_CHANGED','MEMORY_SCOPE_INVALID'].includes(e.code));}
  assert(!JSON.stringify(packets.slice(before)).includes(groupMemory));
 });
 await check('C queue delay revalidates deletion at actual OneBot send',async()=>{modelOutput=groupMemory;const r=await ask();await queued(r,()=>editGroup({memory:'',memoryReplyEnabled:false}));});
 await check('C queue delay revalidates destination whitelist revocation',async()=>{modelOutput=groupMemory;const r=await ask();await queued(r,()=>access.writeAccessControl({groupIds:[H],userIds:[U,V]}));});
 await check('A removed group cannot supply memory to a new model request or direct send',async()=>{
  access.writeAccessControl({groupIds:[H],userIds:[U,V]});await ask();assert(!prompt().includes(groupMemory)&&!prompt().includes(fact)&&!prompt().includes(knowledge));
  const before=packets.length;await bridge.sendMessage('send_group_msg',{group_id:G,message:groupMemory});assert(!JSON.stringify(packets.slice(before)).includes(groupMemory));
 });
 await check('A removed private account cannot use a retained memory grant',async()=>{access.writeAccessControl({groupIds:[G,H],userIds:[V]});await ask(null,U);assert(!prompt().includes(privateMemory));});
 await check('C folded queue delay revalidates memory body replacement',async()=>{modelOutput=groupMemory+'安全长段。'.repeat(30);const r=await ask();await queued(r,()=>editGroup({memory:'改用合成的红色海豚迎宾仪式。',memoryReplyEnabled:false}),{long:true});});
 await check('C revoke then re-enable does not revive a queued reply',async()=>{modelOutput=groupMemory;const r=await ask();await queued(r,()=>{editGroup({memoryReplyEnabled:false});editGroup({memoryReplyEnabled:true});});});
 await check('C private grant revoke and re-enable invalidates a generated result',async()=>{
  modelOutput=privateMemory;const r=await ask(null,U);config.writeLlmSettings({...config.readLlmSettings(),memoryReplyUserIds:[]});config.writeLlmSettings({...config.readLlmSettings(),memoryReplyUserIds:[U]});const before=packets.length;
  await store.sendLlmResult(r,{message_type:'private',user_id:U},bridge.sendMessage);assert.equal(packets.length,before);
 });
 await check('C knowledge disable and re-enable invalidates prior source version',async()=>{
  modelOutput=knowledge;const r=await ask();const entries=kb.readKnowledgeEntries();kb.writeKnowledgeEntries(entries.map(e=>({...e,enabled:false})));kb.writeKnowledgeEntries(entries);const before=packets.length;
  await store.sendLlmResult(r,dest(),bridge.sendMessage);assert.equal(packets.length,before);
 });
 await check('C split batch revocation after first part cancels unsent parts',async()=>{
  modelOutput='安全开头。'.repeat(450)+groupMemory;const r=await ask();const before=packets.length;
  onPacket=()=>{editGroup({memory:'',memoryReplyEnabled:false});onPacket=()=>{};};
  const c=queue.createReplyCoordinator({intervalMs:0});
  await store.sendLlmResult(r,dest(),(a,p,allowed)=>c.sendBatch(a,fold.buildDirectReplyParts(p),bridge.sendMessage,allowed));
  assert.equal(packets.length,before+1);assert(!JSON.stringify(packets.slice(before)).includes(groupMemory));
 });
 await check('C asynchronous illustrated rendering revalidates before image transport',async()=>{
  modelOutput=groupMemory;const r=await ask();r.summary={format:'illustrated',articles:[],topic:'合成主题'};
  globalThis.p0RenderGate=async()=>{editGroup({memory:'',memoryReplyEnabled:false});};const before=packets.length;
  await store.sendLlmResult(r,dest(),bridge.sendMessage);assert.equal(packets.length,before,'rendered image sent after source deletion');
 });
 await check('C generated reply cannot change destination after source deletion',async()=>{
  modelOutput=groupMemory;const r=await ask();editGroup({memory:'',memoryReplyEnabled:false});const before=packets.length;
  await store.sendLlmResult(r,dest(H),bridge.sendMessage);assert.equal(packets.length,before);
 });
 await check('C privacy cache sees equal-length writes with unchanged mtime',async()=>{
  const p=join(fixture,'data','llm-settings.json'),fixed=new Date('2030-01-01T00:00:00Z');await utimes(p,fixed,fixed);
  assert(!privacy.privacyViolation(privateMemory,privacy.runtimePrivacyBoundary({scope:'private',userId:U})));
  const raw=await readFile(p,'utf8');await writeFile(p,raw.replace(U,V));await utimes(p,fixed,fixed);
  assert(privacy.privacyViolation(privateMemory,privacy.runtimePrivacyBoundary({scope:'private',userId:U})));
 });
 await check('C stale settings write cannot overwrite newer revocation',async()=>{
  const stale=config.readLlmSettings();config.writeLlmSettings({...stale,memoryReplyUserIds:[]});
  assert.throws(()=>config.writeLlmSettings(stale,'synthetic-obsolete-revision'),e=>e.statusCode===409);assert.deepEqual(config.readLlmSettings().memoryReplyUserIds,[]);
 });
 await check('C stale group and member revisions reject concurrent writes',async()=>{
  const p=profile();editGroup({memoryReplyEnabled:false});assert.throws(()=>personas.saveGroupPersona(G,p,p.revision,[G]),e=>e.statusCode===409);
  const d=members.readMemberImpressions(G);editMember({enabled:false});assert.throws(()=>members.saveMemberImpression(G,U,d.members[0],d.revision),e=>e.statusCode===409);
 });
 await check('C authenticated HTTP settings writes reject stale consent without changing new state',async()=>{
  const auth=await load('admin-auth.js');const result=await auth.setupAdminPassword({socket:{remoteAddress:'127.0.0.1'},headers:{}},'synthetic-p0-03-password');
  let cookie;auth.setAdminSession({setHeader:(_k,v)=>cookie=v},result.record);cookie=String(cookie).split(';')[0];
  const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const webPort=s.address().port;await new Promise(r=>s.close(r));process.env.QQBOT_WEB_PORT=String(webPort);
  const web=await(await load('web.js')).startManagementServer();
  const request=(method,body,useCookie=true)=>new Promise((resolve,reject)=>{const req=httpRequest({hostname:'127.0.0.1',port:webPort,path:'/api/llm-settings',method,headers:{origin:`http://127.0.0.1:${webPort}`,'content-type':'application/json',...(useCookie?{cookie}:{})}},res=>{let data='';res.on('data',v=>data+=v);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(data)}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
  try{
   assert.equal((await request('PUT',{settings:{memoryReplyUserIds:[]}},false)).status,401);
   const old=(await request('GET')).data;assert.equal(typeof old.revision,'string');
   assert.equal((await request('PUT',{settings:{memoryReplyUserIds:[]},revision:old.revision})).status,200);
   assert.equal((await request('PUT',{settings:old.settings,revision:old.revision})).status,409);
   assert.deepEqual((await request('GET')).data.settings.memoryReplyUserIds,[]);
  }finally{await new Promise(r=>web.close(r));}
 });
 await check('C recovered reply keeps provenance through production recovery sender',async()=>{
  modelOutput=knowledge;const r=await ask();const recovery=await load('reply-recovery.js');
  const id=recovery.enqueueReplyRecovery({event:{message_id:'610000031',self_id:'710000031'},authorized:{scope:'group',groupId:G,userId:U}});
  const jobPath=join(fixture,'.local','reply-recovery',id+'.json'),job=JSON.parse(await readFile(jobPath,'utf8'));job.nextAt=Date.now()-1;await writeFile(jobPath,JSON.stringify(job));
  const before=packets.length,ran=deferred();
  const worker=recovery.startReplyRecovery({connected:()=>true,sendAction:async(a,p)=>a==='get_login_info'?{user_id:'710000031'}:bridge.sendMessage(a,p),
   run:async()=>{kb.writeKnowledgeEntries([]);ran.resolve();return r;},pace:(_a,_p,send)=>send(_a,_p)});
  try{await waitFor(ran.promise);for(let i=0;i<100;i++){const current=JSON.parse(readFileSync(jobPath,'utf8'));if(current.state==='cancelled')break;await new Promise(res=>setTimeout(res,5));}assert.equal(JSON.parse(readFileSync(jobPath,'utf8')).state,'cancelled');assert.equal(packets.length,before);}finally{worker.stop();}
 });
 await check('D valid send actions use their actual group or private destination',async()=>{
  for(const [a,p,text]of [['send_msg',{...dest()},groupMemory],['send_group_msg',{group_id:G},groupMemory],['send_private_msg',{user_id:V},privateMemory],
   ['send_group_forward_msg',{group_id:H},groupMemory],['send_private_forward_msg',{user_id:V},privateMemory]]){
   const before=packets.length;const message=a.includes('forward')?{messages:[{type:'node',data:{content:[{type:'text',data:{text}}]}}]}:{message:text};
   await bridge.sendMessage(a,{...p,...message});const bytes=JSON.stringify(packets.slice(before));if(p.group_id===G)assert(bytes.includes(text));else assert(!bytes.includes(text));
  }
 });
 for(const [name,a,p]of [
  ['private-action-group-field','send_private_msg',{user_id:V,group_id:G,message:groupMemory}],
  ['private-action-group-type','send_private_msg',{user_id:V,message_type:'group',group_id:G,message:groupMemory}],
  ['missing-target','send_msg',{message_type:'group',message:'普通消息。'}],
  ['double-target','send_msg',{message_type:'group',group_id:G,user_id:V,message:'普通消息。'}],
  ['invalid-target','send_group_forward_msg',{group_id:'not-numeric',messages:[]}],
 ])await check('D ambiguous destination '+name+' fails before transport',async()=>{
  const before=packets.length;await assert.rejects(bridge.sendMessage(a,p),e=>e.code==='INVALID_SEND_DESTINATION');assert.equal(packets.length,before);
 });
 await check('D forward coordinator applies denied authorization guard',async()=>{
  let calls=0;const c=queue.createReplyCoordinator();const r=await c.send('send_group_forward_msg',{group_id:G,messages:[]},async()=>{calls++;},()=>false);assert.equal(calls,0);assert.equal(r.cancelled,true);
 });
 await check('D unapproved short fact stays protected at final transmission',async()=>{
  editMember({facts:[{id:fid,kind:'interest',topic:'折纸',content:'喜欢纸鲸鱼',tags:['折纸'],enabled:false,reviewStatus:'candidate',replyAllowed:false}]});
  const before=packets.length;await bridge.sendMessage('send_msg',{...dest(),message:'喜欢纸鲸鱼'});assert(!JSON.stringify(packets.slice(before)).includes('喜欢纸鲸鱼'));
 });
 await check('D malformed authorization stores fail closed before transport',async()=>{
  await writeFile(join(fixture,'data','member-impressions.json'),JSON.stringify({version:1,groups:[]}));const before=packets.length;
  await bridge.sendMessage('send_msg',{...dest(),message:'普通安全文本。'});assert.equal(packets.at(-1).params.message,privacy.privateReplyNotice);assert.equal(packets.length,before+1);
 });
 await check('C proactive main handler preserves authorization through delayed transport',async()=>{
  config.writeLlmSettings({...config.readLlmSettings(),proactiveChatEnabled:true,knowledgeLearningEnabled:false,memberImpressionsLearningEnabled:false});
  const main=await load('main.js'),entered=deferred(),release=deferred(),finished=deferred();modelOutput=groupMemory;const before=packets.length;
  const nativeTimeout=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms===8000?0:ms,...args);
  const send=async(a,p)=>{if(a==='get_group_msg_history')return{messages:[]};if(a==='get_msg')return{message:[]};if(a==='send_msg'){entered.resolve();await release.promise;try{return await bridge.sendMessage(a,p);}finally{finished.resolve();}}throw Error('Unexpected synthetic proactive action');};
  try{
   await main.handleMessage({post_type:'message',message_type:'group',group_id:G,user_id:U,self_id:'710000031',message_id:'610000032',sender:{nickname:'合成成员'},message:[{type:'text',data:{text:'今天合成星沙节的摆放方式挺有意思'}}]}, {sendMessage:send},{});
   await waitFor(entered.promise);editGroup({memory:'',memoryReplyEnabled:false});release.resolve();await waitFor(finished.promise);assert.equal(packets.length,before);
  }finally{release.resolve();globalThis.setTimeout=nativeTimeout;config.writeLlmSettings({...config.readLlmSettings(),proactiveChatEnabled:false});}
 });
 await check('A invalid group identifiers cannot inherit private memory',async()=>{await assert.rejects(ask('invalid-group'),e=>e.code==='MEMORY_SCOPE_INVALID');assert.equal(captures.length,0);});
}finally{ws.close();await bridge.close();await(await load('model-transport.js')).closeModelConnections();}
const report={level:'isolated-production-paths',checks,passed:checks.filter(x=>x.passed).length,failed:checks.filter(x=>!x.passed).length,realQqSends:0,externalModelCalls:0};
await writeFile(join(fixture,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,failed:report.failed,fixture}));
if(report.failed)process.exitCode=1;
