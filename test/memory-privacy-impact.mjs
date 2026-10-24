// Captures production requests with synthetic scoped grants. No real data,
// model endpoint, QQ connection or browser is used.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
const root=fileURLToPath(new URL('../',import.meta.url));
const fixture=await mkdtemp(join(root,'.local','memory-impact-'));
await mkdir(join(fixture,'src'));
for(const name of await readdir(join(root,'src')))if(name.endsWith('.js'))await copyFile(join(root,'src',name),join(fixture,'src',name));
await writeFile(join(fixture,'package.json'),JSON.stringify({type:'module',private:true}));
for(const name of Object.keys(process.env))if(/proxy/i.test(name)||name.startsWith('FEIYU_DESKTOP_'))delete process.env[name];
process.env.QQBOT_LLM_API_KEY='isolated-memory-audit-only';process.env.SERPER_API_KEY='';process.env.TAVILY_API_KEY='';
const load=name=>import(pathToFileURL(join(fixture,'src',name)).href);
const config=await load('llm-settings-store.js'),access=await load('access-control-store.js'),personas=await load('group-personas.js');
const G='800000091',G2='800000092',U='900000091',V='900000092';
const defaultMemory='合成默认常识：泡泡节是大家交换贝壳的虚构活动，口号是一起吹泡泡。';
const groupMemory='珊瑚集市约定周三分享自己画的贝壳图案，祝语是珊瑚常在。';
const fact='偏爱用纸折出各种合成小鲸鱼造型';
const knowledgeText='合成泡泡节活动规则是把纸鲸鱼放在蓝色圆桌上。';
const base={...config.DEFAULT_LLM_SETTINGS,apiEndpoint:'https://memory-impact.invalid/v1/chat/completions',model:'synthetic-memory-audit',
  memory:defaultMemory,systemPrompt:'合成助手，只按可用材料回答。',personality:'合成助手',expressionStyle:'简短',
  knowledgeEnabled:true,searchEnabled:false,videoUnderstandingEnabled:false,characterRecognitionEnabled:false,stickersEnabled:false,
  contentSummaryEnabled:false,detailedDiscussionEnabled:false,proactiveChatEnabled:false,memberImpressionsEnabled:true};
config.writeLlmSettings(base);access.writeAccessControl({groupIds:[G,G2],userIds:[U,V]});
const [profile]=personas.ensureGroupPersonas([G],base);
personas.saveGroupPersona(G,{...profile,memory:groupMemory},profile.revision,[G]);
const members=await load('member-impressions.js'),kb=await load('knowledge-base.js'),privacy=await load('privacy-boundary.js');
members.saveMemberImpression(G,U,{name:'合成成员',enabled:true,learningEnabled:true,facts:[{
  id:'10000000-0000-4000-8000-000000000091',kind:'interest',topic:'折纸',content:fact,tags:['折纸','鲸鱼'],enabled:true,reviewStatus:'approved',
}]},members.readMemberImpressions(G).revision);
kb.writeKnowledgeEntries([{id:'synthetic-bubble-rule',title:'合成泡泡节',content:knowledgeText,tags:['合成泡泡节','活动规则'],enabled:true,groupId:G}]);
assert(members.memberImpressionContext(G,U,'你记得我的折纸兴趣吗').includes(fact),'The underlying store/selector still works');
const captures=[];let output='合成检查完成。';const checks=[];
globalThis.fetch=async(url,options)=>{assert.equal(String(url),base.apiEndpoint);captures.push(JSON.parse(options.body));return Response.json({choices:[{finish_reason:'stop',message:{content:output}}]});};
const llm=await load('llm.js');
const store=await load('sticker-store.js'),fold=await load('long-reply.js');
const ask=async(groupId=G,senderQQId=U)=>llm.getLlmReply({apiKey:process.env.QQBOT_LLM_API_KEY,settings:config.readLlmSettings(),userId:groupId?'group:'+groupId:'private:'+senderQQId,
  ...(groupId?{groupId}:{}),senderQQId,queued:true,userMessage:groupId?'本群合成泡泡节活动规则是什么，你记得我的折纸兴趣吗':'合成默认常识里的活动口号是什么'});
