import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import sharp from "sharp";

// Isolated synthetic fixture only. No production config, chat history or keys.
const root=fileURLToPath(new URL("../",import.meta.url));
await mkdir(join(root,".local"),{recursive:true});
const fixture=await mkdtemp(join(root,".local","visual-provisional-learning-"));
await mkdir(join(fixture,"src"));
await writeFile(join(fixture,"package.json"),'{"type":"module"}');
for(const name of ["visual-memory-store.js","visual-learning.js","character-vision.js"])await copyFile(join(root,"src",name),join(fixture,"src",name));
const stub=async(name,text)=>writeFile(join(fixture,"src",name),text);
await stub("llm-settings-store.js",`export const settings={visualMemoryLearningEnabled:true,visionEnabled:true,characterRecognitionEnabled:true,searchEnabled:false,apiEndpoint:"https://synthetic.invalid",model:"synthetic"};export const readLlmSettings=()=>settings;`);
await stub("access-control-store.js",`export const readAccessControl=()=>({groupIds:["111","222"]});`);
await stub("config.js",`export const getLlmApiKey=()=>"synthetic-non-production-key";`);
await stub("group-personas.js",`export const settingsForGroup=()=>({groupPersonaRevision:"synthetic-revision"});`);
await stub("sticker-review.js",`export let rejected=false;export function setRejected(value){rejected=value;}export async function reviewStickerBytes(){if(rejected){const e=new Error("Synthetic refusal");e.rejected=true;throw e;}return {approved:true};}`);
await stub("model-transport.js",`export let failure=false,verdict={};export function setFailure(value){failure=value;}export function setVerdict(value){verdict=value;}export async function fetchModel(){if(failure)throw new Error("Synthetic unavailable");return Response.json({choices:[{message:{content:JSON.stringify({accepted:true,fictional:true,name:"测试角色甲",work:"测试作品",traits:["银色月亮发夹","蓝色条纹袖口"],...verdict})}}]});}`);
await stub("visual-verification.js",`import {readLlmSettings} from "./llm-settings-store.js";export let hold=false,calls=0;let release;export function blockVerification(){hold=true;}export function releaseVerification(){hold=false;release?.();}export async function verifyVisualCorrection(){calls++;if(hold)await new Promise(resolve=>{release=resolve});return {status:readLlmSettings().searchEnabled?"search-unavailable":"search-disabled",sources:[]};}`);
const load=name=>import(pathToFileURL(join(fixture,"src",name)).href);
const store=await load("visual-memory-store.js"),learner=await load("visual-learning.js"),config=await load("llm-settings-store.js");
const verifier=await load("visual-verification.js"),review=await load("sticker-review.js"),transport=await load("model-transport.js");
const {characterFingerprint}=await load("character-vision.js");
const nativeFetch=globalThis.fetch;globalThis.fetch=()=>{throw new Error("Network is forbidden in this fixture");};
const cases=[];
async function test(name,body){try{await body();cases.push({name,passed:true});console.log("PASS "+name);}catch(error){cases.push({name,passed:false,error:error.message});console.log("FAIL "+name+": "+error.message);}}
async function until(condition){for(let i=0;i<200;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error("Isolated learning did not reach the expected state");}
let nextId=100;
async function image(color){const bytes=await sharp({create:{width:32,height:32,channels:3,background:color}}).png().toBuffer();return {bytes,dataUrl:"data:image/png;base64,"+bytes.toString("base64")};}
const first=await image("#4682b4"),second=await image("#c64c69"),third=await image("#a08c32"),fourth=await image("#374b69");
const queue=(images,extra={})=>learner.queueVisualCorrection({groupId:"111",senderId:"333",messageId:String(++nextId),sourceMessageId:"90",text:"这个是测试作品的测试角色甲",loadImages:async()=>images.map(({dataUrl})=>({dataUrl})),...extra});
await test("search disabled still saves a usable group provisional",async()=>{
  queue([first]);await until(()=>learner.visualLearningStatus("111").queued===0);
  const item=store.readVisualMemories("111").entries.find(e=>e.name==="测试角色甲");
  assert.equal(item?.status,"provisional");assert.equal(store.usableVisualReferences("111").some(e=>e.id===item.id&&e.origin==="group-provisional"),true);
  assert.equal(store.usableVisualReferences("222").some(e=>e.id===item.id),false);assert.equal(store.readVisualMemories(null).entries.length,0);
  assert.equal(item.evidenceRefs.some(ref=>ref.correctionMessageId&&ref.sourceMessageId==="90"&&ref.senderId==="333"),true);
});
await test("provisional is usable while background verification is still waiting",async()=>{
  verifier.blockVerification();queue([second]);await until(()=>store.readVisualMemories("111").entries.length===2);
  const sha=(await characterFingerprint(second.bytes)).sha256;
  assert.equal(store.usableVisualReferences("111").some(e=>e.fingerprint.sha256===sha&&e.status==="provisional"),true);
  verifier.releaseVerification();await until(()=>learner.visualLearningStatus("111").queued===0);
});
await test("search unavailable preserves provisional rather than dropping it",async()=>{
  config.settings.searchEnabled=true;queue([third]);await until(()=>learner.visualLearningStatus("111").queued===0);
  const sha=(await characterFingerprint(third.bytes)).sha256,item=store.readVisualMemories("111").entries.find(e=>store.usableVisualReferences("111").find(r=>r.id===e.id)?.fingerprint.sha256===sha);
  assert.equal(item?.status,"provisional");assert.equal(item.verification?.status,"search-unavailable");
});
await test("ambiguous multiple images do not bind a character",async()=>{
  const before=store.readVisualMemories("111").entries.length;queue([first,second]);await until(()=>learner.visualLearningStatus("111").queued===0);
  assert.equal(store.readVisualMemories("111").entries.length,before);assert.equal(learner.visualLearningStatus("111").code,"ambiguous-image");
});
await test("rejected picture is never stored",async()=>{
  review.setRejected(true);const before=store.readVisualMemories("111").entries.length;queue([fourth]);await until(()=>learner.visualLearningStatus("111").queued===0);
  assert.equal(store.readVisualMemories("111").entries.length,before);assert.equal(learner.visualLearningStatus("111").code,"content-rejected");review.setRejected(false);
});
await test("extraction service failure does not fabricate a character memory",async()=>{
  transport.setFailure(true);const before=store.readVisualMemories("111").entries.length;queue([fourth]);await until(()=>learner.visualLearningStatus("111").queued===0);
  assert.equal(store.readVisualMemories("111").entries.length,before);assert.equal(learner.visualLearningStatus("111").code,"extraction-unavailable");transport.setFailure(false);
});
await test("non-fictional person cannot become a character memory",async()=>{
  transport.setVerdict({fictional:false});const before=store.readVisualMemories("111").entries.length;queue([fourth]);await until(()=>learner.visualLearningStatus("111").queued===0);
  assert.equal(store.readVisualMemories("111").entries.length,before);assert.equal(learner.visualLearningStatus("111").code,"no-correction");transport.setVerdict({});
});
await test("model guess absent from the explicit correction is not saved",async()=>{
  transport.setVerdict({name:"未被群友说出的猜测"});const before=store.readVisualMemories("111").entries.length;queue([fourth]);await until(()=>learner.visualLearningStatus("111").queued===0);
  assert.equal(store.readVisualMemories("111").entries.length,before);assert.equal(learner.visualLearningStatus("111").code,"no-correction");transport.setVerdict({});
});
await test("learning status contains no raw correction, picture or credential",async()=>{
  const text=await readFile(join(fixture,".local","visual-learning-state.json"),"utf8");assert.equal(/测试角色甲|data:image|synthetic-non-production-key/u.test(text),false);
});
globalThis.fetch=nativeFetch;
const result={level:"isolated-synthetic",fixture,realModelCalls:0,qqSends:0,productionWrites:0,passed:cases.filter(e=>e.passed).length,failed:cases.filter(e=>!e.passed).length,cases};
await writeFile(join(root,".local","visual-provisional-learning-results-20261022.json"),JSON.stringify(result,null,2));
console.log(JSON.stringify({passed:result.passed,failed:result.failed,realModelCalls:0,qqSends:0,productionWrites:0}));
if(result.failed)process.exitCode=1;
