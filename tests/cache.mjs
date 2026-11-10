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

// ---------- 增量同步决策（decideSync）+ 全量校准的删除对齐 ----------
const { decideSync } = await import('../server/idle.js');
const ACC2 = 'a_sync';

function seedFolder() {
  cache.syncFolderFull(uid, ACC2, 'Archive', 777, [
    mkMsg(10, 'a', '2026-11-01T00:00:00.000Z'),
    mkMsg(11, 'b', '2026-11-02T00:00:00.000Z'),
  ]);
  cache.markFullIndex(uid, ACC2, 'Archive', true);
  return cache.getFolderSync(uid, ACC2, 'Archive');
}

test('增量决策：完全一致时一封都不拉', () => {
  const meta = seedFolder();
  assert.equal(meta.total, 2);
  assert.equal(meta.maxUid, 11);
  const plan = decideSync(meta, { messages: 2, uidNext: 12, uidValidity: 777 });
  assert.equal(plan.mode, 'skip');
});

test('增量决策：只有新邮件时只拉最大 UID 之后', () => {
  const meta = seedFolder();
  const plan = decideSync(meta, { messages: 4, uidNext: 14, uidValidity: 777 });
  assert.equal(plan.mode, 'incremental');
  assert.equal(plan.range, '12:*');
  assert.equal(plan.minUid, 11);
});

test('增量决策：纯删除（服务器比本地少）直接全量', () => {
  const meta = seedFolder();
  assert.equal(decideSync(meta, { messages: 1, uidNext: 12, uidValidity: 777 }).mode, 'full');
  // 总数没变但最大 UID 前进了 = 删一封又进一封，也判不出来，全量最稳
  assert.equal(decideSync(meta, { messages: 2, uidNext: 13, uidValidity: 777 }).mode, 'full');
});

test('增量决策：新增与删除同时发生 —— 先增量，拉完数量对不上再全量', () => {
  const meta = seedFolder();
  // 新到 2 封（12、13）、又删了 1 封旧信：总数 3，本地 2，serverMax 13
  // 决策层无法只凭数字知道「删了哪封」，所以先增量拉 12:*，再由调用方的
  // 「拉完 total === status.messages 才算数」兜底 —— total 会变 4，于是转全量
  assert.equal(decideSync(meta, { messages: 3, uidNext: 14, uidValidity: 777 }).mode, 'incremental');
});

test('增量决策：UIDVALIDITY 变了 / 索引不完整 / 拿不到状态 → 全量', () => {
  const meta = seedFolder();
  assert.equal(decideSync(meta, { messages: 2, uidNext: 12, uidValidity: 888 }).mode, 'full');
  assert.equal(decideSync({ ...meta, fullIndex: false }, { messages: 2, uidNext: 12, uidValidity: 777 }).mode, 'full');
  assert.equal(decideSync(meta, null).mode, 'full');
  assert.equal(decideSync(null, { messages: 2, uidNext: 12, uidValidity: 777 }).mode, 'full');
});

test('增量决策：uidNext 缺失时不敢跳（保守走全量）', () => {
  const meta = seedFolder();
  // 没有 uidNext 就无法判断有没有新增，宁可多拉
  assert.equal(decideSync(meta, { messages: 2, uidValidity: 777 }).mode, 'skip');
  assert.equal(decideSync(meta, { messages: 3, uidValidity: 777 }).mode, 'full');
});

test('全量校准：服务器已不存在的 uid 会被删掉（跨客户端删除不留幽灵）', () => {
  const meta = seedFolder();
  assert.equal(meta.total, 2);
  // 模拟手机上删掉 uid 10，服务器只剩 11
  const pruned = cache.pruneFolder(uid, ACC2, 'Archive', [11]);
  assert.equal(pruned, 1);
  assert.equal(cache.folderTotal(uid, ACC2, 'Archive'), 1);
  assert.equal(cache.getPage(uid, ACC2, 'Archive', { page: 1, pageSize: 10 }).messages[0].uid, 11);
  // 全文索引也跟着删（不能只删 messages 留索引）
  assert.ok(!cache.searchMessages(uid, ACC2, 'a').some((m) => m.uid === 10));
});

