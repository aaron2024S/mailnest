// attachments.mjs —— 本地全量缓存的断言
// 覆盖：内嵌图片 cid 替换 / 附件落盘与读回 / 删除清理 / 占用统计 / 正文队列（待办·失败重试）
//       / 中文全文检索（FTS5）
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleParser } from 'mailparser';

// store.js 的 DATA_DIR 在导入期固化，必须先设环境变量再动态导入
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-att-'));
process.env.MAILNEST_DATA = tmp;
const cache = await import('../server/cache.js');
const attachments = await import('../server/attachments.js');
const mail = await import('../server/mail.js');

const uid = 'u_att01';
const acc = 'a_att01';

after(() => {
  try { cache.closeAll(); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// 一封带内联图片 + 普通附件的邮件
const MIME = [
  'From: =?utf-8?B?5byg5LiJ?= <zhang@example.com>',
  'To: me@example.com',
  'Subject: =?utf-8?B?5biC5Zy65oql5ZGz?=',
  'Date: Mon, 02 Nov 2026 10:00:00 +0800',
  'MIME-Version: 1.0',
  'Content-Type: multipart/related; boundary="B1"',
  '',
  '--B1',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>见下图</p><img src="cid:logo%40mailnest">',
  '',
  '--B1',
  'Content-Type: image/png; name="logo.png"',
  'Content-Transfer-Encoding: base64',
  'Content-ID: <LOGO@mailnest>',
  'Content-Disposition: inline; filename="logo.png"',
  '',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  '',
  '--B1',
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="report.pdf"',
  '',
  'JVBERi0xLjQKJcOkw7zDtsOfCjEgMCBvYmoKPDwvVHlwZSAvQ2F0YWxvZz4+CmVuZG9iagp0cmFpbGVyCjw8L1Jvb3QgMSAwIFI+PgolJUVPRgo=',
  '',
  '--B1--',
  '',
].join('\r\n');

async function parse() {
  return simpleParser(Buffer.from(MIME));
}

test('解析：内嵌图片换成本地地址，普通附件保持下载语义', async () => {
  const parsed = await parse();
  const out = mail.extractMessage(parsed, { accountId: acc, folder: 'INBOX', uid: 7 });
  assert.match(out.html, /\/api\/attachment\?account=a_att01&folder=INBOX&uid=7&idx=0&inline=1/);
  assert.doesNotMatch(out.html, /cid:/);
  // 两个附件都被登记（图片 + pdf）
  assert.equal(out.attachments.length, 2);
  assert.equal(out.attachments[1].filename, 'report.pdf');
});

test('解析：cid 大小写与 URL 编码都对得上（否则实机上是裂图）', async () => {
  const parsed = await parse();
  // mime 里写的是 <LOGO@mailnest>，html 里是 cid:logo%40mailnest —— 大小写 + 编码都不同
  const out = mail.extractMessage(parsed, { accountId: acc, folder: 'INBOX', uid: 7 });
  assert.ok(out.html.includes('inline=1'));
});

test('附件：落盘后读取不依赖 IMAP，内容字节一致', async () => {
  const parsed = await parse();
  attachments.saveAll(uid, acc, 'INBOX', 7, parsed.attachments.map((a, i) => ({
    id: i, filename: a.filename, contentType: a.contentType, size: a.size, cid: a.cid || null, content: a.content,
  })));
  // saveAll 是异步落盘（不阻塞读信），给它一拍
  await new Promise((r) => setTimeout(r, 120));
  const pdf = attachments.get(uid, acc, 'INBOX', 7, 1);
  assert.ok(pdf, '附件应该能直接从磁盘读到');
  assert.equal(pdf.filename, 'report.pdf');
  assert.equal(pdf.contentType, 'application/pdf');
  assert.ok(pdf.content.length > 40);
  // 没请求过的索引返回 null（走 IMAP 兜底）
  assert.equal(attachments.get(uid, acc, 'INBOX', 7, 9), null);
});

test('附件：占用统计与按消息清理', async () => {
  const s = attachments.stats(uid);
  assert.equal(s.mails, 1);
  assert.ok(s.bytes > 0);
  attachments.dropMessage(uid, acc, 'INBOX', 7);
  assert.equal(attachments.get(uid, acc, 'INBOX', 7, 1), null);
  assert.equal(attachments.stats(uid).mails, 0);
});

test('正文队列：body 为 NULL 即待办，按 uid 由新到旧', () => {
  cache.syncFolderFull(uid, acc, 'INBOX', 900, [
    { uid: 1, subject: 'a', from: { name: '', address: 'x@y.com' }, to: [], date: '2026-11-01T00:00:00Z', flags: [] },
    { uid: 2, subject: 'b', from: { name: '', address: 'x@y.com' }, to: [], date: '2026-11-02T00:00:00Z', flags: [] },
    { uid: 3, subject: 'c', from: { name: '', address: 'x@y.com' }, to: [], date: '2026-11-03T00:00:00Z', flags: [] },
  ]);
  assert.deepEqual(cache.pendingBodies(uid, acc, 'INBOX', 10), [3, 2, 1]);
  assert.equal(cache.nextPendingFolder(uid, acc).folder, 'INBOX');
  cache.putBody(uid, acc, 'INBOX', 3, { text: '正文', html: null, attachments: [] });
  assert.deepEqual(cache.pendingBodies(uid, acc, 'INBOX', 10), [2, 1]);
});

test('正文队列：坏邮件重试 3 次后不再堵住队列', () => {
  for (let i = 0; i < 3; i++) cache.failBody(uid, acc, 'INBOX', 2);
  assert.deepEqual(cache.pendingBodies(uid, acc, 'INBOX', 10), [1]);
  cache.resetBodyTries(uid, acc);
  assert.deepEqual(cache.pendingBodies(uid, acc, 'INBOX', 10), [2, 1]);
});

test('全文检索：中文按字索引，任意子串都能命中正文', () => {
  cache.putBody(uid, acc, 'INBOX', 2, { text: '会议纪要：预算审批流程下周一定稿。', html: null, attachments: [] });
  const hit = cache.searchMessages(uid, acc, '预算审批');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].uid, 2);
  assert.ok(hit[0].matched.includes('body'));
  assert.ok(hit[0].snippet.includes('预算审批'));
  // 单个汉字也能搜到（LIKE 时代的痛点）
  assert.equal(cache.searchMessages(uid, acc, '审').length, 1);
  assert.equal(cache.searchMessages(uid, acc, '不存在的词组').length, 0);
});

test('全文检索：正文清空后搜不到正文，但主题仍在索引里', () => {
  const n = cache.clearBodies(uid, acc);
  assert.ok(n >= 1);
  assert.equal(cache.searchMessages(uid, acc, '预算审批').length, 0);
  assert.ok(cache.searchMessages(uid, acc, 'b').length >= 1); // 主题 'b' 还在
  // 清空后重新排队
  assert.ok(cache.pendingBodies(uid, acc, 'INBOX', 10).length >= 1);
});

test('全文检索：删除邮件后索引同步移除', () => {
  cache.removeUids(uid, acc, 'INBOX', [2]);
  assert.equal(cache.searchMessages(uid, acc, 'b').length, 0);
  const left = cache.getDb(uid).prepare('SELECT COUNT(*) AS n FROM fts_keys').get().n;
  assert.equal(left, 2); // 只剩 uid 1、3
});

// ---------- 预热循环端到端（0.2.0 血案回归：默认导入 simpleParser 一直是 undefined 调用） ----------
// mock client + 真实 cache/simpleParser/extractMessage/cacheAttachments 全链路，
// 断言 done 与落库数一致 —— 这类"导入级"错误只有真正跑一遍 fillFolder 才会暴露。
const { fillFolder } = await import('../server/prefetch.js');

test('预热端到端：fillFolder 把 mock 邮件全部落库（导入/解析/落盘全链路）', async () => {
  const accPf = 'a_pf';
  const mkMime = (i) => Buffer.from([
    `From: S${i} <s${i}@example.com>`, 'To: me@example.com', `Subject: 预热 ${i}`,
    `Date: Mon, 02 Nov 2026 1${i}:00:00 +0800`, `Message-ID: <pf${i}@x>`, 'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8', '', `<p>预热正文 ${i}</p>`,
  ].join('\r\n'));

  const sources = [1, 2, 3].map((i) => ({ uid: i, source: mkMime(i) }));
  cache.syncFolderFull(uid, accPf, 'INBOX', 7, sources.map(({ uid: u }) => ({
    uid: u, from: { name: `S${u}`, address: `s${u}@example.com` }, to: [],
    subject: `预热 ${u}`, date: `2026-11-02T1${u}:00:00+08:00`, flags: [], size: 100,
  })));

  const client = {
    async getMailboxLock() { return { release() {} }; },
    async *fetch() { for (const s of sources) yield { uid: s.uid, source: s.source }; },
  };
  const w = { running: true, done: 0, pending: 3 };
  await fillFolder(uid, accPf, client, 'INBOX', 3, w);

  assert.equal(w.done, 3, '三封都应成功，done 不应停在 0');
  assert.equal(cache.pendingBodies(uid, accPf, 'INBOX', 10).length, 0, '队列应排空');
  for (let i = 1; i <= 3; i++) {
    const body = cache.getBody(uid, accPf, 'INBOX', i);
    assert.ok(body, `uid ${i} 正文应落库`);
    assert.ok(String(body.html || '').includes(`预热正文 ${i}`));
  }
});

test('预热端到端：mailparser 对非 MIME 内容宽容解析，全部正常入库', async () => {
  const accPf2 = 'a_pf2';
  const sources = [
    { uid: 1, source: Buffer.from('not a mime at all') },
    { uid: 2, source: Buffer.from('From: a@x\r\nSubject: ok\r\n\r\n正文') },
  ];
  cache.syncFolderFull(uid, accPf2, 'INBOX', 8, [
    { uid: 1, from: { name: '', address: 'a@x' }, to: [], subject: '一', date: '2026-11-02T01:00:00+08:00', flags: [], size: 10 },
    { uid: 2, from: { name: '', address: 'a@x' }, to: [], subject: '二', date: '2026-11-02T02:00:00+08:00', flags: [], size: 10 },
  ]);
  const client = {
    async getMailboxLock() { return { release() {} }; },
    async *fetch() { for (const s of sources) yield s; },
  };
  const w = { running: true, done: 0, pending: 2 };
  await fillFolder(uid, accPf2, client, 'INBOX', 2, w);
  // mailparser 把纯文本也当邮件解析成功 —— done 应等于 yield 数，不能悄悄丢
  assert.equal(w.done, 2);
  assert.ok(cache.getBody(uid, accPf2, 'INBOX', 1));
  assert.ok(cache.getBody(uid, accPf2, 'INBOX', 2));
});

test('预热端到端：服务器整批漏发时全部记失败，不留下死循环', async () => {
  const accPf3 = 'a_pf3';
  cache.syncFolderFull(uid, accPf3, 'INBOX', 9, [
    { uid: 1, from: { name: '', address: 'a@x' }, to: [], subject: 'x', date: '2026-11-02T01:00:00+08:00', flags: [], size: 10 },
    { uid: 2, from: { name: '', address: 'a@x' }, to: [], subject: 'y', date: '2026-11-02T02:00:00+08:00', flags: [], size: 10 },
  ]);
  const client = {
    async getMailboxLock() { return { release() {} }; },
    async *fetch() { /* 服务器对这批 uid 一个都不回（已删除/移动） */ },
  };
  const w = { running: true, done: 0, pending: 2 };
  await fillFolder(uid, accPf3, client, 'INBOX', 2, w);
  assert.equal(w.done, 0);
  const tries = (u) => cache.getDb(uid).prepare(
    'SELECT body_tries t FROM messages WHERE account_id=? AND folder=? AND uid=?'
  ).get(accPf3, 'INBOX', u).t;
  assert.ok(tries(1) >= 1 && tries(2) >= 1, '漏发的 uid 必须记失败计数，否则队列死循环');
});

test('预热收尾：resetBodyTries 清零失败计数，让耗尽的邮件重新排队', () => {
  // a_pf3 的 uid 1、2 刚因漏发记了 tries；清零后必须重新出现在待办队列
  cache.resetBodyTries(uid);
  const pending = cache.pendingBodies(uid, 'a_pf3', 'INBOX', 10);
  assert.ok(pending.includes(1) && pending.includes(2), '重置后漏发邮件应重新排队（body 仍为 NULL）');
});

// ---------- 附件 inline 白名单（安全回归：外部邮件不得在应用同源下执行脚本） ----------
// 附件内容完全由发件人控制。若 /api/attachment?inline=1 原样回 text/html 或 svg，
// 用户在新标签页打开该 URL 就等于在应用同源执行对方脚本 —— 可读全部邮件、以用户身份发信。
test('inline 白名单：图片类放行，html/svg/octet-stream 一律不放行', () => {
  for (const ok of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']) {
    assert.equal(attachments.inlineSafe(ok), true, `${ok} 应允许 inline`);
  }
  for (const bad of [
    'text/html', 'text/plain', 'application/pdf', 'application/octet-stream',
    'image/svg+xml', 'IMAGE/SVG+XML', 'text/xml', 'application/xhtml+xml',
    'image/svg+xml; charset=utf-8', '', null, undefined,
  ]) {
    assert.equal(attachments.inlineSafe(bad), false, `${bad} 不应允许 inline`);
  }
});

test('inline 白名单：带参数与大小写的图片类型仍识别为图片', () => {
  assert.equal(attachments.inlineSafe('IMAGE/PNG; charset=binary'), true);
  assert.equal(attachments.inlineSafe('  image/jpeg ; q=1'), true);
  // 前面带空格的 svg 依旧要被挡住（不能被"看起来像图片"骗过）
  assert.equal(attachments.inlineSafe(' image/svg+xml'), false);
});

// ---------- 邮件模板净化（0.2.1 Steam 邮件白底白字事故） ----------
// 邮件模板靠内联 CSS + bgcolor/background 属性撑布局，白名单开小了会把深色底
// 整块剥掉。这组用例锁住：body 转 div、背景族/圆角/尺寸等属性不再被滤。
const STEAM_LIKE = `
<body bgcolor="#1b2838" style="background-color:#1b2838;margin:0;padding:20px;">
<div style="background:#171a21;border-radius:4px;max-width:600px;">
  <table width="100%" bgcolor="#1b2838">
    <tr><td style="color:#c6d4df;padding:20px;">zjncu，您好！</td></tr>
    <tr><td background="https://store.example.com/hero.png" style="background-image:url('https://store.example.com/hero.png');height:120px;">&nbsp;</td></tr>
    <tr><td style="padding:20px;"><img src="https://store.example.com/capsule.jpg" width="196" height="92" alt="商品" style="display:block;"></td></tr>
  </table>
</div>
</body>`;

test('正文净化：邮件模板的深色底与背景图不再被剥掉', () => {
  const out = mail.extractMessage({ html: STEAM_LIKE, attachments: [] }, { accountId: acc, folder: 'INBOX', uid: 9001 });
  const h = out.html;
  // body 上写的背景必须活下来（转成 div），否则深色邮件变白底浅字
  assert.match(h, /bgcolor="#1b2838"/i, 'body bgcolor 应保留');
  assert.match(h, /background-color:\s*#1b2838/i, 'body 内联背景色应保留');
  assert.doesNotMatch(h, /<body/i, 'body 标签应转成 div（属性保留）');
  assert.match(h, /background-image/i, 'td 背景图应保留');
  assert.match(h, /background="https/i, 'td background 属性应保留');
  assert.match(h, /border-radius/i, '圆角应保留');
  assert.match(h, /max-width/i, 'max-width 应保留');
  assert.match(h, /display:\s*block/i, 'img display:block 应保留');
  assert.match(h, /capsule\.jpg/, 'img src 应保留');
  // 深色主题杀器：这些是 Steam 深色包装的关键色，丢了 = 白字白底
  assert.match(h, /#171a21/i, 'background 简写应保留');
});

test('正文净化：style 块与 class 保留（模板布局依赖它）', () => {
  const html = '<style>.hero{background-color:#2a475e;color:#fff}</style><div class="hero">hi</div>';
  const out = mail.extractMessage({ html, attachments: [] }, { accountId: acc, folder: 'INBOX', uid: 9002 });
  assert.match(out.html, /\.hero\{background-color:#2a475e/, '<style> 块内容应保留');
  assert.match(out.html, /class="hero"/, 'class 应保留');
});

test('正文净化：安全底线不松动（script/onclick/javascript: 仍被挡）', () => {
  const html = '<p onclick="alert(1)">x</p><script>alert(2)</script>' +
    '<a href="javascript:alert(3)">l</a><img src="javascript:alert(4)" onerror="alert(5)">' +
    '<iframe src="https://evil.example"></iframe><form action="https://evil.example"></form>';
  const out = mail.extractMessage({ html, attachments: [] }, { accountId: acc, folder: 'INBOX', uid: 9003 });
  const h = out.html;
  assert.doesNotMatch(h, /script/i, 'script 标签不应出现');
  assert.doesNotMatch(h, /onclick|onerror/i, '事件属性不应出现');
  assert.doesNotMatch(h, /javascript:/i, 'javascript: 链接不应出现');
  assert.doesNotMatch(h, /<iframe|<form/i, 'iframe/form 不应出现');
  assert.match(h, /l</, '文本应保留');
});

test('正文缓存：BODY_V 变更后旧缓存按未拉取处理（重拉覆盖）', async () => {
  // 直接写一条不带 v 的旧格式 body，读响应为 null（等于未缓存 → 接口会重拉）
  cache.upsertEnvelopes(uid, acc, 'INBOX', [{ uid: 9100, subject: 'v', date: '2026-11-04' }], 77);
  const db = cache.getDb(uid);
  db.prepare('UPDATE messages SET body = ? WHERE account_id = ? AND uid = ?')
    .run(JSON.stringify({ html: '<p>old</p>' }), acc, 9100);
  assert.equal(cache.getBody(uid, acc, 'INBOX', 9100), null, '无版本号的旧缓存应失效');
  // 新格式写入后能读回
  cache.putBody(uid, acc, 'INBOX', 9100, { html: '<p>new</p>', text: 'new' });
  const hit = cache.getBody(uid, acc, 'INBOX', 9100);
  assert.equal(hit.html, '<p>new</p>');
  // upsertEnvelopes 会清 body？如果 envelope 重写把 body 清了，这里上面 putBody 之前就 fail 了
});
