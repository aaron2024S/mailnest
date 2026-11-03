// cache.mjs —— SQLite 缓存层断言（node:sqlite）
// 覆盖：整夹同步 / 增量 upsert / 分页 / 未读计数 / 旗标回写 / 正文 write-through / uidvalidity 重建 / 删除与清理
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 把 store.js 的 DATA_DIR 指到临时目录后再导入 cache.js（userDir 在导入期固化）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-cache-'));
process.env.MAILNEST_DATA = tmp;
const cache = await import('../server/cache.js');

const uid = 'u_test01';
const acc = 'a_test01';

function mkMsg(uid_, subject, date, flags = [], hasAttachment = false) {
  return {
    uid: uid_,
    from: { name: '发件人', address: 's@example.com' },
    to: [{ name: '', address: 'me@example.com' }],
    subject,
    date,
    flags,
    size: 1024,
    hasAttachment,
  };
}

test('整夹同步：写入与分页读回', () => {
  const msgs = [
    mkMsg(1, '第一封', '2026-11-01T08:00:00.000Z', ['\\Seen']),
    mkMsg(2, '第二封', '2026-11-02T08:00:00.000Z', []),
    mkMsg(3, '第三封', '2026-11-03T08:00:00.000Z', ['\\Flagged']),
  ];
  cache.syncFolderFull(uid, acc, 'INBOX', 12345, msgs);
  const page = cache.getPage(uid, acc, 'INBOX', { page: 1, pageSize: 2 });
  assert.equal(page.total, 3);
  assert.equal(page.uidvalidity, 12345);
  assert.equal(page.messages.length, 2);
  // 日期倒序：最新在前
  assert.equal(page.messages[0].subject, '第三封');
  assert.equal(page.messages[1].subject, '第二封');
  // 未读 = 2、3
  const counts = cache.folderCounts(uid).find((r) => r.account_id === acc && r.path === 'INBOX');
  assert.equal(counts.unseen, 2);
  assert.equal(counts.total, 3);
});

test('未同步过的文件夹 getPage 返回 null（触发直拉兜底）', () => {
  assert.equal(cache.getPage(uid, acc, 'NeverSeen', {}), null);
});

test('增量 upsert：新邮件追加、已有邮件更新', () => {
  cache.upsertEnvelopes(uid, acc, 'INBOX', [
    mkMsg(4, '新来的', '2026-11-04T08:00:00.000Z', []),
    mkMsg(2, '第二封（旗标更新）', '2026-11-02T08:00:00.000Z', ['\\Seen', '\\Flagged']),
  ]);
  const page = cache.getPage(uid, acc, 'INBOX', { page: 1, pageSize: 10 });
  assert.equal(page.total, 4);
  assert.equal(page.messages[0].subject, '新来的');
  const updated = page.messages.find((m) => m.uid === 2);
  assert.ok(updated.flags.includes('\\Flagged') && updated.flags.includes('\\Seen'));
  const counts = cache.folderCounts(uid).find((r) => r.path === 'INBOX');
  assert.equal(counts.unseen, 2); // 3、4 未读
});

test('旗标回写：add/remove/set + 未读数联动', () => {
  cache.updateFlags(uid, acc, 'INBOX', [4], { add: ['\\Seen'] });
  let c = cache.folderCounts(uid).find((r) => r.path === 'INBOX');
  assert.equal(c.unseen, 1);
  cache.updateFlags(uid, acc, 'INBOX', [3], { add: ['\\Seen'] });
  c = cache.folderCounts(uid).find((r) => r.path === 'INBOX');
  assert.equal(c.unseen, 0);
  cache.updateFlags(uid, acc, 'INBOX', [3, 4], { remove: ['\\Seen'] });
  c = cache.folderCounts(uid).find((r) => r.path === 'INBOX');
  assert.equal(c.unseen, 2);
  cache.updateFlags(uid, acc, 'INBOX', [1], { set: ['\\Seen', '\\Flagged'] });
  const page = cache.getPage(uid, acc, 'INBOX', { page: 1, pageSize: 10 });
  assert.deepEqual(page.messages.find((m) => m.uid === 1).flags.sort(), ['\\Flagged', '\\Seen']);
});

