import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------- 数据目录 ----------
// data/
//   system.json          用户 / 会话 / 邀请 / 实例设置
//   secret.key           AES-256 主密钥（0600）
//   users/<uid>/         每用户独立目录（隔离边界）
//     accounts.enc       该用户的邮箱凭据（AES-256-GCM）
//     profile.json       显示名 / 偏好
export const DATA_DIR = process.env.MAILNEST_DATA
  ? path.resolve(process.env.MAILNEST_DATA)
  : path.resolve('data');
const USERS_DIR = path.join(DATA_DIR, 'users');

export function ensureDataDirs() {
  fs.mkdirSync(USERS_DIR, { recursive: true });
}

const SYSTEM_FILE = path.join(DATA_DIR, 'system.json');

function atomicWrite(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// ---------- system.json ----------
let _system = null;

function defaultSystem() {
  return { users: [], sessions: {}, invites: {}, settings: { setupDone: false }, audit: [] };
}

export function system() {
  if (_system) return _system;
  try {
    _system = { ...defaultSystem(), ...JSON.parse(fs.readFileSync(SYSTEM_FILE, 'utf8')) };
  } catch {
    _system = defaultSystem();
  }
  return _system;
}

export function saveSystem() {
  atomicWrite(SYSTEM_FILE, JSON.stringify(system(), null, 2));
}

// ---------- 密码 ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [saltB64, hashB64] = String(stored).split(':');
    const salt = Buffer.from(saltB64, 'base64');
    const expect = Buffer.from(hashB64, 'base64');
    const got = crypto.scryptSync(password, salt, expect.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(got, expect);
  } catch {
    return false;
  }
}

// ---------- 加密 ----------
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

function masterKey() {
  try {
    return fs.readFileSync(SECRET_FILE);
  } catch {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_FILE, key, { mode: 0o600 });
    return key;
  }
}

function userKey(uid) {
  // 每用户独立数据密钥：主密钥 + uid 经 HKDF 派生，单个目录被拷走也解不开
  return crypto.hkdfSync('sha256', masterKey(), Buffer.from(uid), Buffer.from('mailnest-user-v1'), 32);
}

export function encryptFor(uid, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(userKey(uid)), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: enc.toString('base64'),
  });
}

export function decryptFor(uid, raw) {
  const box = JSON.parse(raw);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(userKey(uid)), Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

// ---------- 用户 ----------
export function newUid() {
  return 'u_' + crypto.randomBytes(6).toString('hex');
}

export function createUser({ username, password, role = 'member', displayName = '' }) {
  const sys = system();
  if (sys.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    throw Object.assign(new Error('用户名已存在'), { status: 400 });
  }
  const user = {
    id: newUid(),
    username: String(username).trim(),
    displayName: String(displayName || username).trim(),
    role,
    passHash: hashPassword(password),
    createdAt: Date.now(),
    disabled: false,
  };
  sys.users.push(user);
  saveSystem();
  fs.mkdirSync(userDir(user.id), { recursive: true });
  saveProfile(user.id, {});
  return user;
}

export function findUser(id) {
  return system().users.find((u) => u.id === id) || null;
}

export function userByLogin(username) {
  const lower = String(username || '').toLowerCase();
  return system().users.find((u) => u.username.toLowerCase() === lower) || null;
}

export function userDir(uid) {
  return path.join(USERS_DIR, uid);
}

export function saveProfile(uid, patch) {
  const file = path.join(userDir(uid), 'profile.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first write */ }
  const next = { ...cur, ...patch };
  fs.mkdirSync(userDir(uid), { recursive: true });
  atomicWrite(file, JSON.stringify(next, null, 2));
  return next;
}

export function readProfile(uid) {
  try { return JSON.parse(fs.readFileSync(path.join(userDir(uid), 'profile.json'), 'utf8')); }
  catch { return {}; }
}

// ---------- 邮箱账号（加密落盘） ----------
export function listAccounts(uid) {
  try {
    return decryptFor(uid, fs.readFileSync(path.join(userDir(uid), 'accounts.enc'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return [];
  }
}

export function saveAccounts(uid, accounts) {
  fs.mkdirSync(userDir(uid), { recursive: true });
  atomicWrite(path.join(userDir(uid), 'accounts.enc'), encryptFor(uid, accounts));
}

export function findAccount(uid, accountId) {
  return listAccounts(uid).find((a) => a.id === accountId) || null;
}

// ---------- 会话 ----------
const SESSION_TTL = 1000 * 60 * 60 * 24 * 14; // 14 天

export function createSession(uid, info = {}) {
  const sys = system();
  const sid = crypto.randomBytes(24).toString('base64url');
  sys.sessions[sid] = { uid, createdAt: Date.now(), expires: Date.now() + SESSION_TTL, ip: info.ip || '', ua: info.ua || '' };
  // 只保留最近 500 个会话，防止无限膨胀
  const ids = Object.keys(sys.sessions);
  if (ids.length > 500) {
    ids.sort((a, b) => sys.sessions[a].expires - sys.sessions[b].expires);
    for (const old of ids.slice(0, ids.length - 500)) delete sys.sessions[old];
  }
  saveSystem();
  return sid;
}

export function getSession(sid) {
  if (!sid) return null;
  const s = system().sessions[sid];
  if (!s || s.expires < Date.now()) return null;
  return s;
}

export function destroySession(sid) {
  const sys = system();
  if (sys.sessions[sid]) { delete sys.sessions[sid]; saveSystem(); }
}

export function destroyUserSessions(uid) {
  const sys = system();
  let changed = false;
  for (const [sid, s] of Object.entries(sys.sessions)) {
    if (s.uid === uid) { delete sys.sessions[sid]; changed = true; }
  }
  if (changed) saveSystem();
}

export function purgeExpiredSessions() {
  const sys = system();
  let changed = false;
  for (const [sid, s] of Object.entries(sys.sessions)) {
    if (s.expires < Date.now()) { delete sys.sessions[sid]; changed = true; }
  }
  if (changed) saveSystem();
}

// ---------- 审计 ----------
export function audit(uid, action, detail = '', ip = '') {
  const sys = system();
  sys.audit.push({ at: Date.now(), uid, action, detail, ip });
  if (sys.audit.length > 2000) sys.audit.splice(0, sys.audit.length - 2000);
  saveSystem();
}
