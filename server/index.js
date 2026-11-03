import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ensureDataDirs, system, saveSystem, createUser, findUser, userByLogin,
  hashPassword, verifyPassword, createSession, getSession, destroySession,
  destroyUserSessions, purgeExpiredSessions, listAccounts, saveAccounts,
  findAccount, userDir, saveProfile, readProfile, audit,
} from './store.js';
import {
  listFolders, createFolder, deleteFolder, listMessages, getMessage, getAttachment, setFlags,
  moveMessages, deleteMessages, markAllRead, emptyFolderIsolated, sendMail, testAccount,
  listDrafts, saveDraft, deleteDraft, dropConnections, unseenCounts,
} from './mail.js';
import {
  getOutlookClientId, setOutlookClientId, startDeviceCode, pollDeviceCode,
  REGISTER_URL, DEVICE_LOGIN_URL,
} from './oauth.js';
import { createToken, listTokens, revokeToken, TOKEN_LIMIT } from './tokens.js';
import { mountMcp } from './mcp.js';
import * as cache from './cache.js';
import * as idle from './idle.js';
import * as prefetch from './prefetch.js';
import * as attachments from './attachments.js';

// 版本号唯一来源：package.json（登录页、客户端 ID 等处都从这里取，避免多处手改漏掉）
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '';
  } catch { return ''; }
})();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8006;
const HOST = process.env.HOST || '0.0.0.0';

ensureDataDirs();
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '80mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// ---------- 小工具 ----------
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function fail(res, err) {
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}

// 登录请求必须带 X-Requested-With，配合 SameSite=Lax 组成基础 CSRF 防线
function guard(req, res, next) {
  const session = getSession(parseCookies(req).mn_session);
  if (!session) return res.status(401).json({ error: '未登录' });
  const user = findUser(session.uid);
  if (!user || user.disabled) return res.status(401).json({ error: '账户不可用' });
  req.user = user;
  next();
}

function requireMut(req, res, next) {
  if (req.get('x-requested-with') !== 'MailNest') {
    return res.status(403).json({ error: '拒绝跨站请求' });
  }
  next();
}

app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.get('x-requested-with') !== 'MailNest') {
    return res.status(403).json({ error: '拒绝跨站请求' });
  }
  next();
});

const api = express.Router();
app.use('/api', api);

// ---------- 实时推送（SSE）与 IDLE 监听 ----------
const sseClients = new Map(); // uid -> Set<res>

function sendToUser(uid, obj) {
  const set = sseClients.get(uid);
  if (!set?.size) return;
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of set) { try { res.write(line); } catch { /* ignore */ } }
}

// IDLE 事件 → SSE：只转发前端用得上的新邮件事件
idle.setEventHandler((ev) => {
  if (ev.type !== 'new-mail') return;
  const acc = findAccount(ev.uid, ev.accountId);
  sendToUser(ev.uid, {
    type: 'new-mail',
    accountId: ev.accountId,
    email: acc?.email || '',
    folder: ev.folder,
    count: ev.count,
    unseen: ev.unseen,
  });
  // 新邮件正文还在服务器上，立刻叫醒预热队列，别等它那 10 分钟的空闲轮询
  prefetch.kick(ev.uid, ev.accountId);
});

// 预热进度 → SSE（前端用它显示「本地已缓存 N 封」，也让用户知道后台在干活）
prefetch.setEventHandler((ev) => {
  if (ev.type === 'prefetch') {
    sendToUser(ev.uid, {
      type: 'prefetch', accountId: ev.accountId, folder: ev.folder, done: ev.done, pending: ev.pending,
      finished: !!ev.finished,
    });
  } else if (ev.type === 'prefetch-error') {
    // 失败也要让前端知道（进度条位置显示原因），否则出错时进度条就永远停在原地
    sendToUser(ev.uid, { type: 'prefetch-error', accountId: ev.accountId, message: ev.message });
  }
});

function ensureUserWatchers(uid) {
  // 老库升级：先把已有信封灌进全文索引（只在 fts_keys 为空时做一次）
  try {
    const n = cache.rebuildFts(uid);
    if (n) console.log(`[mailnest] 全文索引回填 ${n} 封`);
  } catch (e) { console.log(`[mailnest] 全文索引回填失败：${e?.message || e}`); }
  // 失败计数随重启重置：tries 的用途是"别让一封坏邮件堵死队列"，不是永久拉黑。
  // 版本修复（比如 0.2.0 的解析 bug）发布后，之前被误记失败的邮件要能自动补上。
  try {
    const n = cache.resetBodyTries(uid);
    if (n) console.log(`[mailnest] 重置 ${n} 封邮件的预热失败计数`);
  } catch { /* ignore */ }
  for (const a of listAccounts(uid)) {
    idle.ensureWatcher(uid, a.id).catch(() => { /* runWatcher 内部兜底 */ });
    prefetch.ensurePrefetch(uid, a.id);
  }
}

