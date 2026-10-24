import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';

export const privacyCounterStages = Object.freeze(['input_message','knowledge_result','model_answer','onebot_send']);
export const privacyCounterSources = Object.freeze(['member_candidate','member_approved','member_other','configured_memory','persona_sensitive','knowledge_sensitive','credential','credential_pattern','boundary_unavailable','unknown']);
const retentionHours=168, hourMs=3600_000, maxFileBytes=256*1024, maxCount=1_000_000_000;
const emptyStage=()=>({checks:0,hits:0,sources:{}});
const bounded=value=>Number.isSafeInteger(value)&&value>=0?Math.min(value,maxCount):0;
const hourOf=now=>new Date(Math.floor(now/hourMs)*hourMs).toISOString();

// Accept fixed enums and integers only. Neither the recorder nor the on-disk
// schema accepts text, identifiers, hashes, matching fragments, or model bodies.
export function createPrivacyHitCounters({file=new URL('../.local/privacy-hit-counters.json',import.meta.url),now=Date.now}={}){
  let buckets=[],loaded=false,dirty=false,timer=null,stamp=null,storage='not-started';
  function prune(){const current=Math.floor(now()/hourMs)*hourMs;buckets=buckets.filter(b=>{const at=Date.parse(b.hour);return at<=current&&at>current-retentionHours*hourMs;}).sort((a,b)=>a.hour.localeCompare(b.hour)).slice(-retentionHours);}
  function load(){
    if(dirty)return;
    try{
      const s=statSync(file);if(loaded&&stamp===s.mtimeMs)return;if(s.size>maxFileBytes)throw Error();
      const value=JSON.parse(readFileSync(file,'utf8'));if(value?.version!==1||!Array.isArray(value.buckets)||value.buckets.length>retentionHours)throw Error();
      const clean=[];
      for(const row of value.buckets){
        if(typeof row?.hour!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/u.test(row.hour)||!Number.isFinite(Date.parse(row.hour)))continue;
        if(clean.some(b=>b.hour===row.hour))continue;
        const stages={};for(const stage of privacyCounterStages){const data=row.stages?.[stage];if(!data)continue;const sources={};for(const source of privacyCounterSources){const n=bounded(data.sources?.[source]);if(n)sources[source]=n;}stages[stage]={checks:bounded(data.checks),hits:Math.min(bounded(data.hits),bounded(data.checks)),sources};}
        clean.push({hour:row.hour,stages});
      }
      buckets=clean;stamp=s.mtimeMs;storage='persisted';
    }catch(error){if(error?.code==='ENOENT'){if(!loaded)buckets=[];storage='not-started';}else{buckets=[];storage='unavailable';}}
    loaded=true;prune();
  }
  function flush(){
    if(timer){clearTimeout(timer);timer=null;}if(!dirty)return storage!=='unavailable';
    try{prune();mkdirSync(new URL('./',file),{recursive:true});const temp=new URL(file.href+'.tmp');writeFileSync(temp,JSON.stringify({version:1,retentionHours,buckets}),{mode:0o600});renameSync(temp,file);stamp=statSync(file).mtimeMs;dirty=false;storage='persisted';return true;}
    catch{storage='unavailable';return false;}
  }
  function record(stage,{hit=false,sources=[]}={}){
    if(!privacyCounterStages.includes(stage))return false;
    try{
      load();prune();const hour=hourOf(now());let bucket=buckets.find(b=>b.hour===hour);if(!bucket){bucket={hour,stages:{}};buckets.push(bucket);}const entry=bucket.stages[stage]??=emptyStage();entry.checks=Math.min(maxCount,entry.checks+1);
      if(hit===true){entry.hits=Math.min(maxCount,entry.hits+1);const selected=[...new Set(Array.isArray(sources)?sources:[])].filter(s=>privacyCounterSources.includes(s));for(const source of selected.length?selected:['unknown'])entry.sources[source]=Math.min(maxCount,(entry.sources[source]??0)+1);}
      dirty=true;if(!timer){timer=setTimeout(flush,1000);timer.unref?.();}return true;
    }catch{return false;}
  }
  function read(){
    load();prune();const totals=Object.fromEntries(privacyCounterStages.map(s=>[s,emptyStage()]));
    for(const bucket of buckets)for(const [stage,e]of Object.entries(bucket.stages)){const total=totals[stage];total.checks+=e.checks;total.hits+=e.hits;for(const [source,n]of Object.entries(e.sources))total.sources[source]=(total.sources[source]??0)+n;}
    return{version:1,retentionHours,timeZone:'UTC',counting:'stage-check-invocations',storage:dirty&&storage!=='unavailable'?'pending':storage,totals,buckets:JSON.parse(JSON.stringify(buckets))};
  }
  return{record,read,flush};
}
const counters=createPrivacyHitCounters();
export const recordPrivacyHit=(stage,values)=>counters.record(stage,values);
export const readPrivacyHitCounters=()=>counters.read();
export const flushPrivacyHitCounters=()=>counters.flush();
process.once('exit',()=>counters.flush());
