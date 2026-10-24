import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import sharp from 'sharp';
const root=fileURLToPath(new URL('../',import.meta.url)),fixture=await mkdtemp(join(root,'.local','image-exchange-replay-'));
await mkdir(join(fixture,'src'));for(const name of await readdir(join(root,'src')))if(name.endsWith('.js'))await copyFile(join(root,'src',name),join(fixture,'src',name));
await writeFile(join(fixture,'package.json'),JSON.stringify({type:'module'}));
const mainFile=join(fixture,'src','main.js'),source=await readFile(mainFile,'utf8'),cut=source.lastIndexOf('\nmain().catch(');assert(cut>0);
await writeFile(mainFile,source.slice(0,cut)+'\nexport {handleMessage};\n');
const load=name=>import(pathToFileURL(join(fixture,'src',name)).href);
for(const key of Object.keys(process.env))if(/proxy/i.test(key)||key.startsWith('FEIYU_DESKTOP_'))delete process.env[key];
process.env.QQBOT_LLM_API_KEY='isolated-exchange-only';process.env.TAVILY_API_KEY='';process.env.SERPER_API_KEY='';
const config=await load('llm-settings-store.js'),access=await load('access-control-store.js');
const base={...config.DEFAULT_LLM_SETTINGS,apiEndpoint:'https://exchange-fixture.invalid/v1/chat/completions',model:'synthetic',memory:'',systemPrompt:'合成验收助手',personality:'合成助手',expressionStyle:'简短',
  stickersEnabled:true,stickerLearningEnabled:false,knowledgeEnabled:false,knowledgeLearningEnabled:false,memberImpressionsEnabled:false,memberImpressionsLearningEnabled:false,
  characterRecognitionEnabled:false,visualMemoryLearningEnabled:false,searchEnabled:false,videoUnderstandingEnabled:false,chatgptImageGenerationEnabled:false,
  contentSummaryEnabled:false,detailedDiscussionEnabled:false,proactiveChatEnabled:false,longReplyForwardEnabled:false};
config.writeLlmSettings(base);access.writeAccessControl({groupIds:['800000071','800000072'],userIds:['900000071','900000072']});
let clock=Date.now(),sequence=700000,modelCalls=0,reviewCalls=0,models=[],sent=[],events=new Map(),failure=false,reviewQueue=[];
Date.now=()=>clock;
const main=await load('main.js'),stock=await load('sticker-store.js');
const imageBytes=await sharp({create:{width:32,height:32,channels:3,background:'#2c82c9'}}).png().toBuffer();
const imageSegment={type:'image',data:{file:'0123456789ABCDEF0123456789ABCDEF.png',sub_type:1}};
const files=new Map([[imageSegment.data.file,imageBytes]]),hash=b=>createHash('sha256').update(b).digest('hex');
async function picture(color){const bytes=await sharp({create:{width:32,height:32,channels:3,background:color}}).png().toBuffer();const file=hash(bytes).slice(0,32)+'.png';files.set(file,bytes);return{segment:{type:'image',data:{file,sub_type:1}},bytes};}
globalThis.fetch=async(url,options)=>{assert.equal(String(url),base.apiEndpoint);const body=JSON.parse(options.body),review=body.messages[0]?.content?.includes('表情内容筛选器');
  if(review){reviewCalls++;const reject=reviewQueue.shift()==='reject';return Response.json({choices:[{message:{content:JSON.stringify({allowed:!reject,reusable:!reject,category:reject?'private':'ok',title:'合成小鱼',tags:['合成','问候'],usage:'友好问候时接话',avoid:'严肃任务避免'})}}]});}
  modelCalls++;const images=body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url').length;models.push({images});
  return Response.json({choices:[{finish_reason:'stop',message:{content:images?'收到，存进我的小水坑里了。':'你手里什么都没亮出来呢，好歹先发出来或者引用一下。'}}]});};
