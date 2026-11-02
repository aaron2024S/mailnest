// Agent 接入令牌：给 MCP 客户端用的长期凭据。
// 设计取舍：
//  - 只存 SHA-256，明文只在生成时返回一次（DB 泄露不等于 token 泄露）
//  - token 里带 8 位 id 前缀，校验时按 id 直接定位，日志里也不出现明文
//  - scope 分三档：read（读）、write（标记/移动/删除）、send（发信）；最小权限靠调用方自己勾
//  - 绑定 uid：MCP 只能看到该用户的邮箱（账号本来就按 users/<uid>/ 隔离）
import crypto from 'node:crypto';
import { system, saveSystem, findUser } from './store.js';

export const SCOPES = ['read', 'write', 'send'];
const PREFIX = 'mn_mcp_';

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// 列表/日志里只暴露这些字段，hash 永不出内存
function publicView(t) {
  return {
    id: t.id,
    name: t.name,
    scopes: t.scopes,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt || 0,
    calls: t.calls || 0,
    expiresAt: t.expiresAt || 0,
    expired: !!t.expiresAt && t.expiresAt < Date.now(),
  };
}

export function createToken(uid, { name, scopes, expiresInDays = 90 } = {}) {
  const label = String(name || '').trim().slice(0, 40) || '未命名客户端';
  const want = Array.isArray(scopes) ? scopes.filter((s) => SCOPES.includes(s)) : [];
  if (!want.length) throw Object.assign(new Error('至少要选一个权限'), { status: 400 });

  const days = Number(expiresInDays);
  if (!Number.isFinite(days) || days < 0 || days > 3650) {
    throw Object.assign(new Error('有效期需在 0 到 3650 天之间（0 表示永不过期）'), { status: 400 });
  }

  const sys = system();
  if (!Array.isArray(sys.mcpTokens)) sys.mcpTokens = [];
  // 每人最多 20 个，防止列表无限膨胀
  if (sys.mcpTokens.filter((t) => t.uid === uid).length >= 20) {
    throw Object.assign(new Error('每个账号最多创建 20 个令牌，请先撤销不用的'), { status: 400 });
  }

  const id = crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  const raw = `${PREFIX}${id}_${secret}`;
  const record = {
    id,
    uid,
    name: label,
    hash: sha256(raw),
    scopes: SCOPES.filter((s) => want.includes(s)),
    createdAt: Date.now(),
    expiresAt: days > 0 ? Date.now() + days * 86400000 : 0,
    lastUsedAt: 0,
    calls: 0,
  };
  sys.mcpTokens.push(record);
  saveSystem();
  // 明文只在这里出现一次
  return { token: raw, record: publicView(record) };
}

export function listTokens(uid) {
  const sys = system();
  return (sys.mcpTokens || []).filter((t) => t.uid === uid).map(publicView);
}

export function revokeToken(uid, id) {
  const sys = system();
  const list = sys.mcpTokens || [];
  const i = list.findIndex((t) => t.id === id && t.uid === uid);
  if (i < 0) throw Object.assign(new Error('令牌不存在'), { status: 404 });
  list.splice(i, 1);
  saveSystem();
  return { ok: true };
}

// 校验：返回 { uid, scopes, tokenId, name } 或 null。任何一步不过都当无效。
export function verifyToken(raw) {
  const s = String(raw || '').trim();
  if (!s.startsWith(PREFIX)) return null;
  const rest = s.slice(PREFIX.length);
  const sep = rest.indexOf('_');
  if (sep <= 0) return null;
  const id = rest.slice(0, sep);

  const sys = system();
  const t = (sys.mcpTokens || []).find((x) => x.id === id);
  if (!t) return null;
  // 定长比较，避免按字节短路泄露 hash 前缀
  const got = Buffer.from(sha256(s), 'hex');
  const want = Buffer.from(t.hash, 'hex');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;

  if (t.expiresAt && t.expiresAt < Date.now()) return null;
  const user = findUser(t.uid);
  if (!user || user.disabled) return null;

  return { uid: t.uid, scopes: t.scopes, tokenId: t.id, name: t.name };
}

// 用量记账：calls 走内存累加（_system 是单例，后续任何一次落盘都会带上），
// 但「最后使用时间」需要写盘才看得见 —— 首次立即写一次，之后一分钟最多一次。
const lastSaved = new Map();
export function touchToken(tokenId, ip = '') {
  const t = (system().mcpTokens || []).find((x) => x.id === tokenId);
  if (!t) return;
  t.calls = (t.calls || 0) + 1;
  const now = Date.now();
  const first = !t.lastUsedAt;
  t.lastUsedAt = now;
  if (ip) t.lastUsedIp = ip;
  if (first || now - (lastSaved.get(tokenId) || 0) > 60000) {
    lastSaved.set(tokenId, now);
    saveSystem();
  }
}