test('全量校准：prune 不会误删仍在服务器上的邮件', () => {
  cache.upsertEnvelopes(uid, ACC2, 'Archive', [mkMsg(12, 'c', '2026-11-03T00:00:00.000Z')], 777);
  assert.equal(cache.folderTotal(uid, ACC2, 'Archive'), 2);
  assert.equal(cache.pruneFolder(uid, ACC2, 'Archive', [11, 12]), 0);
  assert.equal(cache.folderTotal(uid, ACC2, 'Archive'), 2);
});

test('全量校准：markFullIndex / markFolderStale 的语义', () => {
  cache.markFullIndex(uid, ACC2, 'Archive', false);
  assert.equal(cache.getFolderSync(uid, ACC2, 'Archive').fullIndex, false);
  cache.markFullIndex(uid, ACC2, 'Archive', true);
  assert.equal(cache.getFolderSync(uid, ACC2, 'Archive').fullIndex, true);
  // stale：列表应回退直拉（getPage 返回 null），而不是把空当成真的空
  cache.markFolderStale(uid, ACC2, 'Archive');
  assert.equal(cache.getPage(uid, ACC2, 'Archive', { page: 1, pageSize: 10 }), null);
  assert.equal(cache.getFolderSync(uid, ACC2, 'Archive').fullIndex, true);
});

// ---------- 同步流程端到端（假 IMAP 客户端，验「真的少发了命令」）----------
const { syncFolderSnapshot } = await import('../server/idle.js');
const ACC3 = 'a_flow';

// 假 imapflow client：只需 getMailboxLock / status / fetch 三个接口
function fakeClient(state) {
  const calls = [];
  const msg = (uid) => ({
    uid,
    envelope: {
      from: [{ name: `发件人${uid}`, address: `u${uid}@example.com` }],
      to: [{ name: '', address: 'me@example.com' }],
      subject: `主题 ${uid}`,
    },
    internalDate: new Date(Date.UTC(2026, 10, 1, 0, uid)),
    flags: new Set(['\\Seen']),
    size: 1000 + uid,
    bodyStructure: null,
  });
  return {
    calls,
    mailbox: { uidValidity: state.uidValidity },
    async getMailboxLock() { return { release() { /* noop */ } }; },
    async status() {
      return { messages: state.messages, uidNext: state.uidNext, uidValidity: state.uidValidity };
    },
    async *fetch(range) {
      calls.push(range);
      const from = range === '1:*' ? 1 : Number(String(range).split(':')[0]);
      for (let uid = from; uid <= state.maxUid; uid++) {
        if (state.uidSet.includes(uid)) yield msg(uid);
      }
    },
  };
}

test('同步流程：首次全量，第二次零 fetch，新增只拉增量，删除触发校准', async () => {
  const state = { uidValidity: 4242, messages: 3, maxUid: 3, uidNext: 4, uidSet: [1, 2, 3] };
  let client = fakeClient(state);

  // ① 首次：没有缓存 → 全量
  let r = await syncFolderSnapshot(uid, ACC3, client, 'INBOX');
  assert.equal(r.mode, 'full');
  assert.deepEqual(client.calls, ['1:*']);
  assert.equal(cache.folderTotal(uid, ACC3, 'INBOX'), 3);

  // ② 什么都没变：一条 fetch 都不发（这是这次改动的核心收益）
  client = fakeClient(state);
  r = await syncFolderSnapshot(uid, ACC3, client, 'INBOX');
  assert.equal(r.mode, 'skip');
  assert.deepEqual(client.calls, []);

  // ③ 来了 2 封新邮件：只拉 (maxUid+1):*
  state.messages = 5; state.maxUid = 5; state.uidNext = 6; state.uidSet = [1, 2, 3, 4, 5];
  client = fakeClient(state);
  r = await syncFolderSnapshot(uid, ACC3, client, 'INBOX');
  assert.equal(r.mode, 'incremental');
  assert.deepEqual(client.calls, ['4:*']);
  assert.equal(cache.folderTotal(uid, ACC3, 'INBOX'), 5);

  // ④ 在手机上删掉 1 封（服务器 4 封）：全量校准 + prune，本地不能留幽灵
  state.messages = 4; state.uidSet = [2, 3, 4, 5];
  client = fakeClient(state);
  r = await syncFolderSnapshot(uid, ACC3, client, 'INBOX');
  assert.equal(r.mode, 'full');
  assert.deepEqual(client.calls, ['1:*']);
  assert.equal(cache.folderTotal(uid, ACC3, 'INBOX'), 4);
  const uids = cache.getPage(uid, ACC3, 'INBOX', { page: 1, pageSize: 10 }).messages.map((m) => m.uid).sort();
  assert.deepEqual(uids, [2, 3, 4, 5]);

  // ⑤ UIDVALIDITY 变了：整夹重建，不能拼出「旧 uid + 新 uid」的混合体
  state.uidValidity = 9999; state.messages = 1; state.maxUid = 7; state.uidNext = 8; state.uidSet = [7];
  client = fakeClient(state);
  r = await syncFolderSnapshot(uid, ACC3, client, 'INBOX');
  assert.equal(r.mode, 'full');
  assert.equal(cache.folderTotal(uid, ACC3, 'INBOX'), 1);
  assert.equal(cache.getFolderSync(uid, ACC3, 'INBOX').uidvalidity, 9999);
});

