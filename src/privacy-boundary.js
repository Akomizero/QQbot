import { readFileSync } from "node:fs";
import { createHash } from 'node:crypto';
import { memoryTransportAllowed } from './memory-use-guard.js';
import { recordPrivacyHit, privacyCounterSources } from './privacy-hit-counters.js';
import { configuredMemoryAllowed, configuredReplyMemory, memoryClauses, shareableMemoryClause, sharedMemberFact } from './memory-reply-access.js';

export const privateReplyNotice = "这部分涉及个人资料，我先不展开。可以继续聊不含个人信息的内容。";
const personal = /真实姓名|本名|历史身份|曾用名|手机号|手机号码|家庭住址|身份证|住在|学校|工作单位|收入|病史|个人资料|个人信息|保密|私密|私聊|饲养员|管理员.{0,12}(?:QQ|账号)|\bQQ\b/iu;
const canonical = value => String(value ?? "").normalize("NFKC").replace(/[\s\p{P}\p{S}\p{Cf}]/gu, "").toLowerCase();

const diagnosticSources = new WeakMap();
const trackedBoundaries = new WeakSet();

export function buildPrivacyBoundary({ memories = [], memberFacts = [], confidential = [], secrets = [], sourceCategories = null } = {}) {
  const literals = new Set(), fragments = new Set();
  for (const value of [...memories, ...confidential]) {
    for (const id of String(value).match(/(?<!\d)\d{5,32}(?!\d)/gu) ?? []) literals.add(id);
  }
  for (const value of [...memories, ...memberFacts, ...confidential]) {
    for (const clause of String(value).split(/[。！？\n]/u)) {
      const text = canonical(clause);
      if (text.length < 12) { if(text.length>=2) literals.add(String(clause)); continue; }
      // Do not keep actual private values in diagnostics or test fixtures.
      // Fixed-width fragments also catch partial quotations of a stored fact.
      for (let i = 0; i + 12 <= text.length; i++) fragments.add(text.slice(i, i + 12));
    }
  }
  for (const value of secrets) if (typeof value === "string" && value.length >= 8) literals.add(value);
  const protectedLiterals = [...literals].flatMap(value => [canonical(value), Buffer.from(value).toString("base64").toLowerCase(), Buffer.from(value).toString("hex")]);
  const boundary={ literals: protectedLiterals, fragments, failed: false };
  try{if(sourceCategories){
    const literalSources=new Map(),fragmentSources=new Map(),add=(map,key,kind)=>{if(!map.has(key))map.set(key,new Set());map.get(key).add(kind);};
    for(const [kind,values]of Object.entries(sourceCategories)){
      if(!privacyCounterSources.includes(kind)||!Array.isArray(values))continue;
      for(const value of values){
        if(typeof value!=='string')continue;
        if(kind==='credential'){if(value.length>=8)for(const encoded of [canonical(value),Buffer.from(value).toString('base64').toLowerCase(),Buffer.from(value).toString('hex')])add(literalSources,canonical(encoded),kind);continue;}
        if(!kind.startsWith('member_'))for(const id of value.match(/(?<!\d)\d{5,32}(?!\d)/gu)??[])for(const encoded of[id,Buffer.from(id).toString('base64').toLowerCase(),Buffer.from(id).toString('hex')])add(literalSources,canonical(encoded),kind);
        for(const clause of value.split(/[。！？\n]/u)){const text=canonical(clause);if(text.length>=2&&text.length<12)for(const encoded of[canonical(clause),Buffer.from(clause).toString('base64'),Buffer.from(clause).toString('hex')])add(literalSources,canonical(encoded),kind);for(let i=0;i+12<=text.length;i++)add(fragmentSources,text.slice(i,i+12),kind);}
      }
    }
    diagnosticSources.set(boundary,{literalSources,fragmentSources});
  }}catch{diagnosticSources.set(boundary,{literalSources:new Map(),fragmentSources:new Map()});}
  return boundary;
}

