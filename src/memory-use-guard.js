import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Opaque process-local provenance, never model-controlled or serialized on the wire.
const context = new AsyncLocalStorage();
const provenance = Symbol('reply-memory-provenance');
const validId = value => typeof value === 'string' && /^[1-9]\d{0,31}$/u.test(value);
function read(name) {
  try { return JSON.parse(readFileSync(new URL('../data/' + name, import.meta.url), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export class MemoryAuthorizationError extends Error {
  constructor(code = 'MEMORY_AUTH_CHANGED') { super('本次回复的资料授权或会话已变化，请重新提问。'); this.code = code; }
}
function snapshot(scope) {
  const settingsFile=read('llm-settings.json'), settings=settingsFile?.settings;
  if (!settings || settingsFile.version !== 1) throw new MemoryAuthorizationError();
  const personas=read('group-personas.json'), members=read('member-impressions.json'), knowledge=read('knowledge-base.json'), accessData=read('access-control.json');
  const access=accessData?.accessControl;
  if (personas && (personas.version!==1 || !Array.isArray(personas.profiles))
    || members && (members.version!==1 || !members.groups || Array.isArray(members.groups))
    || knowledge && (knowledge.version!==1 || !Array.isArray(knowledge.entries))
    || accessData && (accessData.version!==1 || !Array.isArray(access?.groupIds) || !Array.isArray(access?.userIds))) throw new MemoryAuthorizationError();
  const selected=scope.scope==='group'?personas?.profiles.find(p=>p.groupId===scope.groupId):null;
  const value={scope,settingsRevision:settingsFile.revision??null,
    switches:[settings.knowledgeEnabled,settings.memberImpressionsEnabled],
    memory:scope.scope==='private'?[settings.memory,settings.memoryReplyUserIds]:selected,
    member:scope.scope==='group'?members?.groups[scope.groupId]?.members?.[scope.userId]??null:null,
    knowledge:knowledge?.entries.filter(e=>(e.groupId??null)===(scope.scope==='group'?scope.groupId:null))??[],
    knowledgeRevision:knowledge?.scopeRevisions?.[scope.scope==='group'?scope.groupId:'private']??null,
    platformAllowed:scope.scope==='group'?access?.groupIds?.includes(scope.groupId):access?.userIds?.includes(scope.userId)};
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function replyMemoryScope(groupId, userId) {
  if (groupId !== null && groupId !== undefined) {
    if (!validId(groupId)) throw new MemoryAuthorizationError('MEMORY_SCOPE_INVALID');
    return {scope:'group',groupId,...(validId(userId)?{userId}:{})};
  }
  return validId(userId)?{scope:'private',userId}:{scope:'unknown'};
}
export function withMemoryGeneration(scope, task) {
  const token=Object.freeze({scope:Object.freeze({...scope}),stamp:snapshot(scope)});
  return context.run(token,async()=>{
    const result=await task();
    if (!memoryUseCurrent(token)) return {reply:null,status:'memory-auth-changed'};
    // Enumerable Symbols survive trusted object spreads, but JSON drops them.
    if (result && typeof result==='object') Object.defineProperty(result,provenance,{value:token,enumerable:true});
    return result;
  });
}
function memoryUseCurrent(token=context.getStore()) {
  if (!token) return true;
  try { return token.stamp===snapshot(token.scope); } catch { return false; }
}
export function assertMemoryGenerationCurrent() {
  if (!memoryUseCurrent()) throw new MemoryAuthorizationError();
}
export function memoryTransportAllowed(destination) {
  const token=context.getStore();
  if (!token) return true;
  const source=token.scope;
  try {
    const access=read('access-control.json')?.accessControl;
    const allowed=source.scope==='group'?access?.groupIds?.includes(source.groupId):access?.userIds?.includes(source.userId);
    return allowed===true && source.scope===destination.scope
      && (source.scope==='group'?source.groupId===destination.groupId:source.userId===destination.userId)
      && memoryUseCurrent(token);
  } catch { return false; }
}
export function withReplyMemory(result,destination,task) {
  const token=result?.[provenance];
  if (!token) return task();
  return context.run(token,()=>memoryTransportAllowed(destination)?task():false);
}