// 后台清空：同账号同夹同时只跑一个任务，完成后用 SSE 告知前端结果。
// 几千封邮件的 EXPUNGE 在 Outlook 上可能十几秒到几十秒，同步等待会让界面像卡死，
// 所以缓存先清空、请求立刻返回，这里只负责把服务器那边的活干完。
const emptyJobs = new Set();
function emptyInBackground(uid, accountId, folder, count) {
  const key = `${uid}:${accountId}:${folder}`;
  if (emptyJobs.has(key)) return;
  emptyJobs.add(key);
  const t0 = Date.now();
  emptyFolderIsolated(uid, accountId, folder)
    .then(() => {
      const ms = Date.now() - t0;
      console.log(`[mailnest] 清空完成 ${folder} (${count} 封) 用时 ${ms}ms`);
      sendToUser(uid, { type: 'empty-done', accountId, folder, count, ms });
    })
    .catch((e) => {
      // 失败：把该夹从缓存里剔掉，下次打开会重新直拉，避免界面显示空、服务器其实还在
      try { cache.dropFolder(uid, accountId, folder); } catch { /* ignore */ }
      console.log(`[mailnest] 清空失败 ${folder}: ${e?.message || e}`);
      sendToUser(uid, { type: 'empty-error', accountId, folder, message: e?.message || '清空失败' });
    })
    .finally(() => emptyJobs.delete(key));
}

api.get('/events', guard, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':connected\n\n');
  const uid = req.user.id;
  if (!sseClients.has(uid)) sseClients.set(uid, new Set());
  sseClients.get(uid).add(res);
  const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch { /* ignore */ } }, 25_000);
  req.on('close', () => {
    clearInterval(hb);
    const set = sseClients.get(uid);
    set?.delete(res);
    if (set && !set.size) sseClients.delete(uid);
  });
});

// ---------- 首次启动 / 登录 ----------
const loginFails = new Map(); // ip+username -> {count, until}

function rateLimited(key) {
  const e = loginFails.get(key);
  return e && e.until > Date.now();
}

function recordFail(key) {
  const e = loginFails.get(key) || { count: 0, until: 0 };
  e.count += 1;
  if (e.count >= 5) { e.until = Date.now() + 5 * 60 * 1000; e.count = 0; }
  loginFails.set(key, e);
}

function setSessionCookie(res, sid) {
  res.setHeader('Set-Cookie',
    `mn_session=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 24 * 3600}${process.env.MAILNEST_SECURE_COOKIES === 'true' ? '; Secure' : ''}`);
}

function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, disabled: !!u.disabled, createdAt: u.createdAt };
}

api.get('/setup-status', (req, res) => {
  res.json({ setupDone: !!system().settings.setupDone, version: APP_VERSION });
});

api.post('/setup', async (req, res) => {
  try {
    const sys = system();
    if (sys.settings.setupDone) return res.status(403).json({ error: '已初始化，请直接登录' });
    const { username, password, displayName } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '请填写用户名和密码' });
    if (String(password).length < 8) return res.status(400).json({ error: '密码至少 8 位' });
    const user = createUser({ username, password, role: 'owner', displayName: displayName || username });
    sys.settings.setupDone = true;
    saveSystem();
    audit(user.id, 'setup', `创建管理员 ${user.username}`, clientIp(req));
    setSessionCookie(res, createSession(user.id, { ip: clientIp(req), ua: req.headers['user-agent'] }));
    ensureUserWatchers(user.id);
    res.json({ user: publicUser(user) });
  } catch (e) { fail(res, e); }
});

api.post('/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const key = `${clientIp(req)}|${String(username || '').toLowerCase()}`;
    if (rateLimited(key)) return res.status(429).json({ error: '尝试次数过多，请 5 分钟后再试' });
    const user = userByLogin(username);
    if (!user || !verifyPassword(String(password || ''), user.passHash)) {
      recordFail(key);
      audit(user?.id || null, 'login-fail', String(username || ''), clientIp(req));
      return res.status(401).json({ error: '用户名或密码不正确' });
    }
    if (user.disabled) return res.status(403).json({ error: '账户已被停用，请联系管理员' });
    loginFails.delete(key);
    setSessionCookie(res, createSession(user.id, { ip: clientIp(req), ua: req.headers['user-agent'] }));
    audit(user.id, 'login', '', clientIp(req));
    ensureUserWatchers(user.id);
    res.json({ user: publicUser(user) });
  } catch (e) { fail(res, e); }
});

api.post('/logout', guard, (req, res) => {
  destroySession(parseCookies(req).mn_session);
  res.json({ ok: true });
});

api.get('/me', guard, (req, res) => {
  const profile = readProfile(req.user.id);
  // 兜底：容器重启后如果没走到启动恢复，用户打开页面就把监听/预热接上（幂等）
  ensureUserWatchers(req.user.id);
  res.json({ user: publicUser(req.user), profile });
});

api.patch('/me', guard, (req, res) => {
  const patch = {};
  if (typeof req.body?.displayName === 'string') patch.displayName = req.body.displayName.slice(0, 60);
  if (typeof req.body?.theme === 'string') patch.theme = req.body.theme;
  if (typeof req.body?.accent === 'string') patch.accent = req.body.accent;
  saveProfile(req.user.id, patch);
  res.json({ profile: readProfile(req.user.id) });
});