test('整夹全部已读：addFlagToAll', () => {
  cache.addFlagToAll(uid, acc, 'INBOX', '\\Seen');
  const c = cache.folderCounts(uid).find((r) => r.path === 'INBOX');
  assert.equal(c.unseen, 0);
});

test('正文 write-through 与读回', () => {
  cache.putBody(uid, acc, 'INBOX', 4, {
    from: { name: '', address: 's@example.com' }, to: [], cc: [],
    subject: '新来的', date: '2026-11-04T08:00:00.000Z',
    messageId: '<a@b>', inReplyTo: null, references: null,
    text: '正文文本', html: '<p>正文</p>', attachments: [{ id: 0, filename: 'a.pdf', contentType: 'application/pdf', size: 5, cid: null }],
  });
  const body = cache.getBody(uid, acc, 'INBOX', 4);
  assert.equal(body.text, '正文文本');
  assert.equal(body.attachments[0].filename, 'a.pdf');
  assert.ok(Array.isArray(body.flags));
  // 未拉取过正文的邮件返回 null
  assert.equal(cache.getBody(uid, acc, 'INBOX', 3), null);
  // 没有这封邮件的夹返回 null
  assert.equal(cache.getBody(uid, acc, 'INBOX', 999), null);
});

test('删除邮件：removeUids 联动计数', () => {
  cache.removeUids(uid, acc, 'INBOX', [1]);
  const page = cache.getPage(uid, acc, 'INBOX', { page: 1, pageSize: 10 });
  assert.equal(page.total, 3);
  assert.ok(!page.messages.some((m) => m.uid === 1));
});

test('清空文件夹：clearFolder', () => {
  cache.clearFolder(uid, acc, 'INBOX');
  const page = cache.getPage(uid, acc, 'INBOX', { page: 1, pageSize: 10 });
  assert.equal(page.total, 0);
  assert.deepEqual(page.messages, []);
});

test('uidvalidity 变化：整夹重建（旧 uid 全部消失）', () => {
  cache.syncFolderFull(uid, acc, 'Rebuilt', 100, [
    mkMsg(10, '旧纪元', '2026-10-01T00:00:00.000Z'),
    mkMsg(11, '旧纪元2', '2026-10-02T00:00:00.000Z'),
  ]);
  // 服务器 uidvalidity 翻转，uid 重新从 1 开始
  cache.syncFolderFull(uid, acc, 'Rebuilt', 200, [
    mkMsg(1, '新纪元', '2026-11-05T00:00:00.000Z'),
  ]);
  const page = cache.getPage(uid, acc, 'Rebuilt', { page: 1, pageSize: 10 });
  assert.equal(page.uidvalidity, 200);
  assert.equal(page.total, 1);
  assert.equal(page.messages[0].subject, '新纪元');
});

test('移动：源夹移除（目的夹留待重同步）', () => {
  cache.syncFolderFull(uid, acc, 'Src', 1, [mkMsg(1, '要搬走', '2026-11-01T00:00:00.000Z')]);
  cache.moveUids(uid, acc, 'Src', [1]);
  assert.equal(cache.getPage(uid, acc, 'Src', {}).total, 0);
});

test('删除文件夹与账号缓存', () => {
  cache.dropFolder(uid, acc, 'Rebuilt');
  assert.equal(cache.getPage(uid, acc, 'Rebuilt', {}), null);
  cache.syncFolderFull(uid, 'a_other', 'INBOX', 1, [mkMsg(1, '别家', '2026-11-01T00:00:00.000Z')]);
  cache.dropAccount(uid, 'a_other');
  assert.equal(cache.getPage(uid, 'a_other', 'INBOX', {}), null);
  // 主账号数据不受影响
  assert.ok(cache.folderCounts(uid).some((r) => r.account_id === acc));
});