export function privacyViolation(value, boundary) {
  if (boundary.failed) return true;
  const text = canonical(value);
  if (!text) return false;
  if (boundary.literals.some(secret => text.includes(canonical(secret)))) return true;
  for (let i = 0; i + 12 <= text.length; i++) if (boundary.fragments.has(text.slice(i, i + 12))) return true;
  return /(?:sk-[a-z\d]{16,}|tvly-[a-z\d-]{16,}|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dX](?!\d))/iu.test(String(value));
}

// Observe the existing boolean decision, never substitute a new matching rule.
// Only runtime-created boundaries are tracked. Explicit synthetic boundaries
// cannot opt into production counters, even if they supply provenance labels.
function matchSourceCategories(value,boundary){
  if(boundary.failed)return['boundary_unavailable'];
  const labels=diagnosticSources.get(boundary),text=canonical(value);
  for(const literal of boundary.literals)if(text.includes(canonical(literal)))return[...(labels?.literalSources.get(canonical(literal))??['unknown'])];
  for(let i=0;i+12<=text.length;i++){const fragment=text.slice(i,i+12);if(boundary.fragments.has(fragment))return[...(labels?.fragmentSources.get(fragment)??['unknown'])];}
  return['credential_pattern'];
}
function noteDecision(stage,hit,sources,boundary){
  if(!trackedBoundaries.has(boundary))return;
  try{recordPrivacyHit(stage,{hit,sources});}catch{/* Diagnostics cannot change filtering or sending. */}
}
export function observedPrivacyViolation(stage,value,boundary){
  const hit=privacyViolation(value,boundary);
  let sources=[];try{if(hit)sources=matchSourceCategories(value,boundary);}catch{sources=['unknown'];}
  noteDecision(stage,hit,sources,boundary);return hit;
}

