// 草稿这条链的回归测试：写一份 → 反复改 → 多份并存 → 发出去。
//
// 之前的覆盖只有「save 成功」「list 能看到」「删两次报错」，全都是 happy path，
// 而且验证方式是从中文提示里正则抠 id。真正的问题一个都没碰到：
//   - 想改草稿？没有 update_draft，只能再存一份，于是同一个收件人出现两份同名草稿，
//     发的时候分不清哪份是新的（实测就这么发生了）
//   - list_drafts 提示「请去网页端编辑」，等于把用户推走
//   - 草稿存不了抄送/密送，发送时也不发
//   - 收件人显示名带逗号（"Smith, John" <j@x.com>）会被拆成两个无效地址
//
// 用临时数据目录 + 假 SMTP，不碰真实邮箱。用法：node tests/draft.mjs
import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { z } from 'zod';
import { startFakeSmtp } from './fake-smtp.mjs';

let pass = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { failed++; console.error(`✗ ${name} ${extra}`); }
};

const DIR = path.resolve('.draft-test');
fs.rmSync(DIR, { recursive: true, force: true });
process.env.MAILNEST_DATA = DIR;

const store = await import('../server/store.js');
const mail = await import('../server/mail.js');
const { registerTools } = await import('../server/mcp-tools.js');

store.ensureDataDirs();
const user = store.createUser({ username: 'draft', password: 'password123', role: 'owner' });
const uid = user.id;

const { server, received, port } = await startFakeSmtp();

const ACC1 = {
  id: 'acc_163', email: 'me@example.com', displayName: '163邮箱',
  auth: { user: 'me@example.com', pass: 'secret' }, smtp: { host: '127.0.0.1', port, tls: false },
};
const ACC2 = {
  id: 'acc_qq', email: 'second@example.net', displayName: 'QQ邮箱',
  auth: { user: 'second@example.net', pass: 'secret' }, smtp: { host: '127.0.0.1', port, tls: false },
};
store.saveAccounts(uid, [ACC1, ACC2]);

const tools = {};
// 生产里 MCP SDK 会先用 inputSchema 校验（也就把 addrList 这类宽容层跑一遍），
// 测试如果直接调 run，就跳过了这层 —— 传 to:'' 会以字符串原样进 run，
// 跟线上行为不一致。这里补上同一道校验。
registerTools({
  registerTool: (name, meta, fn) => {
    const shape = z.object(meta.inputSchema || {});
    tools[name] = (args) => fn(shape.parse(args ?? {}));
  },
}, { uid, scopes: ['read', 'write', 'send'] });

const call = async (name, args) => {
  let res;
  try {
    res = await tools[name](args);
  } catch (e) {
    // 校验失败在线上是 isError，这里也归成同一类
    return { err: true, text: String(e.message || e), json: null };
  }
  const text = (res.content || []).map((c) => c.text).join('');
  let json = null;
  try { json = JSON.parse(text); } catch { /* 错误信息是纯文本 */ }
  return { err: !!res.isError, text, json };
};