// ---------- IDLE 兜底轮询（watcher 持锁期间的对账路径） ----------
// 真实场景：QQ/163 常驻 IDLE 却不推 EXISTS，新邮件永远进不来；轮询是兜底生命线。
// 红线：watcher 持着 INBOX 锁，对账绝不能再调 getMailboxLock（imapflow 锁不重入 → 死锁）。
const { pollInboxInline } = await import('../server/idle.js');

test('IDLE 兜底轮询：不取锁、零变化零 fetch、增量与全量与 syncFolderSnapshot 同判定', async () => {
  const state = { uidValidity: 4242, messages: 3, maxUid: 3, uidNext: 4, uidSet: [1, 2, 3] };
  const ACC4 = 'a_poll';
  const tracker = fakeClient(state);
  const client = {
    mailbox: tracker.mailbox,
    status: tracker.status,
    fetch: tracker.fetch,
    calls: tracker.calls,
    locks: 0,
    // 红线断言载体：这个假客户端的 getMailboxLock 一被调用就记数（真实现会死锁）
    async getMailboxLock() { this.locks++; return { release() { /* noop */ } }; },
  };

  // ⓪ 首次对账 = 全量建索引（和 watcher 首连同构）
  let r = await pollInboxInline(uid, ACC4, client, 'INBOX');
  assert.equal(r.mode, 'full');
  assert.equal(cache.folderTotal(uid, ACC4, 'INBOX'), 3);
  client.calls.length = 0; // 上一步的 '1:*' 是全量该发的，后面单独断言

  // ① 零变化：一条 fetch 都不发
  r = await pollInboxInline(uid, ACC4, client, 'INBOX');
  assert.equal(r.mode, 'skip');
  assert.equal(r.fetched, 0);
  assert.deepEqual(client.calls, []);
  assert.equal(client.locks, 0, '对账绝不允许再取锁（watcher 自己持着，会死锁）');

  // ② 新增 2 封：增量拉取
  state.messages = 5; state.maxUid = 5; state.uidNext = 6; state.uidSet = [1, 2, 3, 4, 5];
  r = await pollInboxInline(uid, ACC4, client, 'INBOX');
  assert.equal(r.mode, 'incremental');
  assert.equal(r.fetched, 2);
  assert.deepEqual(client.calls, ['4:*']);
  assert.equal(cache.folderTotal(uid, ACC4, 'INBOX'), 5);
  assert.equal(client.locks, 0);

  // ③ 删掉 2 封：全量校准 + prune，不留幽灵邮件
  client.calls.length = 0; // ② 的 '4:*' 是增量该发的，③ 只断言校准那次
  state.messages = 3; state.uidSet = [1, 3, 5];
  r = await pollInboxInline(uid, ACC4, client, 'INBOX');
  assert.equal(r.mode, 'full');
  assert.deepEqual(client.calls, ['1:*']);
  assert.equal(cache.folderTotal(uid, ACC4, 'INBOX'), 3);
  const uids = cache.getPage(uid, ACC4, 'INBOX', { page: 1, pageSize: 10 }).messages.map((m) => m.uid).sort();
  assert.deepEqual(uids, [1, 3, 5]);
  assert.equal(client.locks, 0, '全程零取锁');

  // ④ STATUS 报错（少数服务器对已选中的夹不给 STATUS）：安静返回 null，交给下一轮
  const badClient = { async status() { throw new Error('NO'); }, mailbox: null };
  r = await pollInboxInline(uid, ACC4, badClient, 'INBOX');
  assert.equal(r, null);
});