const files = ["data/llm-settings.json", "data/group-personas.json", "data/member-impressions.json", "data/knowledge-base.json", ".env", "data/access-control.json"];
let cachedStamp = ""; const cachedBoundaries = new Map();
export function runtimePrivacyBoundary(scope = {}) {
  try {
    // Content, not mtime/size, is authoritative. Parse the same read used for the fingerprint.
    const sources=new Map(files.map(name=>{try{const source=readFileSync(new URL('../'+name,import.meta.url),'utf8');if(Buffer.byteLength(source)>10*1024*1024)throw Error('Privacy source too large');return[name,source];}catch(e){if(e.code==='ENOENT')return[name,null];throw e;}}));
    const stamp=createHash('sha256').update(JSON.stringify([...sources,...['QQBOT_LLM_API_KEY','SERPER_API_KEY','TAVILY_API_KEY','ONEBOT_ACCESS_TOKEN'].map(name=>[name,process.env[name]])])).digest('hex');
    const scopeKey = JSON.stringify([scope.scope, scope.groupId, scope.userId]);
    if (cachedStamp !== stamp) { cachedBoundaries.clear(); cachedStamp = stamp; }
    if (cachedBoundaries.has(scopeKey)) return cachedBoundaries.get(scopeKey);
    const json = name => sources.get(name)===null?{}:JSON.parse(sources.get(name));
    const settingsData=json(files[0]),personaData=json(files[1]),memberData=json(files[2]),knowledgeData=json(files[3]);
    if(sources.get(files[0])!==null&&(settingsData.version!==1||!settingsData.settings||typeof settingsData.settings!=='object'||Array.isArray(settingsData.settings))
      ||sources.get(files[1])!==null&&(personaData.version!==1||!Array.isArray(personaData.profiles))
      ||sources.get(files[2])!==null&&(memberData.version!==1||!memberData.groups||typeof memberData.groups!=='object'||Array.isArray(memberData.groups))
      ||sources.get(files[3])!==null&&(knowledgeData.version!==1||!Array.isArray(knowledgeData.entries)))throw Error('Invalid privacy source');
    const accessData=json(files[5]),access=accessData.accessControl;
    if(sources.get(files[5])!==null&&(accessData.version!==1||!Array.isArray(access?.groupIds)||!Array.isArray(access?.userIds)))throw Error('Invalid access source');
    const scopeAllowed=scope.scope==='group'?access?.groupIds.includes(scope.groupId):scope.scope==='private'&&access?.userIds.includes(scope.userId);
    const defaults = settingsData.settings ?? {}, profiles = personaData.profiles ?? [];
    const memories = [defaults, ...profiles].map(profile => {
      const sameScope = profile === defaults ? scope.scope === 'private' : scope.scope === 'group' && profile.groupId === scope.groupId;
      return memoryClauses(profile.memory).filter(clause => !(scopeAllowed && sameScope && configuredMemoryAllowed(profile, scope) && shareableMemoryClause(clause))).join('');
    });
    const confidential = [defaults, ...profiles].flatMap(profile => [profile.systemPrompt, profile.personality, profile.expressionStyle]
      .flatMap(value => String(value ?? "").split(/[。！？\n]/u).filter(clause => personal.test(clause))));
    const personaConfidential=[...confidential],knowledgeConfidential=[],memberCategories={member_candidate:[],member_approved:[],member_other:[]};
    const memberFacts = [];
    for (const [groupId, group] of Object.entries(memberData.groups ?? {})) for (const member of Object.values(group.members ?? {})) {
      for (const fact of member.facts ?? []) if (typeof fact.content === 'string'
        && !(scopeAllowed && scope.scope === 'group' && scope.groupId === groupId && member.enabled !== false && sharedMemberFact(fact))) {memberFacts.push(fact.content);memberCategories[fact.reviewStatus==='candidate'?'member_candidate':fact.reviewStatus==='approved'?'member_approved':'member_other'].push(fact.content);}
    }
    for (const entry of knowledgeData.entries ?? []) if (personal.test(entry.content ?? "")) {confidential.push(entry.content);knowledgeConfidential.push(entry.content);}
    const secrets = ["QQBOT_LLM_API_KEY", "SERPER_API_KEY", "TAVILY_API_KEY", "ONEBOT_ACCESS_TOKEN"].map(name => process.env[name]);
    try { for (const line of (sources.get('.env')??'').split(/\r?\n/u)) {
      const match = line.match(/^\s*(?:QQBOT_LLM_API_KEY|SERPER_API_KEY|TAVILY_API_KEY|ONEBOT_ACCESS_TOKEN)\s*=\s*(.*?)\s*$/u);
      if (match) secrets.push(match[1].replace(/^["']|["']$/gu, ""));
    } } catch (e) { if (e.code !== "ENOENT") throw e; }
    const boundary = buildPrivacyBoundary({ memories, memberFacts, confidential, secrets,sourceCategories:{configured_memory:memories,persona_sensitive:personaConfidential,knowledge_sensitive:knowledgeConfidential,...memberCategories,credential:secrets} });
    trackedBoundaries.add(boundary);
    if (cachedBoundaries.size > 256) cachedBoundaries.clear(); cachedBoundaries.set(scopeKey, boundary); return boundary;
  } catch { const boundary={ literals: [], fragments: new Set(), failed: true };diagnosticSources.set(boundary,{});trackedBoundaries.add(boundary);return boundary; }
}

export function promptSafeSettings(settings, scope = {}) {
  // Authentication/relationship decisions stay in application code. Group
  // memory and member facts have no public-disclosure consent schema yet.
  const fields = ["systemPrompt", "personality", "expressionStyle"];
  return { ...settings, memory: configuredReplyMemory(settings, scope), ...Object.fromEntries(fields.map(field => [field,
    String(settings[field] ?? "").split(/(?<=[。！？\n])/u).filter(clause => !personal.test(clause) && !/\d{5,32}/u.test(clause)).join("")])) };
}

export function sanitizeModelMessages(messages, boundary = runtimePrivacyBoundary()) {
  return messages.map(message=>{
    let checked=false,hit=false;const sources=new Set();
    const safeText=text=>{checked=true;const blocked=privacyViolation(text,boundary);if(blocked){hit=true;try{for(const source of matchSourceCategories(text,boundary))sources.add(source);}catch{sources.add('unknown');}}return blocked?"[内部个人资料已隔离，仅按其余可用材料回答；不要推测或复述被隔离内容。]":text;};
    const content=typeof message.content==='string'?safeText(message.content):Array.isArray(message.content)?message.content.map(part=>part.type==='text'?{...part,text:safeText(part.text)}:part):message.content;
    if(checked)noteDecision('input_message',hit,[...sources],boundary);
    return{...message,content};
  });
}

export function publicMessageMetadata(metadata) {
  if (!metadata) return metadata;
  const aliases = new Map(), label = id => { if (!aliases.has(id)) aliases.set(id, `会话成员${aliases.size + 1}`); return aliases.get(id); };
  const visit = (value, key = "") => {
    if (typeof value === "string") {
      if (key === "botId") return "bot";
      if (/(?:^id$|Id$)/u.test(key) && /^-?\d+$/u.test(value)) return label(value);
      return value;
    }
    if (Array.isArray(value)) return value.map(item => visit(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, key)]));
    return value;
  };
  return visit(metadata);
}

export function protectLlmResult(result, boundary = runtimePrivacyBoundary()) {
  const summary = result.summary ?? result.announcement ?? result.illustration;
  const material = [result.reply ?? "", summary ? JSON.stringify(summary) : ""].join("\n");
  if (!observedPrivacyViolation('model_answer',material, boundary)) return result;
  return { reply: privateReplyNotice, status: "privacy-blocked" };
}

function outgoingText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(part => {
    if (part.type === "text") return part.data?.text ?? "";
    if (part.type === "node") return [part.data?.nickname ?? part.data?.name ?? "", outgoingText(part.data?.content ?? part.content)].join("\n");
    if (part.type === "json") return part.data?.data ?? "";
    return part.data?.summary ?? "";
  }).join("");
  return "";
}

