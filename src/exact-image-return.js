import { createHash } from 'node:crypto';
import { listStickers, readSticker, stickerInScope } from './sticker-store.js';
import { reviewStickerBytes } from './sticker-review.js';
import { stickerPolicyAllows, recordStickerSent } from './sticker-preferences.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const scopeKey=c=>c.scope==='group'?c.groupId:'private:'+c.userId;
const matching=(digest,c)=>listStickers().filter(e=>stickerInScope(e,c)&&(e.sourceHash===digest||e.reviewHash===digest));
export function cachedOriginalImage(reference,index,c){
  const asset=reference?.assets?.[index];if(!asset?.id||!asset.sourceHash)return null;
  try{const entry=readSticker(asset.id,{enabledOnly:true,approvedOnly:true});return entry&&stickerInScope(entry,c)&&hash(entry.bytes)===asset.sourceHash?entry.bytes:null;}catch{return null;}
}
export async function sendExactImage({bytes,context,destination,sendMessage,allowed,collectionState}){
  const digest=hash(bytes);let entries=matching(digest,context);
  if(entries.some(e=>!e.enabled||!stickerPolicyAllows(e,scopeKey(context),{includeRecent:false})))return{state:'blocked',explanation:'这张图片已被停用，或不符合这个会话的表情偏好，本次不发送。'};
  let metadata=entries.find(e=>e.reviewStatus==='approved'&&e.reviewHash===digest);
  if(metadata){const checked=readSticker(metadata.id,{approvedOnly:true,enabledOnly:true});if(!checked||hash(checked.bytes)!==digest)metadata=null;}
  if(!metadata){const review=await reviewStickerBytes(bytes,{needDescription:true});if(!review.description)return{state:'blocked',explanation:'这次没能确认原图是否适合发送，暂不回发。'};
    const key=digest.slice(0,32);metadata={id:`${key.slice(0,8)}-${key.slice(8,12)}-${key.slice(12,16)}-${key.slice(16,20)}-${key.slice(20)}`,...review.description,reviewHash:digest};}
  if(!stickerPolicyAllows(metadata,scopeKey(context),{includeRecent:false}))return{state:'blocked',explanation:'这张图片不符合这个会话的表情偏好，本次不发送。'};
  const guard=()=>allowed()&&!matching(digest,context).some(e=>!e.enabled||!stickerPolicyAllows(e,scopeKey(context),{includeRecent:false}))&&stickerPolicyAllows(metadata,scopeKey(context),{includeRecent:false});
  const saved=entries.some(e=>{try{return Boolean(readSticker(e.id,{approvedOnly:true,enabledOnly:true}));}catch{return false;}});
  const text=saved?'这张已收藏，原样回给你。':collectionState==='failed'?'这张还没收藏成功，先原样回给你。':'原样回给你；这次没有执行收藏。';
  let receipt;try{receipt=await sendMessage('send_msg',{...destination,message:[{type:'text',data:{text}},{type:'image',data:{file:'base64://'+bytes.toString('base64'),sub_type:1,summary:'[按要求回发原图]'}}],auto_escape:true},guard);}catch(error){error.collectionConfirmed=saved;throw error;}
  if(receipt?.cancelled||receipt?.privacyBlocked)return{state:'blocked',receipt,explanation:'设置、权限或偏好已变化，这次没有回发原图。'};
  if(!/^-?\d{1,32}$/u.test(String(receipt?.message_id??'')))return{state:'uncertain',receipt,explanation:'QQ 没有返回这次图片的消息编号，回发结果尚未确认；不会自动重复发送。'};
  recordStickerSent(scopeKey(context),metadata.id,digest);
  return{state:'sent',receipt,digest};
}
