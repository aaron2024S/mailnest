// MCP 接入验证，分两段：
//   A. tokens.js 的单元断言（独立数据目录，不起服务）—— 令牌格式、哈希、过期、撤销
//   B. HTTP 端到端（起真实进程）—— 建管理员 → 发令牌 → initialize → tools/list → tools/call → 撤销
// 用法：node tests/mcp.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let pass = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { failed++; console.error(`✗ ${name} ${extra}`); }
};

// ============ A. 令牌单元断言 ============
const UNIT_DIR = path.resolve('.mcp-test-unit');
fs.rmSync(UNIT_DIR, { recursive: true, force: true });
process.env.MAILNEST_DATA = UNIT_DIR;

const store = await import('../server/store.js');
const tok = await import('../server/tokens.js');

store.ensureDataDirs();
const user = store.createUser({ username: 'unit', password: 'password123', role: 'owner' });

{
  const out = tok.createToken(user.id, { name: '单元测试', scopes: ['read'], expiresInDays: 30 });
  ok('令牌格式 mn_mcp_<id>_<secret>', /^mn_mcp_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}$/.test(out.token), out.token);
  ok('返回记录带 scope', JSON.stringify(out.record.scopes) === '["read"]');

  const stored = store.system().mcpTokens[0];
  ok('落盘只有哈希，没有明文', !JSON.stringify(stored).includes(out.token.split('_').pop()), JSON.stringify(Object.keys(stored)));
  ok('落盘 hash 是 64 位 hex', /^[0-9a-f]{64}$/.test(stored.hash));

  const v = tok.verifyToken(out.token);
  ok('有效令牌可校验', v && v.uid === user.id, JSON.stringify(v));
  ok('校验结果带 scope', v && JSON.stringify(v.scopes) === '["read"]');

  ok('篡改 secret 校验失败', tok.verifyToken(out.token.slice(0, -1) + (out.token.endsWith('A') ? 'B' : 'A')) === null);
  ok('空串校验失败', tok.verifyToken('') === null);
  ok('非 mn_mcp 前缀校验失败', tok.verifyToken('Bearer xyz') === null);

  // 过期
  store.system().mcpTokens[0].expiresAt = Date.now() - 1;
  ok('过期令牌校验失败', tok.verifyToken(out.token) === null);
  store.system().mcpTokens[0].expiresAt = 0;
  ok('expiresAt=0 视为永不过期', tok.verifyToken(out.token) !== null);
}

{
  // scope 过滤：未知值被丢掉，顺序规范化为 read/write/send
  const out = tok.createToken(user.id, { name: '整理', scopes: ['send', 'root', 'read', 'write'] });
  ok('未知 scope 被丢弃并规范化', JSON.stringify(out.record.scopes) === '["read","write","send"]', JSON.stringify(out.record.scopes));
  ok('不传 scopes 直接拒绝', (() => { try { tok.createToken(user.id, {}); return false; } catch { return true; } })());
  ok('有效期越界拒绝', (() => { try { tok.createToken(user.id, { scopes: ['read'], expiresInDays: 9999 }); return false; } catch { return true; } })());
}

{
  // 撤销
  const out = tok.createToken(user.id, { name: '待撤销', scopes: ['read'] });
  ok('撤销前可校验', tok.verifyToken(out.token) !== null);
  tok.revokeToken(user.id, out.record.id);
  ok('撤销后校验失败', tok.verifyToken(out.token) === null);
  ok('撤销不存在的 id 报 404', (() => {
    try { tok.revokeToken(user.id, 'nope'); return false; }
    catch (e) { return e.status === 404; }
  })());
}

{
  // 隔离：别人的令牌撤不掉，也列不出来
  const other = store.createUser({ username: 'other', password: 'password123' });
  const out = tok.createToken(user.id, { name: '私有', scopes: ['read'] });
  ok('别人看不到我的令牌', tok.listTokens(other.id).length === 0);
  ok('别人撤不掉我的令牌', (() => {
    try { tok.revokeToken(other.id, out.record.id); return false; }
    catch (e) { return e.status === 404; }
  })());
  ok('我自己的列表能看到', tok.listTokens(user.id).some((t) => t.id === out.record.id));
}

{
  // 停用用户的令牌应立即失效
  const u2 = store.createUser({ username: 'gone', password: 'password123' });
  const out = tok.createToken(u2.id, { name: '停用测试', scopes: ['read'] });
  ok('停用前可校验', tok.verifyToken(out.token) !== null);
  store.findUser(u2.id).disabled = true;
  store.saveSystem();
  ok('用户被停用后令牌失效', tok.verifyToken(out.token) === null);
}

