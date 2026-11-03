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