// ---------- 2026-11-10 回归：正文索引 / 表格 / 时间过滤 ----------
// 事故现场：12306 的电子发票是 HTML-only，text 为空、表格在 html 里。
// 老实现只索引 body.text，于是「正文写着 G3120、搜 G3120 返回 0 封」。
test('HTML-only 邮件的正文也进索引，表格不散架', async () => {
  const { htmlToText } = await import('../server/htmltext.js');
  const html = '<table><tr><th>车次</th><th>发到站</th><th>票价</th></tr>'
    + '<tr><td>G3120</td><td>上海站-苏州站</td><td>42.00</td></tr></table>';
  const txt = htmlToText(html);
  assert.ok(txt.includes('车次 | 发到站 | 票价'), '表头要保留单元格分隔');
  assert.ok(txt.includes('G3120 | 上海站-苏州站 | 42.00'), '数值要和标签在同一行');

  const A = 'a_htm01';
  cache.syncFolderFull(uid, A, 'INBOX', 1, [
    mkMsg(1, '网上购票系统-电子发票通知', '2025-05-29T05:21:00.000Z'),
  ]);
  // 真实形态：text 空、内容在 html
  cache.putBody(uid, A, 'INBOX', 1, { text: '', html });
  assert.equal(cache.searchMessages(uid, A, 'G3120').length, 1, '正文在 html 里也必须能搜到');
  assert.equal(cache.searchMessages(uid, A, '上海站').length, 1);
});

test('ensureBodyIndex 能给老库补建正文索引', () => {
  const A = 'a_htm02';
  cache.syncFolderFull(uid, A, 'INBOX', 1, [mkMsg(2, '老库里的账单', '2026-10-18T02:21:00.000Z')]);
  cache.putBody(uid, A, 'INBOX', 2, { text: '', html: '<p>本期应还 1686.68</p>' });
  // 模拟老库里索引体为空：直接把它写空，再让迁移补回来
  cache.getDb(uid).prepare('UPDATE msg_fts SET body = \'\' WHERE rowid = '
    + '(SELECT rid FROM fts_keys WHERE account_id = ? AND folder = ? AND uid = 2)').run(A, 'INBOX');
  assert.equal(cache.searchMessages(uid, A, '本期应还').length, 0, '先确认索引确实空了');
  // user_version 已经是迁移后的值，这里强制回落到 0 再跑一次
  cache.getDb(uid).exec('PRAGMA user_version = 0');
  const n = cache.ensureBodyIndex(uid);
  assert.ok(n >= 1);
  assert.equal(cache.searchMessages(uid, A, '本期应还').length, 1, '迁移后应能搜到');
});

test('searchMessages 支持 since / before', () => {
  const A = 'a_time01';
  cache.syncFolderFull(uid, A, 'INBOX', 1, [
    mkMsg(1, '本月账单', '2026-10-18T02:00:00.000Z'),
    mkMsg(2, '上月账单', '2026-09-18T02:00:00.000Z'),
    mkMsg(3, '更早的账单', '2026-05-18T02:00:00.000Z'),
  ]);
  const all = cache.searchMessages(uid, A, '账单');
  assert.equal(all.length, 3);
  const recent = cache.searchMessages(uid, A, '账单', { since: '2026-10-01T00:00:00.000Z' });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].uid, 1);
  const mid = cache.searchMessages(uid, A, '账单', {
    since: '2026-06-01T00:00:00.000Z', before: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(mid.length, 1);
  assert.equal(mid[0].uid, 2);
});