// 等假服务器收完报文（DATA 事件是异步的）
const waitRaw = async (before) => {
  for (let i = 0; i < 150 && received.length === before; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return received[received.length - 1] || '';
};

// ---------- A. 写草稿 ----------
let r = await call('save_draft', {
  account: '163邮箱', to: ['a@example.com'], subject: '季度对账', text: '正文第一段',
});
const d1 = r.json?.id;
ok('A1 指定账号能存草稿，返回可解析 JSON 带 id',
  !r.err && /^d_[a-z0-9]+$/.test(String(d1 || '')), r.text.slice(0, 120));
ok('A1 存完就是可发状态', r.json?.canSend === true, JSON.stringify(r.json?.canSend));

r = await call('save_draft', {
  account: '163邮箱', to: ['b@example.com'], cc: ['c@example.com'], bcc: ['d@example.com'],
  subject: '带抄送', text: '抄送正文',
});
const d2 = r.json?.id;
ok('A2 抄送/密送能存进草稿（以前连字段都没有）',
  !r.err && r.json.cc.includes('c@example.com') && r.json.bcc.includes('d@example.com'),
  JSON.stringify({ cc: r.json?.cc, bcc: r.json?.bcc }));

r = await call('save_draft', { to: ['a@example.com'], subject: '没指定账号', text: 'x' });
ok('A3 多个账号时不替用户挑，问清是哪个账号',
  r.err && /请先确认用哪个邮箱/.test(r.text), r.text.slice(0, 120));

r = await call('save_draft', {
  account: '163邮箱', to: ['"Smith, John" <j@example.com>'], subject: '带逗号的显示名', text: 'x',
});
const d4 = r.json?.id;
ok('A4 收件人显示名里的逗号不会被拆成两个地址',
  !r.err && r.json.to === '"Smith, John" <j@example.com>', String(r.json?.to));

r = await call('save_draft', { account: '163邮箱', subject: '还没想好发给谁', text: '先存着' });
const d5 = r.json?.id;
ok('A5 没写收件人也能存，但明确标出不能发',
  !r.err && r.json.canSend === false && /收件人/.test(String(r.json.problem)),
  JSON.stringify({ canSend: r.json?.canSend, problem: r.json?.problem }));

// ---------- B. 修改草稿 ----------
r = await call('update_draft', { draftId: d1, subject: '季度对账（终版）' });
ok('B1 改主题成功，id 不变（还是同一份）',
  !r.err && r.json.id === d1 && r.json.subject === '季度对账（终版）', r.text.slice(0, 120));
ok('B1 只传主题时正文原样保留', r.json?.length === 5, String(r.json?.length));

const countBefore = (await call('list_drafts', {})).json.total;
r = await call('update_draft', { draftId: d1, text: '正文第一段\n补充：已核对' });
const countAfter = (await call('list_drafts', {})).json.total;
ok('B2 改正文不会多出一份草稿（这是之前最大的坑）',
  countBefore === countAfter && r.json?.id === d1, `${countBefore} → ${countAfter}`);
ok('B2 改完读到的是新正文', /补充：已核对/.test(String(r.json?.excerpt)), r.json?.excerpt);

r = await call('update_draft', { draftId: d5, to: ['e@example.com'] });
ok('B3 补上收件人后变成可发',
  !r.err && r.json.canSend === true && r.json.problem === undefined, JSON.stringify(r.json?.problem));

r = await call('update_draft', { draftId: d5, to: '' });
ok('B4 传空串表示清空收件人（和「没传」是两件事）',
  !r.err && r.json.to === '' && r.json.canSend === false, JSON.stringify({ to: r.json?.to }));

r = await call('update_draft', { draftId: d1, account: 'QQ邮箱' });
ok('B5 能把草稿改到另一个账号下',
  r.json?.account?.email === 'second@example.net', JSON.stringify(r.json?.account));

r = await call('update_draft', { draftId: d1 });
ok('B6 什么都没说要改就报错，不静默无操作',
  r.err && /没看出要改什么/.test(r.text), r.text.slice(0, 100));

r = await call('update_draft', { draftId: d1, text: '   ' });
ok('B7 正文改成空白被拒，并指向 delete_draft',
  r.err && /正文不能改成空/.test(r.text) && /delete_draft/.test(r.text), r.text.slice(0, 120));

r = await call('update_draft', { draftId: 'd_nosuchid', subject: 'x' });
ok('B8 改不存在的草稿给可读错误，并列出当前有哪些',
  r.err && /找不到草稿/.test(r.text), r.text.slice(0, 160));

// ---------- C. 多份草稿 ----------
let l = await call('list_drafts', {});
ok('C1 四份草稿都在', l.json?.total === 4, String(l.json?.total));
ok('C1 最近改的排最前（改完马上想看的就是它）',
  l.json?.drafts?.[0]?.id === d1, JSON.stringify(l.json?.drafts?.map((x) => x.id)));

const idsBefore = l.json.drafts.map((x) => x.id).sort().join(',');
await call('update_draft', { draftId: d2, subject: '带抄送-改' });
const l2 = await call('list_drafts', {});
ok('C2 改一份不影响其他份存在',
  l2.json.drafts.map((x) => x.id).sort().join(',') === idsBefore, l2.json.drafts.map((x) => x.id).join(','));
ok('C2 只有被改的那份内容变了',
  l2.json.drafts.find((x) => x.id === d2)?.subject === '带抄送-改'
  && l2.json.drafts.find((x) => x.id === d4)?.subject === '带逗号的显示名');

const qq = await call('list_drafts', { account: 'QQ邮箱' });
ok('C3 按账号筛只回该账号的草稿',
  !qq.err && qq.json.drafts.length > 0
  && qq.json.drafts.every((x) => x.account?.email === 'second@example.net'),
  JSON.stringify(qq.json?.drafts?.map((x) => x.account?.email)));

const kw = await call('list_drafts', { subject: '对账' });
ok('C4 按主题关键词能筛到（草稿多了才找得到）',
  !kw.err && kw.json.total === 1 && kw.json.drafts[0].id === d1, String(kw.json?.total));

const lim = await call('list_drafts', { limit: 2 });
ok('C5 limit 生效，并说明总数还有多少',
  lim.json?.drafts?.length === 2 && /共 4 份/.test(String(lim.json?.note)), JSON.stringify(lim.json?.note));

// ---------- D. 发出去 ----------
const before1 = received.length;
r = await call('send_draft', { draftId: d2 });
ok('D1 草稿能发出去', !r.err && r.json?.ok === true, r.text.slice(0, 150));
{
  const raw = await waitRaw(before1);
  const p = await simpleParser(raw);
  ok('D2 发的是草稿里存的收件人和主题',
    String(p.to?.text || '').includes('b@example.com') && p.subject === '带抄送-改',
    JSON.stringify({ to: String(p.to?.text || ''), subject: p.subject }));
  ok('D3 抄送真的进了 Cc 头（不是只存不用）',
    String(p.cc?.text || '').includes('c@example.com'), String(p.cc?.text || ''));
  ok('D4 密送不出现在报文里（泄漏是事故）', !raw.includes('d@example.com'));
}
ok('D5 发送成功后草稿自动删除',
  (await call('list_drafts', {})).json.drafts.every((x) => x.id !== d2));

// 改过的草稿发的是最后一版，不是最初那版
await call('update_draft', { draftId: d1, text: '最终版正文，只发这一段' });
const before2 = received.length;
r = await call('send_draft', { draftId: d1 });
{
  const raw = await waitRaw(before2);
  const p = await simpleParser(raw);
  ok('D6 改过的草稿，发出去的是最后一次修改的内容',
    /最终版正文/.test(String(p.text || '')) && !/补充：已核对/.test(String(p.text || '')),
    String(p.text || '').slice(0, 60));
}

r = await call('send_draft', { draftId: d5 });
ok('D7 没收件人时拒绝发送，并指向 update_draft 补上（不再推给网页端）',
  r.err && /还没有收件人/.test(r.text) && /不用重新存一份/.test(r.text), r.text.slice(0, 140));

// ---------- E. 安全 / 边界 ----------
{
  let threw = '';
  try { mail.deleteDraft(uid, '../../accounts'); } catch (e) { threw = String(e.message); }
  ok('E1 编号里带路径的删除请求被存储层拒掉', /不合法/.test(threw), threw);

  let threw2 = '';
  try { mail.saveDraft(uid, { id: '../../../evil', text: 'x' }); } catch (e) { threw2 = String(e.message); }
  ok('E1 保存时传入非法编号同样被拒（HTTP 那边能传 id 进来）', /不合法/.test(threw2), threw2);
}

r = await call('delete_draft', { draftId: d4 });
ok('E2 删除返回 JSON 而不是一句中文', !r.err && r.json?.ok === true && r.json.deleted === d4, r.text.slice(0, 80));
r = await call('delete_draft', { draftId: d4 });
ok('E2 删两次报找不到', r.err && /找不到草稿/.test(r.text), r.text.slice(0, 80));

server.close();
console.log(failed ? `\n有失败：${pass + failed} 项断言，${failed} 项失败` : `\n全部通过：${pass} 项断言`);
process.exit(failed ? 1 : 0);