test('多用户隔离：不同 uid 各自的库', () => {
  cache.syncFolderFull('u_other', acc, 'INBOX', 1, [mkMsg(1, '别人家的', '2026-11-01T00:00:00.000Z')]);
  const mine = cache.getPage(uid, acc, 'INBOX', {});
  const theirs = cache.getPage('u_other', acc, 'INBOX', {});
  assert.equal(mine.total, 0); // 上面 clearFolder 清过
  assert.equal(theirs.messages[0].subject, '别人家的');
  cache.closeDb('u_other');
  fs.rmSync(path.join(tmp, 'u_other'), { recursive: true, force: true });
});

test('搜索：主题 / 发件人 / 收件人 / 正文', () => {
  cache.syncFolderFull(uid, acc, 'Search', 1, [
    { ...mkMsg(1, '三月份发票汇总', '2026-11-01T00:00:00.000Z'), from: { name: '财务小张', address: 'zhang@corp.example' } },
    { ...mkMsg(2, '周末聚餐', '2026-11-02T00:00:00.000Z'), to: [{ name: '', address: 'team@corp.example' }] },
    mkMsg(3, '无关邮件', '2026-11-03T00:00:00.000Z'),
  ]);
  // 正文命中（模拟已打开过、正文已缓存）
  cache.putBody(uid, acc, 'Search', 3, { text: '这里是聊到报销流程的一段文字，含发票两个字', html: '' });

  assert.equal(cache.searchMessages(uid, acc, '发票', { folder: 'Search' }).length, 2, '主题 + 正文都应命中');
  const byFrom = cache.searchMessages(uid, acc, '财务小张', { folder: 'Search' });
  assert.equal(byFrom.length, 1);
  assert.deepEqual(byFrom[0].matched, ['from']);
  assert.equal(cache.searchMessages(uid, acc, 'team@corp', { folder: 'Search' })[0].uid, 2, '收件人也能搜');
  const bodyHit = cache.searchMessages(uid, acc, '报销流程', { folder: 'Search' })[0];
  assert.deepEqual(bodyHit.matched, ['body']);
  assert.ok(bodyHit.snippet.includes('报销流程'), bodyHit.snippet);

  // 通配符按字面量处理，不会把整库都搜出来
  assert.equal(cache.searchMessages(uid, acc, '%', { folder: 'Search' }).length, 0);
  assert.equal(cache.searchMessages(uid, acc, '_', { folder: 'Search' }).length, 0);
});

test('搜索：未同步的文件夹不会误报命中', () => {
  assert.equal(cache.searchMessages(uid, acc, '发票', { folder: 'NeverSynced' }).length, 0);
  assert.equal(cache.hasAccountData(uid, acc), true);
  assert.equal(cache.hasAccountData(uid, 'a_no_such'), false);
});

test('文件夹清单缓存：put/get/覆盖与账号隔离', () => {
  // 未写入前没有缓存（触发首次真 LIST）
  assert.equal(cache.getFolders(uid, acc), null);
  const list1 = [
    { path: 'INBOX', name: 'INBOX', delim: '/', special: '\\Inbox', subscribed: true },
    { path: 'Trash', name: 'Trash', delim: '/', special: '\\Trash', subscribed: true },
  ];
  cache.putFolders(uid, acc, list1);
  assert.deepEqual(cache.getFolders(uid, acc), list1);
  // 覆盖更新（后台刷新拿到新清单）
  const list2 = [...list1, { path: 'Archive', name: 'Archive', delim: '/', special: '\\Archive', subscribed: false }];
  cache.putFolders(uid, acc, list2);
  assert.equal(cache.getFolders(uid, acc).length, 3);
  // 账号隔离
  assert.equal(cache.getFolders(uid, 'a_other_acc'), null);
  cache.putFolders(uid, 'a_other_acc', list1);
  assert.equal(cache.getFolders(uid, 'a_other_acc').length, 2);
  assert.equal(cache.getFolders(uid, acc).length, 3);
  // 畸形 JSON 不炸、返回 null
  cache.putFolders(uid, 'a_bad', undefined);
  assert.deepEqual(cache.getFolders(uid, 'a_bad'), []);
});

after(() => {
  cache.closeDb(uid);
  cache.closeDb('u_other');
  fs.rmSync(tmp, { recursive: true, force: true });
});