const send=async(action,params,guard)=>{if(action==='get_image')return{base64:(files.get(params.file)??imageBytes).toString('base64')};if(action==='get_group_msg_history')return{messages:[]};if(action==='get_msg')return events.get(String(params.message_id))??{};
  assert.equal(action,'send_msg');if(guard&&!guard())return{cancelled:true};if(failure&&Array.isArray(params.message)&&params.message.some(p=>p.type==='image')){failure=false;throw Error('synthetic send failed');}sent.push(params);return{message_id:String(++sequence)};};
function event(text,{scope='private',user='900000071',group='800000071',images=[],mention=false,reply}={}){clock+=11000;const e={post_type:'message',message_type:scope,sub_type:'friend',self_id:'700000071',user_id:user,message_id:String(++sequence),time:Math.floor(clock/1000),sender:{nickname:'合成成员'},message:[...(mention?[{type:'at',data:{qq:'700000071'}}]:[]),...(reply?[{type:'reply',data:{id:reply}}]:[]),...images,...(text?[{type:'text',data:{text}}]:[])]};if(scope==='group')e.group_id=group;events.set(e.message_id,e);return e;}
const deliver=async(text,options)=>{const e=event(text,options);await main.handleMessage(e,{sendMessage:send},{});return e;};
const imagesSent=()=>sent.flatMap(p=>Array.isArray(p.message)?p.message:[]).filter(p=>p.type==='image');
const lastImage=()=>Buffer.from(imagesSent().at(-1).data.file.slice(9),'base64');
const checks=[];
try {
  await deliver('表情包送你 你发给我回馈一下',{images:[imageSegment]});
  const first={saved:stock.listStickers().length,imagesSent:imagesSent().length,modelCalls,reviewCalls,claimedSaved:JSON.stringify(sent).includes('存进我的小水坑')};
  await deliver('回馈我一样的 我看你存了没');
  if(!process.argv.includes('--baseline')){assert.equal(first.saved,1);assert(imagesSent().length>=2);for(const p of imagesSent())assert(Buffer.from(p.data.file.slice(9),'base64').equals(imageBytes));assert(!JSON.stringify(sent).includes('什么都没亮出来'));}
  if(!process.argv.includes('--baseline')){
    checks.push('screenshot exact wording: private image gift -> real persisted collection -> no-quote follow-up -> same original bytes');
    const privateAsset=stock.listStickers()[0];assert.equal(privateAsset.origin,'private');assert.equal(privateAsset.userId,'900000071');
    for(const conversation of ['group:800000071','group:800000072','private:900000072'])assert(!stock.stickerChoices(conversation).some(s=>s.id===privateAsset.id));
    assert.equal((await load('knowledge-base.js')).readKnowledgeEntries().length,0);checks.push('private stock never enters group/other-private automatic choices or group knowledge');
    await deliver('表情包送你 你发给我回馈一下',{scope:'group',images:[imageSegment]});const orange=await picture('#f08b18');
    await deliver('路过',{scope:'group',user:'900000072'});await deliver('',{scope:'group',user:'900000072',images:[orange.segment]});
    await deliver('回馈我一样的 我看你存了没',{scope:'group'});assert(lastImage().equals(imageBytes));checks.push('group gift without @, other members interject and send different image, owner still gets own original');
    for(const options of [{scope:'group',group:'800000072',mention:true},{scope:'group',user:'900000073',mention:true}]){
      const before=imagesSent().length;await deliver('回馈我一样的 我看你存了没',options);assert.equal(imagesSent().length,before);
    }checks.push('another group or member cannot implicitly pick the original');
    let before=imagesSent().length;await deliver('表情包送你 你发给我回馈一下',{scope:'group',group:'800000072',images:[imageSegment,orange.segment]});assert.equal(imagesSent().length,before);assert(JSON.stringify(sent.at(-1)).includes('2 张'));
    await deliver('第2张',{scope:'group',group:'800000072'});assert(lastImage().equals(orange.bytes));checks.push('multiple images clarify, then ordinal follow-up selects and collects the right slot');
    const bad=await picture('#333339'),good=await picture('#42c581');reviewQueue=['reject','allow'];
    const partial=await deliver('收藏这些图',{scope:'group',group:'800000072',user:'900000074',images:[bad.segment,good.segment]});
    assert(JSON.stringify(sent.at(-1)).includes('1/2'));let rows=JSON.parse(await readFile(join(fixture,'.local','recent-image-exchanges.json'),'utf8')).entries;
    const row=rows.find(r=>r.messageId===partial.message_id);assert.equal(row.collectionState,'partial');assert.equal(row.assets.length,2);assert.equal(row.assets[0].id,null);assert.equal(row.assets[0].collectionState,'rejected');assert(row.assets[1].id);assert.equal(row.assets[1].sourceHash,hash(good.bytes));
    await deliver('把第2张原样发回来',{scope:'group',group:'800000072',user:'900000074'});assert(lastImage().equals(good.bytes));
    before=imagesSent().length;await deliver('把第1张原样发回来',{scope:'group',group:'800000072',user:'900000074'});assert.equal(imagesSent().length,before);checks.push('two-image first rejection/second success keeps source fingerprints and slots aligned, reports partial, sends only the selected safe original');
    const quoted=await deliver('表情包送你',{images:[imageSegment]});const ack=String(sequence);await deliver('原样发回来',{reply:ack});assert(lastImage().equals(imageBytes));
    before=imagesSent().length;await deliver('原样发回来',{scope:'group',group:'800000072',mention:true,reply:quoted.message_id});assert.equal(imagesSent().length,before);checks.push('quote of own collection acknowledgment resolves, cross-conversation quote does not substitute');
    failure=true;before=imagesSent().length;await deliver('表情包送你 你发给我回馈一下',{images:[imageSegment]});assert.equal(imagesSent().length,before);assert(JSON.stringify(sent.at(-1)).includes('已收藏'));
    await deliver('回馈我一样的 我看你存了没');assert(lastImage().equals(imageBytes));checks.push('failed image-send receipt does not claim delivery, saved receipt survives and retry returns same image');
    config.writeLlmSettings({...base,stickersEnabled:false});before=imagesSent().length;await deliver('刚才那张原样发回来');assert.equal(imagesSent().length,before);assert(JSON.stringify(sent.at(-1)).includes('关闭'));config.writeLlmSettings(base);checks.push('feature disabled explains current state and sends no image');
    stock.updateSticker(privateAsset.id,{enabled:false});before=imagesSent().length;await deliver('刚才那张原样发回来');assert.equal(imagesSent().length,before);assert(JSON.stringify(sent.at(-1)).includes('停用'));stock.updateSticker(privateAsset.id,{enabled:true});checks.push('disabled asset cannot be bypassed by asking for the original');
    const prefs=await load('sticker-preferences.js'),groupAsset=stock.listStickers().find(s=>s.origin==='group'&&s.groupId==='800000071'&&s.sourceHash===hash(imageBytes));
    let pref=prefs.readStickerPreferences('800000071');prefs.saveStickerPreferences('800000071',[{id:'10000000-0000-4000-8000-000000000071',kind:'sticker',value:groupAsset.id,status:'blocked'}],pref.revision);
    before=imagesSent().length;await deliver('刚才那张原样发回来',{scope:'group',mention:true});assert.equal(imagesSent().length,before);pref=prefs.readStickerPreferences('800000071');prefs.saveStickerPreferences('800000071',[],pref.revision);checks.push('explicit return bypasses recent-use dedup but still honors group blocked preference');
    await deliver('表情包送你 你发给我回馈一下',{images:[imageSegment]});before=imagesSent().length;
    await stock.sendLlmResult({reply:'普通合成配图',stickerId:privateAsset.id},{message_type:'private',user_id:'900000071'},send);assert.equal(imagesSent().length,before);
    await deliver('回馈我一样的 我看你存了没');assert.equal(imagesSent().length,before+1);checks.push('automatic image choice remains deduplicated while explicit same-image requests can repeat');
    await deliver('表情包送你',{images:[imageSegment]});clock+=181000;before=imagesSent().length;await deliver('刚才那张原样发回来');assert.equal(imagesSent().length,before);assert(JSON.stringify(sent.at(-1)).includes('过期'));checks.push('expired implicit context explains expiration rather than denying prior receipt');
    before=imagesSent().length;await deliver('原样发回来',{user:'900000072'});await deliver('',{user:'900000072',images:[imageSegment]});assert.equal(imagesSent().length,before+1);assert(lastImage().equals(imageBytes));assert(!JSON.stringify(sent.at(-1)).includes('已收藏'));checks.push('missing-source request carries a short pending relation to a later image, without inventing collection');
    const beforeStock=stock.listStickers().length;await deliver('看看这张',{user:'900000072',images:[orange.segment]});assert.equal(stock.listStickers().length,beforeStock);assert(!JSON.stringify(sent.at(-1)).includes('存进我的小水坑'));checks.push('unexecuted model collection claim is replaced by truthful application status');
    await deliver('表情包送你',{images:[imageSegment]});
    const worker=join(fixture,'restart-worker.mjs');await writeFile(worker,`import {pathToFileURL} from 'node:url';import{createHash}from'node:crypto';const root=process.argv[2],time=Number(process.argv[3])+11000;Date.now=()=>time;let modelCalls=0,imageReads=0,images=[];globalThis.fetch=async()=>{modelCalls++;throw Error('No real network');};const load=n=>import(pathToFileURL(root+'/src/'+n).href);const main=await load('main.js');await main.handleMessage({post_type:'message',message_type:'private',sub_type:'friend',self_id:'700000071',user_id:'900000071',message_id:'799999991',time:Math.floor(time/1000),message:[{type:'text',data:{text:'回馈我一样的 我看你存了没'}}]},{sendMessage:async(a,p,g)=>{if(a==='get_image'){imageReads++;throw Error('Original platform file deliberately unavailable');}if(a==='get_msg')return{};if(a!=='send_msg')throw Error('Unexpected action');if(g&&!g())return{cancelled:true};for(const s of Array.isArray(p.message)?p.message:[])if(s.type==='image')images.push(createHash('sha256').update(Buffer.from(s.data.file.slice(9),'base64')).digest('hex'));return{message_id:'799999992'};}},{});console.log(JSON.stringify({pid:process.pid,modelCalls,imageReads,images}));(await load('sticker-learning.js')).stopStickerLearning();(await load('knowledge-learning.js')).clearKnowledgeLearning();await(await load('model-transport.js')).closeModelConnections();`);
    const child=spawnSync(process.execPath,[worker,fixture,String(clock)],{cwd:fixture,env:process.env,encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(child.status,0,child.stderr);const restarted=JSON.parse(child.stdout.trim().split('\n').at(-1));assert.notEqual(restarted.pid,process.pid);assert.deepEqual(restarted.images,[hash(imageBytes)]);assert.equal(restarted.modelCalls,0);assert.equal(restarted.imageReads,0);checks.push('real new process reloads receipt and stored original, even when platform source and model are unavailable');
  }
  const result={at:new Date().toISOString(),fixture,kind:process.argv.includes('--baseline')?'pre-fix-replay':'post-fix-replay',first,after:{saved:stock.listStickers().length,imagesSent:imagesSent().length,modelCalls,reviewCalls},modelImageCounts:models.map(m=>m.images),checks,realExternalCalls:0,realQqSends:0};
  await writeFile(join(fixture,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{(await load('knowledge-learning.js')).clearKnowledgeLearning();(await load('sticker-learning.js')).stopStickerLearning();await(await load('model-transport.js')).closeModelConnections();}