{
  // 每人上限 20 个
  const u3 = store.createUser({ username: 'many', password: 'password123' });
  let hitLimit = false;
  for (let i = 0; i < 25; i++) {
    try { tok.createToken(u3.id, { name: `t${i}`, scopes: ['read'] }); }
    catch (e) { hitLimit = e.status === 400; break; }
  }
  ok('超过 20 个令牌被拒', hitLimit && tok.listTokens(u3.id).length === 20, String(tok.listTokens(u3.id).length));
}

fs.rmSync(UNIT_DIR, { recursive: true, force: true });

// ============ B. HTTP 端到端 ============
const PORT = Number(process.env.MCP_TEST_PORT) || 3271;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.resolve('.mcp-test');
fs.rmSync(DATA, { recursive: true, force: true });

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: path.resolve('.'),
  env: { ...process.env, PORT: String(PORT), MAILNEST_DATA: DATA },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });
const cleanup = () => { try { child.kill(); } catch { /* 已退出 */ } };
process.on('exit', cleanup);

async function waitReady(timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/api/setup-status`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

let cookie = '';
async function req(method, p, body, useCookie = true) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'MailNest',
      ...(useCookie && cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    const kv = c.split(';')[0];
    if (kv.startsWith('mn_session=')) cookie = kv;
  }
  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }
  return { status: res.status, data };
}

async function rpcCall(token, payload) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data };
}

const callTool = (token, name, args = {}) => rpcCall(token, {
  jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args },
});

const ready = await waitReady();
ok('服务启动', ready, serverLog.slice(-300));
if (!ready) {
  console.error(serverLog);
  process.exit(1);
}

let r = await req('POST', '/api/setup', { username: 'admin', password: 'password123' }, false);
ok('创建管理员', r.status === 200 && !!cookie, JSON.stringify(r.data));

r = await rpcCall('', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
ok('不带令牌 → 401', r.status === 401, String(r.status));
ok('401 说明要带 Bearer', /Bearer/.test(r.data?.error?.message || ''), JSON.stringify(r.data));
ok('401 是标准 JSON-RPC 错误码', r.data?.error?.code === -32001, JSON.stringify(r.data?.error));

r = await rpcCall('mn_mcp_deadbeef_notarealsecret', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
ok('伪造令牌 → 401', r.status === 401, String(r.status));
r = await rpcCall('not-a-token-at-all', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
ok('格式不对的令牌 → 401', r.status === 401, String(r.status));

r = await req('POST', '/api/agent/tokens', { name: '测试只读', scopes: ['read'], expiresInDays: 30 });
const readToken = r.data?.token;
ok('生成只读令牌', r.status === 200 && /^mn_mcp_/.test(readToken || ''), JSON.stringify(r.data?.record || r.data));
ok('令牌返回时带 scope', JSON.stringify(r.data?.record?.scopes) === '["read"]', JSON.stringify(r.data?.record));

r = await req('GET', '/api/agent/tokens');
const listed = r.data?.tokens?.[0] || {};
ok('令牌列表返回一条', r.data?.tokens?.length === 1, JSON.stringify(r.data));
ok('列表不含 hash/明文', !('hash' in listed) && !('token' in listed), JSON.stringify(Object.keys(listed)));
ok('列表标记未使用过', listed.calls === 0 && listed.lastUsedAt === 0, JSON.stringify(listed));
ok('返回每人上限 limit', r.data?.limit === 20, String(r.data?.limit));

// 排序约定：新生成的在最上面（与「刚生成就插到首位」一致，刷新后顺序不反转）
await req('POST', '/api/agent/tokens', { name: '后来的', scopes: ['read'], expiresInDays: 30 });
r = await req('GET', '/api/agent/tokens');
ok('列表新的在顶部', r.data?.tokens?.[0]?.name === '后来的', JSON.stringify(r.data?.tokens?.map((t) => t.name)));
await req('DELETE', `/api/agent/tokens/${r.data.tokens[0].id}`);
r = await req('GET', '/api/agent/tokens');
ok('撤销后还原为单条', r.data?.tokens?.length === 1 && r.data?.tokens?.[0]?.name === '测试只读', JSON.stringify(r.data?.tokens?.map((t) => t.name)));

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-test', version: '1.0.0' } },
};
r = await rpcCall(readToken, INIT);
ok('initialize 成功', r.status === 200 && !!r.data?.result, JSON.stringify(r.data));
ok('协商出版本号', typeof r.data?.result?.protocolVersion === 'string', JSON.stringify(r.data?.result));
ok('声明 tools 能力', !!r.data?.result?.capabilities?.tools, JSON.stringify(r.data?.result?.capabilities));
ok('serverInfo 是 mailnest', r.data?.result?.serverInfo?.name === 'mailnest', JSON.stringify(r.data?.result?.serverInfo));
ok('serverInfo 带版本号', /^\d+\.\d+\.\d+/.test(r.data?.result?.serverInfo?.version || ''), JSON.stringify(r.data?.result?.serverInfo));

r = await rpcCall(readToken, { jsonrpc: '2.0', method: 'notifications/initialized' });
ok('initialized 通知被接受', r.status >= 200 && r.status < 300, String(r.status));

r = await rpcCall(readToken, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
const tools = r.data?.result?.tools || [];
const names = tools.map((t) => t.name).sort();
ok('工具数量 11', tools.length === 11, `${tools.length}: ${names.join(',')}`);
const expect = ['create_folder', 'delete_messages', 'list_accounts', 'list_folders', 'list_messages',
  'move_messages', 'read_message', 'reply_message', 'save_draft', 'send_message', 'set_flags'];
ok('工具名齐全', expect.every((n) => names.includes(n)), names.join(','));
ok('每个工具有描述', tools.every((t) => t.description && t.description.length > 8), '');
ok('未越权：没有账号/密码/令牌管理类工具',
  !tools.some((t) => /account_|password|user|oauth|token/i.test(t.name)), names.join(','));
ok('只读工具带 readOnlyHint', tools.filter((t) => /^list_|^read_/.test(t.name)).every((t) => t.annotations?.readOnlyHint === true), '');

r = await callTool(readToken, 'list_accounts');
ok('list_accounts 能执行', r.status === 200 && !!r.data?.result, JSON.stringify(r.data));
const accText = r.data?.result?.content?.[0]?.text || '';
ok('无账号时返回空列表而不是报错', !r.data?.result?.isError && /"accounts":\s*\[\]/.test(accText), accText.slice(0, 120));
ok('空列表带下一步指引', /还没有添加任何邮箱账号/.test(accText), accText.slice(0, 160));

r = await callTool(readToken, 'list_messages', { account: 'nope@example.com' });
ok('不存在的账号给可读错误', r.data?.result?.isError === true, JSON.stringify(r.data?.result).slice(0, 160));
ok('错误里说明原因', /找不到账号|还没有添加/.test(r.data?.result?.content?.[0]?.text || ''), '');

r = await callTool(readToken, 'set_flags', { uids: [1], action: 'read' });
ok('只读令牌写操作被拒', r.data?.result?.isError === true, '');
ok('拒绝文案点明缺哪个权限', /整理邮件/.test(r.data?.result?.content?.[0]?.text || ''), r.data?.result?.content?.[0]?.text);

r = await callTool(readToken, 'send_message', { to: ['a@b.com'], subject: 'x', text: 'y' });
ok('只读令牌发信被拒', r.data?.result?.isError === true, '');

r = await callTool(readToken, 'set_flags', { uids: [], action: 'nope' });
ok('非法 action 被 schema 拦住', r.status >= 400 || r.data?.error || r.data?.result?.isError, JSON.stringify(r.data).slice(0, 160));

r = await req('GET', '/api/agent/tokens');
const used = r.data?.tokens?.[0] || {};
ok('调用后记录次数', used.calls > 0, String(used.calls));
ok('调用后记录最后使用时间', used.lastUsedAt > 0, String(used.lastUsedAt));

r = await req('DELETE', `/api/agent/tokens/${used.id}`);
ok('撤销令牌', r.status === 200 && r.data?.ok === true, JSON.stringify(r.data));
r = await rpcCall(readToken, INIT);
ok('撤销后原令牌 → 401', r.status === 401, String(r.status));
r = await req('GET', '/api/agent/tokens');
ok('撤销后列表为空', r.data?.tokens?.length === 0, JSON.stringify(r.data));

r = await req('POST', '/api/agent/tokens', { name: 'x', scopes: [] });
ok('不选权限被拒', r.status === 400, JSON.stringify(r.data));
r = await req('POST', '/api/agent/tokens', { name: 'x', scopes: ['root'] });
ok('全是未知 scope 被拒', r.status === 400, JSON.stringify(r.data));
r = await req('POST', '/api/agent/tokens', { name: 'x', scopes: ['read'], expiresInDays: 99999 });
ok('超长有效期被拒', r.status === 400, JSON.stringify(r.data));

r = await rpcCall(readToken, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
ok('未知工具被拒', !!r.data?.error || r.data?.result?.isError === true, JSON.stringify(r.data).slice(0, 160));

const getRes = await fetch(`${BASE}/mcp`);
ok('GET /mcp → 405', getRes.status === 405, String(getRes.status));

// 未登录不能管令牌
r = await req('GET', '/api/agent/tokens', null, false);
ok('未登录不能列出令牌', r.status === 401, String(r.status));

cleanup();
await new Promise((res) => setTimeout(res, 250));
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 上偶发占用 */ }

console.log(`\n${failed ? '有失败' : '全部通过'}：${pass} 项断言${failed ? `，${failed} 项失败` : ''}`);
process.exit(failed ? 1 : 0);
