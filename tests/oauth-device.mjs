// Outlook 设备码流程的离线单测：把 fetch 换掉，跑完整的设备码 / 轮询 / 续期逻辑
// 用法：node tests/oauth-device.mjs
process.env.MAILNEST_DATA = process.env.MAILNEST_DATA || '.oauth-test';

const { ensureDataDirs, saveSystem, system } = await import('../server/store.js');
ensureDataDirs();

const oauth = await import('../server/oauth.js');

let pass = 0; let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

function fakeJwt(payload) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none', typ: 'JWT' })}.${b(payload)}.sig`;
}

// ---------- 伪造微软端点 ----------
const realFetch = globalThis.fetch;
let tokenReply = null;      // { status, body }
let deviceReply = null;
const seen = [];

globalThis.fetch = async (url, opts = {}) => {
  const body = String(opts.body || '');
  seen.push({ url: String(url), body });
  const reply = String(url).endsWith('/devicecode') ? deviceReply : tokenReply;
  const r = reply || { status: 500, body: { error: 'not_stubbed' } };
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    text: async () => JSON.stringify(r.body),
  };
};

const ACCESS = fakeJwt({ preferred_username: 'demo@outlook.com', aud: 'https://outlook.office.com' });

try {
  // 1. 初始没有应用 ID
  ok('初始未配置应用 ID', oauth.getOutlookClientId() === '');

  // 2. 格式校验
  let err = null;
  try { oauth.setOutlookClientId('not-a-guid'); } catch (e) { err = e; }
  ok('错误格式被拒绝', err && err.status === 400 && /格式/.test(err.message));

  // 3. 正确格式保存
  const CLIENT = '11111111-2222-3333-4444-555555555555';
  oauth.setOutlookClientId(CLIENT);
  ok('应用 ID 已保存', oauth.getOutlookClientId() === CLIENT);
  ok('应用 ID 落盘', system().settings.outlookClientId === CLIENT);

  // 4. 没配 ID 时不允许发起授权
  const blank = { ...system().settings };
  delete system().settings.outlookClientId;
  err = null;
  try { await oauth.startDeviceCode(); } catch (e) { err = e; }
  ok('未配置时拒绝发起授权', err && err.status === 400 && /还没有配置/.test(err.message));
  system().settings.outlookClientId = CLIENT;
  saveSystem();

  // 5. 设备码
  deviceReply = {
    status: 200,
    body: { user_code: 'ABCD-EFGH', device_code: 'dev-123', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 },
  };
  const dev = await oauth.startDeviceCode();
  ok('拿到设备码', dev.userCode === 'ABCD-EFGH' && dev.interval === 5);
  ok('请求带了正确的 scope', /IMAP\.AccessAsUser\.All/.test(seen.at(-1).body) && !/graph\.microsoft/.test(seen.at(-1).body));

  // 6. 用户还没操作
  tokenReply = { status: 400, body: { error: 'authorization_pending' } };
  ok('pending 不报错', (await oauth.pollDeviceCode('dev-123')).pending === true);

  tokenReply = { status: 400, body: { error: 'slow_down' } };
  const slow = await oauth.pollDeviceCode('dev-123');
  ok('slow_down 让前端放慢', slow.pending === true && slow.reason === 'slow_down');

  // 7. 成功换到 token
  tokenReply = {
    status: 200,
    body: { access_token: ACCESS, refresh_token: 'rt-1', expires_in: 3600, id_token: fakeJwt({ preferred_username: 'demo@outlook.com' }) },
  };
  const done = await oauth.pollDeviceCode('dev-123');
  ok('授权成功', done.pending === false && done.token.refreshToken === 'rt-1');
  ok('从 token 里解析出邮箱', done.token.email === 'demo@outlook.com');
  ok('返回过期时间', done.token.expiresAt > Date.now() + 3000 * 1000);

  // 8. 用户拒绝 / 码过期
  tokenReply = { status: 400, body: { error: 'authorization_declined' } };
  err = null;
  try { await oauth.pollDeviceCode('dev-123'); } catch (e) { err = e; }
  ok('用户拒绝有中文提示', err && /取消/.test(err.message));

  tokenReply = { status: 400, body: { error: 'expired_token' } };
  err = null;
  try { await oauth.pollDeviceCode('dev-123'); } catch (e) { err = e; }
  ok('验证码过期有中文提示', err && /过期/.test(err.message));

  // 9. 应用 ID 有问题（最常见：没开公共客户端流）
  tokenReply = { status: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000218: request body must contain client_secret' } };
  err = null;
  try { await oauth.pollDeviceCode('dev-123'); } catch (e) { err = e; }
  ok('应用 ID 错误有可操作提示', err && /公共客户端流/.test(err.message));

  // 10. 续期
  tokenReply = { status: 200, body: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 } };
  const r1 = await oauth.refreshAccessToken('rt-1');
  ok('续期成功并轮换 refresh_token', r1.accessToken === 'at-2' && r1.refreshToken === 'rt-2');

  // 11. refresh_token 失效
  tokenReply = { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS70000: revoked' } };
  err = null;
  try { await oauth.refreshAccessToken('rt-1'); } catch (e) { err = e; }
  ok('失效有中文提示并可重连', err && err.status === 401 && /重新添加/.test(err.message));

  // 12. 没有 refresh_token
  err = null;
  try { await oauth.refreshAccessToken(''); } catch (e) { err = e; }
  ok('空 refresh_token 直接报错', err && err.status === 401);
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
