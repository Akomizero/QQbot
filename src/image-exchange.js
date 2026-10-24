import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { isNapCatImageFile, MAX_IMAGE_COUNT } from './image-input.js';
import { messageReferences } from './message-context.js';
import { groupMemberContextSince } from './member-impressions.js';
const file=new URL('../.local/recent-image-exchanges.json',import.meta.url),ttl=180_000,quoteTtl=900_000;
const id=v=>/^-?\d{1,32}$/u.test(String(v??''));
export function isStickerCollectionRequest(text) {
  return /(?:表情(?:包)?(?:送|给)你|给你(?:当|做|作|用作)?(?:个|一张|一些)?表情包?|(?:这张|这个).{0,8}(?:当|做).{0,4}表情|(?:收藏|保存|收下|学会|添加).{0,12}(?:表情包?|这张(?:图)?|这(?:个|些)图))/u.test(text??'');
}
export function isExactImageReturnRequest(text) {
  return /(?:原样|原图|同一张|一样的?|刚才那(?:张|个)|上一张|那张).{0,18}(?:发|回|给)|(?:发|回|给|回馈|返).{0,18}(?:一样|同一张|刚才那张|上一张|原图|原样)|看你(?:存|收).{0,5}没|(?:存|收).{0,4}没.{0,8}(?:看|发|回)/u.test(text??'')
    ||isStickerCollectionRequest(text)&&/(?:发给我|回馈|发回来|回我)/u.test(text??'');
}
function same(row,c){return row.scope===c.scope&&row.userId===String(c.userId)&&row.groupId===(c.scope==='group'?String(c.groupId):null);}
function cutoff(c){try{return c.scope==='group'?Math.max(c.since||0,groupMemberContextSince(String(c.groupId))):0;}catch{return Infinity;}}
function read(now=Date.now()){
  try{const source=readFileSync(file,'utf8');if(source.length>800_000)return[];const data=JSON.parse(source);if(data.version!==1||!Array.isArray(data.entries))return[];
    return data.entries.filter(r=>['group','private'].includes(r.scope)&&id(r.userId)&&id(r.messageId)&&Number.isFinite(r.at)&&r.at<=now+1500&&now-r.at<=quoteTtl
      &&(r.scope==='private'?r.groupId===null:id(r.groupId))&&Array.isArray(r.images)&&r.images.length<=MAX_IMAGE_COUNT&&r.images.every(p=>isNapCatImageFile(p?.data?.file))).sort((a,b)=>a.at-b.at).slice(-512);
  }catch{return[];}
}
function write(rows){mkdirSync(new URL('../.local/',import.meta.url),{recursive:true});const tmp=new URL(file.href+'.'+process.pid+'.tmp');writeFileSync(tmp,JSON.stringify({version:1,entries:rows.slice(-512)}),{mode:0o600});renameSync(tmp,file);}
function fromEvent(event,c,maxAge=ttl,now=Date.now()){
  const sender=String(event?.user_id??event?.sender?.user_id??'');
  if(sender!==String(c.userId)||!id(event?.message_id)||messageReferences(event?.message).mentions.some(v=>v!==String(c.selfId)))return null;
  if(c.scope==='group'?String(event?.group_id??'')!==String(c.groupId):event?.group_id!==undefined&&event.group_id!==null)return null;
  const at=event.time===undefined?now:Number(event.time)*1000;if(!Number.isFinite(at)||at<=cutoff(c)||at>now+1500||now-at>maxAge)return null;
  const images=(Array.isArray(event.message)?event.message:[]).filter(p=>p.type==='image');if(!images.length||images.length>MAX_IMAGE_COUNT||images.some(p=>!isNapCatImageFile(p.data?.file)))return null;
  return{scope:c.scope,groupId:c.scope==='group'?String(c.groupId):null,userId:sender,messageId:String(event.message_id),at,images:images.map(p=>({type:'image',data:{file:p.data.file,sub_type:Number(p.data.sub_type)===1?1:0}})),collectionState:'not-requested',assets:[],replyIds:[]};
}
export function rememberImageExchange(event,c){const row=fromEvent(event,c);if(!row)return null;const rows=read();const old=rows.find(r=>same(r,c)&&r.messageId===row.messageId);if(old)return old;write([...rows,row]);return row;}
export function noteImageExchange(reference,c,{collectionState,assets,replyId,sendState}={}){
  if(!reference)return;const rows=read(),row=rows.find(r=>same(r,c)&&r.messageId===reference.messageId);if(!row)return;
  if(['saved','partial','failed','disabled','not-requested','rejected'].includes(collectionState))row.collectionState=collectionState;
  if(Array.isArray(assets)){const checked=assets.slice(0,MAX_IMAGE_COUNT).map(a=>({id:/^[a-f\d-]{36}$/u.test(a?.id??'')?a.id:null,sourceHash:/^[a-f\d]{64}$/u.test(a?.sourceHash??'')?a.sourceHash:null,collectionState:['saved','failed','rejected'].includes(a?.collectionState)?a.collectionState:'failed'}));if(Number.isInteger(reference.selectedIndex)){row.assets??=[];row.assets[reference.selectedIndex]=checked[0];}else row.assets=checked;}
  if(id(replyId))row.replyIds=[...new Set([...(row.replyIds??[]),String(replyId)])].slice(-4);
  if(['sent','failed','blocked','uncertain'].includes(sendState))row.sendState=sendState;write(rows);
}
export function markPendingImageReturn(event,c,{collect=false}={}){const rows=read().filter(r=>!same(r,c)||!r.pending);rows.push({scope:c.scope,groupId:c.scope==='group'?String(c.groupId):null,userId:String(c.userId),messageId:String(event.message_id),at:Date.now(),images:[],pending:true,collect});write(rows);}
export function hasPendingImageReturn(c){return read().findLast(r=>same(r,c)&&r.pending&&Date.now()-r.at<=ttl&&r.at>cutoff(c))??null;}
export function clearPendingImageReturn(c){const rows=read();write(rows.filter(r=>!same(r,c)||!r.pending));}
export function canUseImageExchange(row,c,{quoted=false,now=Date.now()}={}){return!!row&&same(row,c)&&row.at>cutoff(c)&&row.at<=now&&now-row.at<=(quoted?quoteTtl:ttl);}
export async function resolveImageExchange(event,c,{sendAction}={}){
  const refs=messageReferences(event.message);if(refs.mentions.some(v=>v!==String(c.selfId)))return{status:'other-target'};
  let rows=read().filter(r=>same(r,c)&&!r.pending&&r.at>cutoff(c)),row;const quoted=refs.replyIds.length>0;
  if(quoted){row=rows.find(r=>r.messageId===refs.replyIds[0]||(r.replyIds??[]).includes(refs.replyIds[0]));
    if(!row)try{const source=await sendAction('get_msg',{message_id:refs.replyIds[0]});if(String(source?.message_id??refs.replyIds[0])===refs.replyIds[0]){row=fromEvent({...source,message_id:refs.replyIds[0]},c,quoteTtl);if(row)write([...read(),row]);}}catch{}
  }else{const recent=rows.filter(r=>Date.now()-r.at<=ttl);row=(/(?:存|收藏|收.{0,4}没)/u.test(c.text??'')?recent.filter(r=>r.collectionState&&r.collectionState!=='not-requested').at(-1):null)??recent.at(-1);
    if(!row&&c.scope==='group')try{const history=await sendAction('get_group_msg_history',{group_id:c.groupId,count:20,disable_get_url:true});for(const e of(history?.messages??[]).slice(-20))rememberImageExchange(e,c);rows=read().filter(r=>same(r,c)&&!r.pending&&r.at>cutoff(c));row=rows.filter(r=>Date.now()-r.at<=ttl).at(-1);}catch{}
  }
  if(!row)return{status:rows.length?'expired':'missing'};
  if(!canUseImageExchange(row,c,{quoted}))return{status:'expired'};
  const number=String(c.text??'').match(/第\s*([1-9])\s*张/u)?.[1];
  if(row.images.length>1&&!number)return{status:'ambiguous',count:row.images.length,reference:row};
  if(number){const index=Number(number)-1;if(!row.images[index])return{status:'ambiguous',count:row.images.length};row={...row,selectedIndex:index,collectionState:row.assets?.[index]?.collectionState??'not-requested',images:[row.images[index]],assets:[row.assets?.[index]??{}]};}
  return{status:'resolved',reference:row,quoted};
}
export function collectionTruth(result){
  if(/(?:收到[，,\s]*(?:已经)?(?:存进|存到|收进)|(?:我|已经|已)(?:已经)?(?:把.{0,20})?(?:存进|存到|保存好|收藏好|收藏了|保存了|收好了))/u.test(result?.reply??''))return{...result,reply:'我看到图片了，但这次还没有完成收藏。需要收藏时可以对我说“把这张图当表情包收下”。',stickerId:null};
  return result;
}
