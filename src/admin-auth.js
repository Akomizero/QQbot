import { createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scrypt = promisify(nodeScrypt);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const authPath = resolve(projectRoot, ".local", "admin-auth.json");
const setupLockPath = resolve(projectRoot, ".local", "admin-auth.setup.lock");
const cookieName = "qqbot_admin_session";
const sessionLifetimeSeconds = 8 * 60 * 60;
const lockoutWindowMs = 15 * 60 * 1000;
const lockoutThreshold = 5;
const authFailures = new Map();
let activeHashOperations = 0;
let setupInProgress = false;

function invalidCredentialStore() {
  return new Error("本机管理员凭据文件无效，请检查 .local/admin-auth.json。");
}

function readCredentialStore() {
  let source;
  try {
    source = readFileSync(authPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("无法读取本机管理员凭据文件。");
  }

  let record;
  try { record = JSON.parse(source); } catch { throw invalidCredentialStore(); }
  if (
    record?.version !== 1
    || typeof record.salt !== "string"
    || typeof record.passwordHash !== "string"
    || typeof record.sessionSigningKey !== "string"
    || !/^[A-Za-z0-9_-]{22}$/u.test(record.salt)
    || !/^[A-Za-z0-9_-]{86}$/u.test(record.passwordHash)
    || !/^[A-Za-z0-9_-]{43}$/u.test(record.sessionSigningKey)
  ) {
    throw invalidCredentialStore();
  }

  const salt = Buffer.from(record.salt, "base64url");
  const passwordHash = Buffer.from(record.passwordHash, "base64url");
  const sessionSigningKey = Buffer.from(record.sessionSigningKey, "base64url");
  if (
    salt.length !== 16
    || passwordHash.length !== 64
    || sessionSigningKey.length !== 32
    || salt.toString("base64url") !== record.salt
    || passwordHash.toString("base64url") !== record.passwordHash
    || sessionSigningKey.toString("base64url") !== record.sessionSigningKey
  ) {
    throw invalidCredentialStore();
  }

  return { ...record, saltBuffer: salt, hashBuffer: passwordHash, signingKeyBuffer: sessionSigningKey };
}

function writeCredentialStore(record) {
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  const tempPath = `${authPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const serialized = `${JSON.stringify({
    version: 1,
    salt: record.salt,
    passwordHash: record.passwordHash,
    sessionSigningKey: record.sessionSigningKey,
  })}\n`;
  try {
    writeFileSync(tempPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // Hard-link creation is atomic and fails if another instance already created the final path.
    linkSync(tempPath, authPath);
  } finally {
    try { unlinkSync(tempPath); } catch {}
  }
}

function createSetupLock() {
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  const descriptor = openSync(setupLockPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, "utf8");
    return { descriptor };
  } catch {
    closeSync(descriptor);
    const error = new Error("管理员初始化锁写入失败。");
    error.code = "ADMIN_SETUP_LOCK_WRITE";
    throw error;
  }
}

function acquireSetupLock() {
  try {
    return createSetupLock();
  } catch (error) {
    if (error.code === "EEXIST") return null;
    throw error;
  }
}

function closeSetupLock(lock) {
  if (!lock) return;
  try { closeSync(lock.descriptor); } catch {}
}

function requestKey(request) {
  return request.socket.remoteAddress || "loopback";
}

function pruneFailures(now = Date.now()) {
  for (const [key, attempt] of authFailures) {
    if (attempt.expiresAt <= now && attempt.blockedUntil <= now) authFailures.delete(key);
  }
  while (authFailures.size > 128) authFailures.delete(authFailures.keys().next().value);
}

function rateLimitStatus(request) {
  pruneFailures();
  const attempt = authFailures.get(requestKey(request));
  if (!attempt || attempt.blockedUntil <= Date.now()) return { limited: false };
  return { limited: true, retryAfter: Math.max(1, Math.ceil((attempt.blockedUntil - Date.now()) / 1000)) };
}

function recordFailure(request) {
  const now = Date.now();
  const key = requestKey(request);
  let attempt = authFailures.get(key);
  if (!attempt || attempt.expiresAt <= now) {
    attempt = { failures: 0, expiresAt: now + lockoutWindowMs, blockedUntil: 0 };
  }
  attempt.failures += 1;
  if (attempt.failures >= lockoutThreshold) attempt.blockedUntil = now + lockoutWindowMs;
  authFailures.set(key, attempt);
  pruneFailures(now);
}

function clearFailures(request) {
  authFailures.delete(requestKey(request));
}

function isValidPassword(password) {
  return typeof password === "string"
    && Array.from(password).length >= 12
    && Array.from(password).length <= 256
    && Buffer.byteLength(password, "utf8") <= 1024;
}

function readCookie(request) {
  const cookieHeader = request.headers.cookie;
  if (typeof cookieHeader !== "string") return null;
  const values = cookieHeader.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
  if (values.length !== 1) return null;
  return values[0].slice(cookieName.length + 1);
}

function signatureFor(payload, signingKey) {
  return createHmac("sha256", signingKey).update(payload).digest("base64url");
}

function isAuthenticated(request, record) {
  const cookie = readCookie(request);
  if (!cookie || !record) return false;
  const parts = cookie.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/u.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/u.test(parts[1])) return false;

  const expected = Buffer.from(signatureFor(parts[0], record.signingKeyBuffer), "base64url");
  const received = Buffer.from(parts[1], "base64url");
  const payloadBuffer = Buffer.from(parts[0], "base64url");
  if (
    received.length !== expected.length
    || received.toString("base64url") !== parts[1]
    || payloadBuffer.toString("base64url") !== parts[0]
    || !timingSafeEqual(received, expected)
  ) return false;

  let session;
  try { session = JSON.parse(payloadBuffer.toString("utf8")); } catch { return false; }
  return session?.version === 1
    && session?.admin === true
    && Number.isSafeInteger(session.expiresAt)
    && session.expiresAt > Math.floor(Date.now() / 1000);
}

function sessionCookieValue(record) {
  const expiresAt = Math.floor(Date.now() / 1000) + sessionLifetimeSeconds;
  const payload = Buffer.from(JSON.stringify({ version: 1, admin: true, expiresAt, nonce: randomBytes(12).toString("base64url") }))
    .toString("base64url");
  return `${cookieName}=${payload}.${signatureFor(payload, record.signingKeyBuffer)}; Max-Age=${sessionLifetimeSeconds}; Expires=${new Date(expiresAt * 1000).toUTCString()}; HttpOnly; SameSite=Strict; Path=/`;
}

export function clearAdminSession(response) {
  response.setHeader("set-cookie", `${cookieName}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict; Path=/`);
}

export function setAdminSession(response, record = readCredentialStore()) {
  if (!record) throw new Error("管理员尚未完成初始化。");
  response.setHeader("set-cookie", sessionCookieValue(record));
}

export function getAdminAuthState(request) {
  const record = readCredentialStore();
  return { setupRequired: !record, authenticated: isAuthenticated(request, record) };
}

export function isAdminAuthenticated(request) {
  return isAuthenticated(request, readCredentialStore());
}

export async function setupAdminPassword(request, password) {
  if (readCredentialStore()) return { ok: false, alreadyConfigured: true };
  if (setupInProgress || existsSync(setupLockPath)) return { ok: false, setupBusy: true };
  const rateLimit = rateLimitStatus(request);
  if (rateLimit.limited) return { ok: false, ...rateLimit };
  if (!isValidPassword(password)) {
    recordFailure(request);
    return { ok: false, invalidPassword: true, ...rateLimitStatus(request) };
  }
  if (activeHashOperations >= 2) return { ok: false, limited: true };

  setupInProgress = true;
  activeHashOperations += 1;
  let setupLock;
  try {
    setupLock = acquireSetupLock();
    if (!setupLock) return { ok: false, setupBusy: true };
    if (readCredentialStore()) return { ok: false, alreadyConfigured: true };

    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const record = {
      version: 1,
      salt: salt.toString("base64url"),
      passwordHash: Buffer.from(hash).toString("base64url"),
      sessionSigningKey: randomBytes(32).toString("base64url"),
    };
    try {
      writeCredentialStore(record);
    } catch (error) {
      if (error.code === "EEXIST" && readCredentialStore()) return { ok: false, alreadyConfigured: true };
      throw error;
    }
    clearFailures(request);
    return { ok: true, record: readCredentialStore() };
  } finally {
    closeSetupLock(setupLock);
    activeHashOperations -= 1;
    setupInProgress = false;
  }
}

export async function verifyAdminPassword(request, password) {
  const limited = rateLimitStatus(request);
  if (limited.limited) return { ok: false, limited: true, retryAfter: limited.retryAfter };
  const record = readCredentialStore();
  if (!record) return { ok: false, setupRequired: true };
  if (!isValidPassword(password)) {
    recordFailure(request);
    return { ok: false, ...rateLimitStatus(request) };
  }
  if (activeHashOperations >= 2) return { ok: false, limited: true, retryAfter: 1 };

  activeHashOperations += 1;
  try {
    const candidate = Buffer.from(await scrypt(password, record.saltBuffer, 64, {
      N: 16_384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }));
    if (candidate.length !== record.hashBuffer.length || !timingSafeEqual(candidate, record.hashBuffer)) {
      recordFailure(request);
      return { ok: false, ...rateLimitStatus(request) };
    }
    clearFailures(request);
    return { ok: true, record };
  } finally {
    activeHashOperations -= 1;
  }
}