const lastPrompt=()=>JSON.stringify(captures.at(-1).messages);
const currentProfile=()=>personas.ensureGroupPersonas([G],config.readLlmSettings())[0];
const grantGroup=enabled=>{const p=currentProfile();personas.saveGroupPersona(G,{...p,memoryReplyEnabled:enabled},p.revision,[G]);};
const grantFact=enabled=>{const data=members.readMemberImpressions(G),p=data.members.find(m=>m.userId===U);members.saveMemberImpression(G,U,{...p,facts:p.facts.map(f=>({...f,replyAllowed:enabled}))},data.revision);};
try {
  await ask();
  const groupPrompt=JSON.stringify(captures.at(-1).messages);
  assert(!groupPrompt.includes(groupMemory));assert(!groupPrompt.includes(fact));assert(groupPrompt.includes(knowledgeText));
  await ask(null);
  const privatePrompt=JSON.stringify(captures.at(-1).messages);assert(!privatePrompt.includes(defaultMemory));
  assert(privacy.privacyViolation(fact,privacy.runtimePrivacyBoundary()),'Even the owner fact is globally protected');
  assert(privacy.privacyViolation(groupMemory,privacy.runtimePrivacyBoundary()),'Nonpersonal group memory is globally protected too');
  checks.push('legacy records remain protected until an explicit grant; ordinary scoped knowledge is retained');
  grantGroup(true);grantFact(true);config.writeLlmSettings({...config.readLlmSettings(),memoryReplyUserIds:[U]});
  output=groupMemory+' '+fact;const permitted=await ask();
  assert(lastPrompt().includes(groupMemory));assert(lastPrompt().includes(fact));assert(!lastPrompt().includes(defaultMemory));assert.equal(permitted.reply,output);
  assert(!privacy.protectOutbound('send_msg',{message_type:'group',group_id:G,message:output}).blocked);
  let delivered='';await store.sendLlmResult(permitted,{message_type:'group',group_id:G},async(_a,p)=>{delivered=p.message;return{message_id:'synthetic'}});
  assert.equal(delivered,output);checks.push('approved current-member fact and group memory reach actual model request, result and production send path');
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const bridge=(await load('onebot.js')).createOneBotBridge({port,path:'/isolated-memory',accessToken:'synthetic-memory-only'});await bridge.start();
  const ws=new WebSocket(`ws://127.0.0.1:${port}/isolated-memory`,{headers:{authorization:'Bearer synthetic-memory-only'}});await once(ws,'open');
  try {
    for(const [params,blocked]of[
      [{message_type:'group',group_id:G,message:output},false],[{message_type:'group',group_id:G2,message:output},true],
      [{message_type:'private',user_id:U,message:defaultMemory},false],[{message_type:'private',user_id:V,message:defaultMemory},true],
    ]){
      const packet=once(ws,'message'),pending=bridge.sendMessage('send_msg',{...params,auto_escape:true});
      const [bytes]=await packet,value=JSON.parse(bytes.toString());assert.equal(value.params.message,blocked?privacy.privateReplyNotice:params.message);
      ws.send(JSON.stringify({status:'ok',retcode:0,echo:value.echo,data:{message_id:'synthetic-receipt'}}));assert.equal(Boolean((await pending).privacyBlocked),blocked);
    }
  } finally {ws.close();await bridge.close();}
  checks.push('actual local OneBot WebSocket applies destination-specific permissions on the wire');
  await ask(G,V);assert(lastPrompt().includes(groupMemory));assert(!lastPrompt().includes(fact));checks.push('another member does not receive the subject member recall prompt');
  output='合成检查完成。';await ask(G2);assert(!lastPrompt().includes(groupMemory));assert(!lastPrompt().includes(fact));assert(!lastPrompt().includes(defaultMemory));
  assert(privacy.protectOutbound('send_msg',{message_type:'group',group_id:G2,message:groupMemory+' '+fact}).blocked);checks.push('another group cannot retrieve or send the granted source-group material');
  output=defaultMemory;const ownPrivate=await ask(null,U);assert(lastPrompt().includes(defaultMemory));assert(!lastPrompt().includes(groupMemory));assert(!lastPrompt().includes(fact));assert.equal(ownPrivate.reply,defaultMemory);
  assert(!privacy.protectOutbound('send_msg',{message_type:'private',user_id:U,message:defaultMemory}).blocked);checks.push('explicit private recipient receives default memory without group/member facts');
  output='合成检查完成。';await ask(null,V);assert(!lastPrompt().includes(defaultMemory));
  assert(privacy.protectOutbound('send_msg',{message_type:'private',user_id:V,message:defaultMemory}).blocked);checks.push('another private recipient cannot retrieve or send the owner memory');
  const p=currentProfile();personas.saveGroupPersona(G,{...p,memory:p.memory+'饲养员账号991119999，内部身份不得公开。'},p.revision,[G]);
  assert.equal(currentProfile().memoryReplyEnabled,false,'Editing stored memory invalidates its previous grant');grantGroup(true);
  await ask();assert(!lastPrompt().includes('991119999'));assert(lastPrompt().includes(groupMemory));
  assert(privacy.protectOutbound('send_msg',{message_type:'group',group_id:G,message:'991119999'}).blocked);checks.push('group-use grant never publishes internal identity or account numbers');
  grantGroup(false);grantFact(false);config.writeLlmSettings({...config.readLlmSettings(),memoryReplyUserIds:[]});
  delivered=null;
  const cancelled=await store.sendLlmResult(permitted,{message_type:'group',group_id:G},async(_a,p)=>{delivered=p.message;return{message_id:'synthetic'}});
  assert.equal(cancelled,false);assert.equal(delivered,null);checks.push('revocation before sending cancels a previously generated permitted result before transport');
  const forward=fold.buildLongReply({message_type:'group',group_id:G,message:groupMemory+'\n'+fact,auto_escape:true,foldLongReply:true},{selfId:'700000091',settings:{longReplyThreshold:100}});
  assert(forward);assert(privacy.protectOutbound(forward.action,forward.params).blocked);checks.push('revoked material is blocked across actual folded forward nodes');
  output=fact;const revoked=await ask();assert(!lastPrompt().includes(fact));assert(!lastPrompt().includes(groupMemory));assert.equal(revoked.status,'privacy-blocked');checks.push('revocation removes recall and blocks stale model repetition');
  grantFact(true);const memberFile=join(fixture,'data','member-impressions.json'),raw=JSON.parse(await readFile(memberFile,'utf8'));
  raw.groups[G].members[U].facts[0].content='偏爱把合成纸船折成不一样的造型';await writeFile(memberFile,JSON.stringify(raw));
  assert.equal(members.memberImpressionContext(G,U,'你记得我吗',{replyOnly:true}),null);checks.push('fact content changes invalidate an earlier content-bound grant');
  assert.throws(()=>config.normalizeLlmSettings({...base,memoryReplyUserIds:['not-a-numeric-id']}));checks.push('malformed scope grants rejected by production settings validator');
  const report={at:new Date().toISOString(),fixture,level:'isolated-production-request-capture',checks,modelCalls:captures.length,realExternalCalls:0,realQqSends:0,
    caveat:'Synthetic permissions and facts; external model and QQ receipts mocked. No production grants changed. Legacy grants stay off.'};
  await writeFile(join(fixture,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:checks.length,total:checks.length,conditionalRecallRestored:true,legacyGrantsRemainOff:true,report:join(fixture,'report.json')}));
} finally {await(await load('model-transport.js')).closeModelConnections();}