export const protectedSendActions=Object.freeze(['send_msg','send_group_msg','send_private_msg','send_group_forward_msg','send_private_forward_msg']);
export function outboundPrivacyScope(params,action='send_msg') {
  const invalid=()=>{throw Object.assign(new Error('无法确认唯一有效的发送目的地。'),{code:'INVALID_SEND_DESTINATION'});};
  if(!params||typeof params!=='object'||!protectedSendActions.includes(action))return invalid();
  const hasGroup=params.group_id!==undefined,hasUser=params.user_id!==undefined;
  const scope=action==='send_msg'?(params.message_type??(hasGroup?'group':hasUser?'private':null)):action.includes('group')?'group':'private';
  if(!['group','private'].includes(scope)||hasGroup===hasUser||(scope==='group')!==hasGroup||params.message_type!==undefined&&params.message_type!==scope)return invalid();
  const id=scope==='group'?params.group_id:params.user_id;
  if(!(typeof id==='string'||typeof id==='number'&&Number.isSafeInteger(id))||!(/^[1-9]\d{0,31}$/u.test(String(id))))return invalid();
  return scope==='group'?{scope,groupId:String(id)}:{scope,userId:String(id)};
}
export function protectOutbound(action, params, boundary) {
  if (!protectedSendActions.includes(action)) return { action, params, blocked: false };
  const scope=outboundPrivacyScope(params,action);
  if(!memoryTransportAllowed(scope))return{action,params,blocked:true,cancelled:true};
  boundary??=runtimePrivacyBoundary(scope);
  if (!observedPrivacyViolation('onebot_send',outgoingText(params.message ?? params.messages), boundary)) return { action, params, blocked: false };
  const isGroup = action.includes("group") || params.message_type === "group" || params.group_id !== undefined;
  return { action: "send_msg", params: { message_type: isGroup ? "group" : "private", ...(isGroup ? { group_id: params.group_id } : { user_id: params.user_id }), message: privateReplyNotice, auto_escape: true }, blocked: true };
}
