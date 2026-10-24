import { createHash } from 'node:crypto';

// A reply-use grant never grants access to authentication/identity material.
const restricted = /姓名|本名|历史身份|旧代号|曾用名|手机号|手机号码|电话号码|联系方式|地址|住址|身份证|住在|学校|工作|职业|年龄|出生|生日|家庭|家人|收入|病史|健康|诊断|财务|负债|银行卡|行踪|宗教|政治倾向|保密|私密|私聊|饲养员|管理员|主人|白名单|权限|系统提示|提示词|密钥|密码|令牌|cookie|sessdata|\bQQ\b|https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\d{5,}|sk-[a-z\d]{12,}|tvly-/iu;
export const replyContentHash = content => createHash('sha256').update(String(content)).digest('hex');
export function shareableMemoryClause(content) { return typeof content === 'string' && !!content.trim() && !restricted.test(content) && !/内部身份|账号|账户/u.test(content); }
export const memoryClauses = value => String(value ?? '').split(/(?<=[。！？\n])/u).filter(Boolean);
export function configuredMemoryAllowed(profile, scope = {}) {
  if(scope.accessAllowed===false)return false;
  if (scope.scope === 'group') return /^\d{1,32}$/u.test(scope.groupId ?? '') && profile.memoryReplyEnabled === true && profile.enabled !== false;
  return scope.scope === 'private' && /^\d{1,32}$/u.test(scope.userId ?? '') && Array.isArray(profile.memoryReplyUserIds) && profile.memoryReplyUserIds.includes(scope.userId);
}
export function configuredReplyMemory(profile, scope = {}) {
  return configuredMemoryAllowed(profile, scope) ? memoryClauses(profile.memory).filter(shareableMemoryClause).join('') : '';
}
export function sharedMemberFact(fact) {
  return fact?.replyAllowed === true && fact.replyContentHash === replyContentHash(fact.content)
    && fact.enabled === true && fact.reviewStatus === 'approved' && !fact.archivedAt && !fact.supersededAt && shareableMemoryClause(fact.content);
}