api.post('/me/password', guard, (req, res) => {
  try {
    const { current, next } = req.body || {};
    if (!verifyPassword(String(current || ''), req.user.passHash)) {
      return res.status(400).json({ error: '当前密码不正确' });
    }
    if (String(next || '').length < 8) return res.status(400).json({ error: '新密码至少 8 位' });
    req.user.passHash = hashPassword(String(next));
    saveSystem();
    audit(req.user.id, 'password-change', '', clientIp(req));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ---------- 邮箱账号 ----------
function sanitizeAccount(a) {
  const { auth, ...rest } = a;
  // auth 里含密码/refresh_token，绝不外发；只告诉前端这号走的是 OAuth
  return { ...rest, oauth: auth?.type === 'oauth2' };
}

api.get('/accounts', guard, (req, res) => {
  res.json({ accounts: listAccounts(req.user.id).map(sanitizeAccount) });
});

const PRESETS = {
  qq: { imap: { host: 'imap.qq.com', port: 993, tls: true }, smtp: { host: 'smtp.qq.com', port: 465, tls: true }, passwordHint: '使用 16 位授权码' },
  '163': { imap: { host: 'imap.163.com', port: 993, tls: true }, smtp: { host: 'smtp.163.com', port: 465, tls: true }, passwordHint: '使用客户端授权密码' },
  '126': { imap: { host: 'imap.126.com', port: 993, tls: true }, smtp: { host: 'smtp.126.com', port: 465, tls: true }, passwordHint: '使用客户端授权密码' },
  sina: { imap: { host: 'imap.sina.com', port: 993, tls: true }, smtp: { host: 'smtp.sina.com', port: 465, tls: true }, passwordHint: '先在网页端开启 IMAP/SMTP' },
  gmail: { imap: { host: 'imap.gmail.com', port: 993, tls: true }, smtp: { host: 'smtp.gmail.com', port: 465, tls: true }, passwordHint: '需两步验证 + 应用专用密码' },
  outlook: { imap: { host: 'outlook.office365.com', port: 993, tls: true }, smtp: { host: 'smtp.office365.com', port: 587, tls: true }, passwordHint: 'Outlook 已停用密码登录，需用下方「连接 Outlook」完成 OAuth 授权' },
  qiye: { imap: { host: 'imap.exmail.qq.com', port: 993, tls: true }, smtp: { host: 'smtp.exmail.qq.com', port: 465, tls: true }, passwordHint: '腾讯企业邮' },
  aliyun: { imap: { host: 'imap.qiye.aliyun.com', port: 993, tls: true }, smtp: { host: 'smtp.qiye.aliyun.com', port: 465, tls: true }, passwordHint: '阿里企业邮' },
};

function guessPreset(email) {
  const domain = String(email).split('@')[1] || '';
  if (/@qq\.com$/i.test(email)) return 'qq';
  if (/@163\.com$/i.test(email)) return '163';
  if (/@126\.com$/i.test(email)) return '126';
  if (/@sina\.com$/i.test(email)) return 'sina';
  if (/@gmail\.com$/i.test(email)) return 'gmail';
  if (/@(outlook|hotmail|live)\./i.test(email)) return 'outlook';
  if (/exmail\.qq\.com$/i.test(domain)) return 'qiye';
  if (/aliyun\.com$/i.test(domain)) return 'aliyun';
  return null;
}

function validAccountBody(body) {
  const email = String(body.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('邮箱地址格式不正确'), { status: 400 });
  const preset = body.preset || guessPreset(email);
  const base = PRESETS[preset] || {};
  const imap = { ...base.imap, ...body.imap };
  const smtp = { ...base.smtp, ...body.smtp };
  if (!imap.host || !smtp.host) throw Object.assign(new Error('请填写 IMAP / SMTP 服务器地址'), { status: 400 });
  const authUser = String(body.auth?.user ?? body.email ?? '').trim();
  const authPass = String(body.auth?.pass ?? body.password ?? '');
  if (!authUser || !authPass) throw Object.assign(new Error('请填写登录用户名与授权码'), { status: 400 });
  return {
    id: body.id || 'a_' + crypto.randomBytes(5).toString('hex'),
    email,
    displayName: String(body.displayName || email.split('@')[0]).slice(0, 60),
    color: /^#[0-9a-fA-F]{6}$/.test(body.color || '') ? body.color : '#2d6cf6',
    preset: preset || null,
    imap: { host: String(imap.host), port: Number(imap.port) || 993, tls: imap.tls !== false, allowInsecureTls: !!imap.allowInsecureTls },
    smtp: { host: String(smtp.host), port: Number(smtp.port) || 465, tls: smtp.tls !== false, allowInsecureTls: !!smtp.allowInsecureTls },
    auth: { user: authUser, pass: authPass },
    createdAt: body.createdAt || Date.now(),
  };
}

api.post('/accounts/test', guard, async (req, res) => {
  try {
    const acc = validAccountBody(req.body || {});
    await testAccount(acc);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

api.post('/accounts', guard, async (req, res) => {
  try {
    const acc = validAccountBody(req.body || {});
    const accounts = listAccounts(req.user.id);
    if (accounts.some((a) => a.email.toLowerCase() === acc.email.toLowerCase())) {
      return res.status(400).json({ error: '这个邮箱已经添加过了' });
    }
    accounts.push(acc);
    saveAccounts(req.user.id, accounts);
    audit(req.user.id, 'account-add', acc.email, clientIp(req));
    idle.ensureWatcher(req.user.id, acc.id).catch(() => { /* 内部兜底 */ });
    prefetch.ensurePrefetch(req.user.id, acc.id);
    res.json({ accounts: accounts.map(sanitizeAccount) });
  } catch (e) { fail(res, e); }
});

api.patch('/accounts/:id', guard, async (req, res) => {
  try {
    const accounts = listAccounts(req.user.id);
    const acc = accounts.find((a) => a.id === req.params.id);
    if (!acc) return res.status(404).json({ error: '账号不存在' });
    if (typeof req.body?.displayName === 'string') {
      const name = req.body.displayName.trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: '显示名称不能为空' });
      acc.displayName = name;
    }
    if (/^#[0-9a-fA-F]{6}$/.test(req.body?.color || '')) acc.color = req.body.color;
    if (req.body?.auth?.pass && acc.auth?.type !== 'oauth2') acc.auth.pass = String(req.body.auth.pass);
    saveAccounts(req.user.id, accounts);
    await dropConnections(req.user.id, acc.id);
    // 授权码可能变了：重启监听连接，用新凭据重连
    await idle.stopWatcher(req.user.id, acc.id);
    idle.ensureWatcher(req.user.id, acc.id).catch(() => { /* 内部兜底 */ });
    prefetch.ensurePrefetch(req.user.id, acc.id);
    res.json({ accounts: accounts.map(sanitizeAccount) });
  } catch (e) { fail(res, e); }
});

api.delete('/accounts/:id', guard, async (req, res) => {
  try {
    const accounts = listAccounts(req.user.id);
    const next = accounts.filter((a) => a.id !== req.params.id);
    if (next.length === accounts.length) return res.status(404).json({ error: '账号不存在' });
    saveAccounts(req.user.id, next);
    await dropConnections(req.user.id, req.params.id);
    await idle.stopWatcher(req.user.id, req.params.id);
    prefetch.stopPrefetch(req.user.id, req.params.id);
    cache.dropAccount(req.user.id, req.params.id);
    attachments.dropAccount(req.user.id, req.params.id);
    audit(req.user.id, 'account-remove', req.params.id, clientIp(req));
    res.json({ accounts: next.map(sanitizeAccount) });
  } catch (e) { fail(res, e); }
});

// ---------- Outlook OAuth2（设备码流程） ----------
// Azure 应用 ID 由用户在界面上填写一次，存实例级设置（全实例共用一个应用）。
// 它不是密钥：公共客户端（设备码/PKCE）流程不用 client_secret，这个 id 本来就公开。
// 所以既不加密、也不走环境变量 —— 用户在哪里填就在那里改。
api.get('/oauth/outlook', guard, (req, res) => {
  res.json({
    configured: !!getOutlookClientId(),
    clientId: getOutlookClientId(),
    registerUrl: REGISTER_URL,
    deviceLoginUrl: DEVICE_LOGIN_URL,
  });
});

api.post('/oauth/outlook/client-id', guard, (req, res) => {
  try {
    const id = setOutlookClientId(req.body?.clientId);
    audit(req.user.id, 'outlook-client-id', '设置 Azure 应用 ID', clientIp(req));
    res.json({ configured: true, clientId: id });
  } catch (e) { fail(res, e); }
});

api.post('/oauth/outlook/start', guard, async (req, res) => {
  try {
    res.json(await startDeviceCode());
  } catch (e) { fail(res, e); }
});

api.post('/oauth/outlook/poll', guard, async (req, res) => {
  try {
    const deviceCode = String(req.body?.deviceCode || '');
    if (!deviceCode) return res.status(400).json({ error: '缺少验证码，请重新获取' });
    const r = await pollDeviceCode(deviceCode);
    if (r.pending) {
      return res.json({ pending: true, reason: r.reason || 'pending', slowDown: r.reason === 'slow_down' });
    }

    const email = String(req.body?.email || r.token.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: '没能读到微软账号的邮箱地址，请在上方手动填写邮箱后重新连接' });
    }
    const accounts = listAccounts(req.user.id);
    if (accounts.some((a) => a.email.toLowerCase() === email.toLowerCase())) {
      return res.status(400).json({ error: '这个邮箱已经添加过了' });
    }
    const acc = {
      id: 'a_' + crypto.randomBytes(5).toString('hex'),
      email,
      displayName: String(req.body?.displayName || email.split('@')[0]).slice(0, 60),
      color: '#2d6cf6',
      preset: 'outlook',
      imap: { host: 'outlook.office365.com', port: 993, tls: true },
      // 微软要求 587 + STARTTLS；465 隐式 TLS 在 Exchange Online 上不开放
      smtp: { host: 'smtp.office365.com', port: 587, tls: false },
      auth: {
        type: 'oauth2',
        user: email,
        refreshToken: r.token.refreshToken || '',
        accessToken: r.token.accessToken,
        expiresAt: r.token.expiresAt,
        clientId: r.token.clientId,
      },
      createdAt: Date.now(),
    };
    accounts.push(acc);
    saveAccounts(req.user.id, accounts);
    audit(req.user.id, 'account-add', `outlook:${email}`, clientIp(req));
    idle.ensureWatcher(req.user.id, acc.id).catch(() => { /* 内部兜底 */ });
    prefetch.ensurePrefetch(req.user.id, acc.id);
    res.json({ done: true, email, accounts: accounts.map(sanitizeAccount) });
  } catch (e) { fail(res, e); }
});

// ---------- 收信 ----------
api.get('/folders', guard, async (req, res) => {
  try {
    const accountId = String(req.query.account || '');
    // 命中缓存先回（左栏永远即时渲染），真 LIST 在后台刷新给下一次用——
    // outlook 冷连接慢，同步等 LIST 一超时左栏整个账号就空了
    const cached = cache.getFolders(req.user.id, accountId);
    if (cached) {
      listFolders(req.user.id, accountId)
        .then((fresh) => cache.putFolders(req.user.id, accountId, fresh))
        .catch(() => { /* IMAP 暂时连不上就继续用上次的清单 */ });
      return res.json({ folders: cached, cached: true });
    }
    const folders = await listFolders(req.user.id, accountId);
    cache.putFolders(req.user.id, accountId, folders);
    res.json({ folders });
  } catch (e) { fail(res, e); }
});

api.post('/folders', guard, async (req, res) => {
  try {
    const account = String(req.body?.account || '');
    const raw = String(req.body?.path || '').trim();
    if (!raw) return res.status(400).json({ error: '文件夹名称不能为空' });
    if (raw.length > 100) return res.status(400).json({ error: '文件夹名称太长（最多 100 个字符）' });
    if (/[\u0000-\u001f]/.test(raw)) return res.status(400).json({ error: '文件夹名称含非法字符' });
    if (/^\/|\/$/.test(raw) || raw.includes('//')) return res.status(400).json({ error: '文件夹名称不能以分隔符开头或结尾' });
    const created = await createFolder(req.user.id, account, raw);
    const folders = await listFolders(req.user.id, account);
    cache.putFolders(req.user.id, account, folders);
    res.json({ ...created, folders });
  } catch (e) { fail(res, e); }
});

api.get('/messages', guard, async (req, res) => {
  try {
    const accountId = String(req.query.account || '');
    const folder = String(req.query.folder || 'INBOX');
    const opts = { page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 50 };
    // sync=1（手动刷新）：整夹快照重同步后回缓存，保证与服务器强一致
    if (req.query.sync) {
      try {
        await idle.resyncFolder(req.user.id, accountId, folder);
      } catch { /* 快照失败则退回直拉单页 */ }
    }
    const cached = cache.getPage(req.user.id, accountId, folder, opts);
    if (cached) return res.json(cached);
    // 该文件夹从未同步过：直拉兜底并把这一页写进缓存，同时后台把整夹补齐——
    // 不然这个夹只有 50 封索引，之后的翻页/搜索都不完整
    const fresh = await listMessages(req.user.id, accountId, folder, opts);
    if (fresh.uidvalidity) {
      cache.setUidvalidity(req.user.id, accountId, folder, fresh.uidvalidity);
      cache.upsertEnvelopes(req.user.id, accountId, folder, fresh.messages, fresh.uidvalidity);
      idle.resyncFolder(req.user.id, accountId, folder).catch(() => { /* 失败靠 watcher 重连或下次访问兜底 */ });
    }
    res.json(fresh);
  } catch (e) { fail(res, e); }
});

api.get('/message', guard, async (req, res) => {
  try {
    const accountId = String(req.query.account || '');
    const folder = String(req.query.folder || '');
    const messageUid = String(req.query.uid || '');
    // 正文缓存命中直接回（旗标由 IDLE 增量维护）；未命中拉一次并 write-through
    if (!req.query.sync) {
      const hit = cache.getBody(req.user.id, accountId, folder, messageUid);
      if (hit) return res.json({ uid: Number(messageUid), ...hit });
    }
    const fresh = await getMessage(req.user.id, accountId, folder, messageUid);
    cache.putBody(req.user.id, accountId, folder, messageUid, {
      from: fresh.from, to: fresh.to, cc: fresh.cc, subject: fresh.subject, date: fresh.date,
      messageId: fresh.messageId, inReplyTo: fresh.inReplyTo, references: fresh.references,
      text: fresh.text, html: fresh.html, attachments: fresh.attachments,
    });
    res.json(fresh);
  } catch (e) { fail(res, e); }
});

api.get('/attachment', guard, async (req, res) => {
  try {
    const inline = req.query.inline === '1';
    const att = await getAttachment(req.user.id, String(req.query.account || ''), String(req.query.folder || ''), String(req.query.uid || ''), Number(req.query.idx) | 0);
    res.setHeader('Content-Type', att.contentType);
    // 正文里的内嵌图片必须 inline，否则浏览器会当下载处理、<img> 直接裂图
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.filename)}`);
    // 附件内容跟着 uid 走、不会变，让浏览器也存一份
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(att.content);
  } catch (e) { fail(res, e); }
});

// ---------- 本地缓存概览 / 清理 ----------
api.get('/cache', guard, (req, res) => {
  try {
    const uid = req.user.id;
    const accounts = cache.stats(uid);
    const att = attachments.stats(uid);
    let dbBytes = 0;
    for (const f of ['cache.db', 'cache.db-wal']) {
      try { dbBytes += fs.statSync(path.join(userDir(uid), f)).size; } catch { /* 文件不存在 */ }
    }
    res.json({
      accounts,
      dbBytes,
      attachments: att,
      prefetch: prefetch.status(uid),
      totalBytes: dbBytes + att.bytes,
    });
  } catch (e) { fail(res, e); }
});

api.delete('/cache', guard, (req, res) => {
  try {
    const scope = String(req.query.scope || 'bodies');
    const account = req.query.account ? String(req.query.account) : null;
    let cleared = 0;
    if (scope === 'bodies' || scope === 'all') cleared = cache.clearBodies(req.user.id, account);
    if (scope === 'attachments' || scope === 'all') {
      if (account) attachments.dropAccount(req.user.id, account); else attachments.clearAll(req.user.id);
    }
    if (scope === 'all') {
      // 清完重新排队：下一次打开或后台预热会重新填，不用重启
      for (const a of listAccounts(req.user.id)) {
        if (!account || a.id === account) prefetch.kick(req.user.id, a.id);
      }
    }
    audit(req.user.id, 'cache-clear', `scope=${scope} cleared=${cleared}`, clientIp(req));
    res.json({ ok: true, cleared });
  } catch (e) { fail(res, e); }
});

api.post('/flags', guard, async (req, res) => {
  try {
    const { account, folder, action } = req.body || {};
    // 兼容单封（uid）与批量（uids）两种入参
    const uids = Array.isArray(req.body?.uids) ? req.body.uids.filter(Boolean) : (req.body?.uid ? [req.body.uid] : []);
    if (!uids.length) return res.status(400).json({ error: '没有选择邮件' });
    const map = {
      read: { add: ['\\Seen'] },
      unread: { remove: ['\\Seen'] },
      star: { add: ['\\Flagged'] },
      unstar: { remove: ['\\Flagged'] },
    };
    if (!map[action]) return res.status(400).json({ error: '未知操作' });
    const out = await setFlags(req.user.id, String(account), String(folder), uids, map[action]);
    try { cache.updateFlags(req.user.id, String(account), String(folder), uids, map[action]); } catch { /* 缓存回写失败不影响主流程 */ }
    res.json({ ...out, count: uids.length });
  } catch (e) { fail(res, e); }
});

api.post('/move', guard, async (req, res) => {
  try {
    const { account, folder, uids, dest } = req.body || {};
    if (!Array.isArray(uids) || !uids.length) return res.status(400).json({ error: '没有选择邮件' });
    const out = await moveMessages(req.user.id, String(account), String(folder), uids, String(dest));
    try {
      cache.moveUids(req.user.id, String(account), String(folder), uids);
      // 目的夹的 UID 由服务器重新分配，本地推算不了 —— 异步重同步目的夹
      idle.resyncFolder(req.user.id, String(account), String(dest)).catch(() => { /* 下次访问兜底 */ });
    } catch { /* 缓存回写失败不影响主流程 */ }
    res.json(out);
  } catch (e) { fail(res, e); }
});

api.post('/delete', guard, async (req, res) => {
  try {
    const { account, folder, uids } = req.body || {};
    if (!Array.isArray(uids) || !uids.length) return res.status(400).json({ error: '没有选择邮件' });
    const out = await deleteMessages(req.user.id, String(account), String(folder), uids);
    try { cache.removeUids(req.user.id, String(account), String(folder), uids); } catch { /* 缓存回写失败不影响主流程 */ }
    for (const u of uids) attachments.dropMessage(req.user.id, String(account), String(folder), u);
    res.json(out);
  } catch (e) { fail(res, e); }
});

api.get('/unread', guard, async (req, res) => {
  try {
    const accountId = String(req.query.account || '');
    // 缓存里有这个账号的登记就走 SQLite（零 IMAP 往返）；IDLE 会持续刷新计数
    const rows = cache.folderCounts(req.user.id).filter((r) => r.account_id === accountId);
    if (rows.length) {
      const counts = {};
      for (const r of rows) counts[r.path] = r.unseen;
      return res.json({ counts, cached: true });
    }
    res.json({ counts: await unseenCounts(req.user.id, accountId) });
  } catch (e) { fail(res, e); }
});

// 整夹全部已读 / 清空垃圾箱类文件夹 —— 作用于服务端全集，不依赖前端分页加载
api.post('/folders/read-all', guard, async (req, res) => {
  try {
    const { account, folder } = req.body || {};
    if (!account || !folder) return res.status(400).json({ error: '缺少账号或文件夹' });
    const acc = findAccount(req.user.id, String(account));
    if (!acc) return res.status(404).json({ error: '邮箱账号不存在' });
    audit(req.user.id, 'folder-read-all', `${acc.email}/${folder}`, clientIp(req));
    const out = await markAllRead(req.user.id, acc.id, String(folder));
    try { cache.addFlagToAll(req.user.id, acc.id, String(folder), '\\Seen'); } catch { /* 缓存回写失败不影响主流程 */ }
    res.json(out);
  } catch (e) { fail(res, e); }
});

api.post('/folders/empty', guard, async (req, res) => {
  try {
    const { account, folder } = req.body || {};
    if (!account || !folder) return res.status(400).json({ error: '缺少账号或文件夹' });
    const acc = findAccount(req.user.id, String(account));
    if (!acc) return res.status(404).json({ error: '邮箱账号不存在' });
    // 真删除不可恢复：只允许已删除/垃圾邮件两类文件夹，其余一律拒绝
    const node = (await listFolders(req.user.id, acc.id)).find((f) => f.path === String(folder));
    if (!node || !['\\Trash', '\\Junk'].includes(node.special)) {
      return res.status(400).json({ error: '只能清空「已删除」或「垃圾邮件」文件夹' });
    }
    const total = (cache.folderCounts(req.user.id) || [])
      .find((f) => f.account_id === acc.id && f.path === String(folder))?.total || 0;
    audit(req.user.id, 'folder-empty', `${acc.email}/${folder}`, clientIp(req));
    // 缓存先清、立即响应：界面马上变空，真正的 IMAP 删除在后台跑
    try { cache.clearFolder(req.user.id, acc.id, String(folder)); } catch { /* 缓存回写失败不影响主流程 */ }
    attachments.dropFolder(req.user.id, acc.id, String(folder));
    res.json({ ok: true, queued: true, count: total });
    emptyInBackground(req.user.id, acc.id, String(folder), total);
  } catch (e) { fail(res, e); }
});

api.delete('/folders', guard, async (req, res) => {
  try {
    const { account, folder } = req.body || {};
    if (!account || !folder) return res.status(400).json({ error: '缺少账号或文件夹' });
    const acc = findAccount(req.user.id, String(account));
    if (!acc) return res.status(404).json({ error: '邮箱账号不存在' });
    audit(req.user.id, 'folder-delete', `${acc.email}/${folder}`, clientIp(req));
    const out = await deleteFolder(req.user.id, acc.id, String(folder));
    try { cache.dropFolder(req.user.id, acc.id, String(folder)); } catch { /* ignore */ }
    attachments.dropFolder(req.user.id, acc.id, String(folder));
    try { cache.putFolders(req.user.id, acc.id, await listFolders(req.user.id, acc.id)); } catch { /* 清单刷新失败下次访问再试 */ }
    res.json(out);
  } catch (e) { fail(res, e); }
});

// ---------- 发信 / 草稿 ----------
api.post('/send', guard, async (req, res) => {
  try {
    const acc = findAccount(req.user.id, String(req.body?.account || ''));
    if (!acc) return res.status(404).json({ error: '邮箱账号不存在' });
    const { to, cc, bcc, subject, text, html, inReplyTo, references, attachments } = req.body || {};
    if (!to || (Array.isArray(to) && !to.length)) return res.status(400).json({ error: '请填写收件人' });
    if (!text && !html) return res.status(400).json({ error: '邮件内容不能为空' });
    const result = await sendMail(req.user.id, acc, { to, cc, bcc, subject, text, html, inReplyTo, references, attachments });
    if (req.body?.draftId) deleteDraft(req.user.id, String(req.body.draftId));
    audit(req.user.id, 'send', `${acc.email} -> ${Array.isArray(to) ? to.join(',') : to}`, clientIp(req));
    res.json(result);
  } catch (e) {
    const msg = String(e?.response || e?.message || e);
    if (/535|auth/i.test(msg)) {
      const hint = acc.auth?.type === 'oauth2'
        ? 'Outlook 授权已失效，请删除这个账号后重新连接一次'
        : 'SMTP 认证失败：请检查授权码';
      return fail(res, Object.assign(new Error(hint), { status: 401 }));
    }
    if (/554|553|550|spam|reject/i.test(msg)) return fail(res, Object.assign(new Error(`对方服务器拒收：${msg.slice(0, 160)}`), { status: 502 }));
    fail(res, Object.assign(new Error(`发送失败：${msg.slice(0, 160)}`), { status: 502 }));
  }
});

api.get('/drafts', guard, (req, res) => {
  res.json({ drafts: listDrafts(req.user.id) });
});

api.post('/drafts', guard, (req, res) => {
  const d = req.body || {};
  res.json({ draft: saveDraft(req.user.id, {
    id: d.id, accountId: d.accountId, to: d.to, cc: d.cc, subject: d.subject, text: d.text, html: d.html,
  }) });
});

api.delete('/drafts/:id', guard, (req, res) => {
  res.json(deleteDraft(req.user.id, req.params.id));
});

// ---------- 管理 ----------
api.get('/users', guard, (req, res) => {
  if (!['owner', 'admin'].includes(req.user.role)) return res.status(403).json({ error: '需要管理员权限' });
  res.json({ users: system().users.map(publicUser) });
});

api.post('/users', guard, (req, res) => {
  try {
    if (!['owner', 'admin'].includes(req.user.role)) return res.status(403).json({ error: '需要管理员权限' });
    const { username, password, displayName, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '请填写用户名和初始密码' });
    if (String(password).length < 8) return res.status(400).json({ error: '初始密码至少 8 位' });
    const user = createUser({
      username, password, displayName,
      role: role === 'admin' && req.user.role === 'owner' ? 'admin' : 'member',
    });
    audit(req.user.id, 'user-create', user.username, clientIp(req));
    res.json({ user: publicUser(user) });
  } catch (e) { fail(res, e); }
});

api.post('/users/:id/disable', guard, (req, res) => {
  try {
    if (!['owner', 'admin'].includes(req.user.role)) return res.status(403).json({ error: '需要管理员权限' });
    const target = findUser(req.params.id);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if (target.role === 'owner') return res.status(403).json({ error: '不能停用所有者' });
    target.disabled = !!req.body?.disabled;
    saveSystem();
    if (target.disabled) destroyUserSessions(target.id);
    audit(req.user.id, target.disabled ? 'user-disable' : 'user-enable', target.username, clientIp(req));
    res.json({ user: publicUser(target) });
  } catch (e) { fail(res, e); }
});

api.post('/users/:id/reset', guard, (req, res) => {
  try {
    if (!['owner', 'admin'].includes(req.user.role)) return res.status(403).json({ error: '需要管理员权限' });
    const target = findUser(req.params.id);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    const temp = crypto.randomBytes(6).toString('base64url');
    target.passHash = hashPassword(temp);
    saveSystem();
    destroyUserSessions(target.id);
    audit(req.user.id, 'user-reset', target.username, clientIp(req));
    res.json({ tempPassword: temp, note: '请线下安全地把临时密码交给对方，对方应尽快在「设置」里修改。' });
  } catch (e) { fail(res, e); }
});

api.delete('/users/:id', guard, async (req, res) => {
  try {
    if (req.user.role !== 'owner') return res.status(403).json({ error: '只有所有者可以删除用户' });
    const target = findUser(req.params.id);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if (target.role === 'owner') return res.status(403).json({ error: '不能删除所有者' });
    const sys = system();
    sys.users = sys.users.filter((u) => u.id !== target.id);
    saveSystem();
    destroyUserSessions(target.id);
    await import('node:fs').then((fs) => fs.rmSync(userDir(target.id), { recursive: true, force: true }));
    audit(req.user.id, 'user-delete', target.username, clientIp(req));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

api.get('/audit', guard, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: '需要所有者权限' });
  res.json({ audit: system().audit.slice(-500).reverse() });
});

// ---------- Agent 接入令牌 ----------
// 令牌只属于创建它的用户：MCP 那边拿到的 uid 就是这里 req.user.id，看不到别人的邮箱。
api.get('/agent/tokens', guard, (req, res) => {
  res.json({ tokens: listTokens(req.user.id), limit: TOKEN_LIMIT });
});

api.post('/agent/tokens', guard, (req, res) => {
  try {
    const out = createToken(req.user.id, req.body || {});
    audit(req.user.id, 'token-create', out.record.name, clientIp(req));
    // 明文只在这里返回一次，之后任何接口都拿不到
    res.json(out);
  } catch (e) { fail(res, e); }
});

api.delete('/agent/tokens/:id', guard, (req, res) => {
  try {
    revokeToken(req.user.id, req.params.id);
    audit(req.user.id, 'token-revoke', req.params.id, clientIp(req));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ---------- MCP 端点（必须在静态资源之前挂，否则 GET /mcp 会被 index.html 兜底） ----------
mountMcp(app);

// ---------- 静态资源 ----------
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: '请求体过大（附件总大小超限）' });
  fail(res, err);
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[mailnest] listening on http://${HOST}:${PORT}  data=${process.env.MAILNEST_DATA || 'data/'}`);
  // 重启后自动接上监听与正文预热：session cookie 有 14 天，用户不会因为重启而「重新登录」，
  // 不主动恢复的话 IDLE 要等下一次打开页面才启动，后台缓存也就一直不跑
  setTimeout(() => {
    for (const u of system().users || []) {
      if (u.disabled) continue;
      try { ensureUserWatchers(u.id); } catch { /* 单个用户异常不影响其他 */ }
    }
  }, 800).unref();
});

// ---------- 优雅退出 ----------
// NAS 面板升级/重启容器时，Docker 对 PID 1 发 SIGTERM。没有任何收尾逻辑时，
// 监听中的 IMAP 长连接被强拆会抛出未处理的 rejection，Node 直接以退出码 1 结束，
// 面板上就显示「非正常退出（exit 1）」。这里主动把连接/数据库关干净再以 0 退出。
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[mailnest] 收到 ${signal}，正在退出…`);
  const done = () => process.exit(0);
  setTimeout(done, 3000).unref(); // 兜底：任何一步卡住也不拖过 Docker 默认 10 秒宽限
  try {
    for (const set of sseClients.values()) for (const res of set) { try { res.end(); } catch { /* ignore */ } }
    sseClients.clear();
  } catch { /* ignore */ }
  try { idle.closeAll(); } catch { /* ignore */ }
  try { prefetch.closeAll(); } catch { /* ignore */ }
  try { cache.closeAll(); } catch { /* ignore */ }
  try { server.close(done); } catch { done(); }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// 兜底：单次未处理的 rejection / 异常不应把进程打成退出码 1（升级时最常见的假故障）
process.on('unhandledRejection', (e) => { console.error('[mailnest] unhandledRejection:', e?.message || e); });
process.on('uncaughtException', (e) => { console.error('[mailnest] uncaughtException:', e?.stack || e); });
