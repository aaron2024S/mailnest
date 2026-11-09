// 假 IMAP 服务器 + listMessages 端到端验证（本机无真实邮箱时用）
// 用法：node tests/imap-list.mjs
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

// store.js 在导入时读取 MAILNEST_DATA，必须先设好（保持跨平台，不依赖 shell 变量语法）
process.env.MAILNEST_DATA = process.env.MAILNEST_DATA || '.imap-test';
// 上次运行留下的 system.json 会让 createUser 撞「用户名已存在」：导入 store 之前先清掉
fs.rmSync(path.join(path.resolve(process.env.MAILNEST_DATA), 'system.json'), { force: true });

const COUNT = 14;
const SENT_BODY = 'BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 20 1)';

function envelope(i) {
  return `ENVELOPE ("Mon, 2 Nov 2026 09:${String(i).padStart(2, '0')}:00 +0800" "测试邮件 ${i}" (("张三" NIL "zhangsan" "qq.com")) (("张三" NIL "zhangsan" "qq.com")) (("张三" NIL "zhangsan" "qq.com")) (("me" NIL "me" "qq.com")) NIL NIL NIL "<msg${i}@qq.com>")`;
}

let sawXoauth2 = false;
const storeLog = [];
const searchLog = [];
const fetchLog = [];
let expungeCount = 0;
const deleteLog = [];
// 服务器上「还活着」的 uid 账本与 \Deleted 标记账本（STORE 只打标，EXPUNGE 才销账），
// 供按 uid 的 SEARCH 校验；模拟 QQ 怪癖用（多 uid 的 UID EXPUNGE 假成功）
const alive = new Set();
for (let i = 1; i <= COUNT; i++) alive.add(100 + i);
const flagged = new Set();
const qqRefusedLog = []; // 被假成功吞掉的多 uid UID EXPUNGE 记录

// 展开 IMAP uid 集合（「101,102」「105:*」）为 uid 数组；「*」= 最高 uid
function expandUidSet(set) {
  const topUid = COUNT + 100; // 假服务器 uid = 100 + 序号
  return String(set).split(',').flatMap((x) => {
    if (x.includes(':')) {
      const [p0, q0] = x.split(':');
      const p = parseInt(p0, 10);
      const q = Number.isFinite(parseInt(q0, 10)) ? parseInt(q0, 10) : topUid;
      return Array.from({ length: Math.abs(q - p) + 1 }, (_, k) => Math.min(p, q) + k);
    }
    const n = parseInt(x, 10);
    return Number.isFinite(n) ? [n] : [];
  }).filter((n) => n >= 1);
}

const server = net.createServer((sock) => {
  sock.setEncoding('utf8');
  sock.write('* OK [CAPABILITY IMAP4rev1 UIDPLUS ID AUTH=XOAUTH2 SASL-IR] mock ready\r\n');
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\r\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const m = line.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
      if (!m) continue;
      const [, tag, cmd0, rest0 = ''] = m;
      // UID FETCH / UID STORE 等带 UID 前缀的命令：剥掉前缀再按子命令分发
      const isUid = cmd0.toUpperCase() === 'UID';
      const tag2 = tag, cmd = isUid ? rest0.split(/\s+/)[0] : cmd0;
      const rest = isUid ? rest0.slice(rest0.split(/\s+/)[0].length).trim() : rest0;
      const C = cmd.toUpperCase();
      if (C === 'CAPABILITY') {
        sock.write(`* CAPABILITY IMAP4rev1 UIDPLUS ID AUTH=XOAUTH2 SASL-IR\r\n${tag2} OK done\r\n`);
      } else if (C === 'ID') {
        sock.write(`* ID ("name" "mock")\r\n${tag2} OK done\r\n`);
      } else if (C === 'LOGIN') {
        sock.write(`${tag2} OK [CAPABILITY IMAP4rev1 UIDPLUS ID AUTH=XOAUTH2 SASL-IR] logged in\r\n`);
      } else if (C === 'AUTHENTICATE') {
        // OAuth2 账号走 AUTHENTICATE XOAUTH2 <base64(user=..\x01auth=Bearer ..\x01\x01)>
        const parts = rest.split(/\s+/);
        const mech = (parts[0] || '').toUpperCase();
        let raw = '';
        try { raw = Buffer.from(parts[1] || '', 'base64').toString('utf8'); } catch { raw = ''; }
        if (mech === 'XOAUTH2' && /^user=[^\u0001]+\u0001auth=Bearer [^\u0001]+\u0001\u0001$/.test(raw)) {
          sawXoauth2 = true;
          sock.write(`${tag2} OK [CAPABILITY IMAP4rev1 UIDPLUS ID AUTH=XOAUTH2 SASL-IR] authenticated\r\n`);
        } else {
          sock.write(`${tag2} NO [AUTHENTICATIONFAILED] bad token\r\n`);
        }
      } else if (C === 'SELECT' || C === 'EXAMINE') {
        sock.write('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n');
        // EXISTS 报账本真实存活数（CLOSE/EXPUNGE 后重选要能反映出删掉了）
        sock.write(`* ${alive.size} EXISTS\r\n* 0 RECENT\r\n`);
        sock.write('* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 115] ok\r\n');
        sock.write(`${tag2} OK [READ-WRITE] selected\r\n`);
      } else if (C === 'LIST') {
        // LIST "" "" 是 imapflow 的命名空间探测：必须按规范回空条目，
        // 否则最后一个文件夹会被当成命名空间前缀，后续所有路径都被拼上它
        if (/^""\s+""$/.test(rest.trim())) {
          sock.write(`* LIST (\\Noselect) "/" ""\r\n${tag2} OK done\r\n`);
        } else {
          sock.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
          sock.write('* LIST (\\HasNoChildren \\Trash) "/" "Trash"\r\n');
          sock.write('* LIST (\\HasNoChildren \\Sent) "/" "Sent"\r\n');
          sock.write('* LIST (\\HasNoChildren) "/" "Projects2026"\r\n');
          sock.write(`${tag2} OK done\r\n`);
        }
      } else if (C === 'STATUS') {
        // ⚠ 文件夹名必须带引号：imapflow 的解析器对不带引号的 STATUS 响应会丢弃全部属性
        const stName = rest.split(/\s+/).slice(0, -1).join(' ').replace(/^"|"$/g, '');
        sock.write(`* STATUS "${stName}" (MESSAGES ${COUNT} UIDNEXT 115 UIDVALIDITY 1 UNSEEN 14)\r\n${tag2} OK done\r\n`);
      } else if (C === 'FETCH') {
        fetchLog.push(`${isUid ? 'UID ' : ''}${rest}`);
        const range = rest.split(/\s+/)[0];
        // 正文抓取：UID FETCH n (UID FLAGS BODY[].PEEK[]) —— 返回带 literal 的完整源码
        if (/BODY(\.PEEK)?\[/i.test(rest)) {
          const uid = parseInt(range, 10);
          const seq = uid - 100;
          const raw = [
            'From: =?UTF-8?B?5byg5LiJ?= <zhangsan@qq.com>',
            'To: me <me@qq.com>',
            `Subject: =?UTF-8?B?${Buffer.from(`测试邮件 ${seq}`, 'utf8').toString('base64')}?=`,
            'Date: Mon, 2 Nov 2026 09:00:00 +0800',
            'Reply-To: fake@evil.com',
            'Return-Path: <bounce@qq.com>',
            'Authentication-Results: spf=fail (domain of zhangsan@qq.com) smtp.mailfrom=zhangsan@qq.com;',
            `Message-ID: <msg${seq}@qq.com>`,
            'Content-Type: text/plain; charset=utf-8',
            '',
            '正文内容 hello body',
            '',
          ].join('\r\n');
          const len = Buffer.byteLength(raw, 'utf8');
          sock.write(`* ${seq} FETCH (UID ${uid} FLAGS (\\Seen) BODY[] {${len}}\r\n${raw})\r\n`);
          sock.write(`${tag2} OK body done\r\n`);
          continue;
        }
        // UID FETCH 的 range 是 uid 列表（逗号/冒号区间）——「只看未读」按名单取信封走这里
        if (isUid || range.includes(',')) {
          const topUid = COUNT + 100; // 假服务器 uid = 100 + 序号，最高就是 114
          const uids = range.split(',').flatMap((x) => {
            if (x.includes(':')) {
              const [p0, q0] = x.split(':');
              const p = parseInt(p0, 10);
              const q = Number.isFinite(parseInt(q0, 10)) ? parseInt(q0, 10) : topUid; // 「n:*」= n 到最大 uid
              return Array.from({ length: Math.abs(q - p) + 1 }, (_, k) => Math.min(p, q) + k);
            }
            return [parseInt(x, 10)];
          }).filter(Number.isFinite);
          for (const uid of uids) {
            const i = uid - 100;
            if (i < 1 || i > COUNT) continue;
            sock.write(`* ${i} FETCH (UID ${uid} FLAGS (\\Seen) INTERNALDATE "02-Nov-2026 09:00:00 +0800" RFC822.SIZE 1234 ${envelope(i)} ${SENT_BODY})\r\n`);
          }
          sock.write(`${tag2} OK fetch done\r\n`);
          continue;
        }
        const [a, b] = range.split(':').map((x) => parseInt(x, 10));
        const from = Number.isFinite(a) ? a : 1;
        const to = Number.isFinite(b) ? b : from;
        // 真服务器对「序号 > EXISTS」的范围回 BAD（RFC 3501）；模拟它才能抓住
        // 「UID 区间被误当序号发出去」这类 bug——假服务器放行的话测试就白测了
        if (!isUid && from > COUNT) {
          sock.write(`${tag2} BAD Invalid messageset\r\n`);
          continue;
        }
        if (!(to >= 1)) {
          sock.write(`${tag2} OK done\r\n`);
          continue;
        }
        for (let i = from; i <= Math.min(to, COUNT); i++) {
          sock.write(`* ${i} FETCH (UID ${100 + i} FLAGS (\\Seen) INTERNALDATE "02-Nov-2026 09:00:00 +0800" RFC822.SIZE 1234 ${envelope(i)} ${SENT_BODY})\r\n`);
        }
        sock.write(`${tag2} OK fetch done\r\n`);
      } else if (C === 'SEARCH') {
        searchLog.push(rest);
        // 按 uid 的 SEARCH（deleteMessages 的删后校验用）：返回这批 uid 里还活着的
        if (/^UID\s/i.test(rest.trim())) {
          const set = rest.trim().slice(4);
          const want = expandUidSet(set);
          const hits = [...alive].filter((u) => want.includes(u)).sort((a, b) => a - b);
          sock.write(`* SEARCH ${hits.join(' ')}\r\n${tag2} OK search done\r\n`);
        } else {
          // 只看未读的名单来源：固定返回 3 个 uid，断言只关心命令与后续 FETCH 名单
          sock.write(`* SEARCH 103 105 107\r\n${tag2} OK search done\r\n`);
        }
      } else if (C === 'STORE') {
        // 记录整夹操作发出的 STORE（全部已读 / 清空），供后面断言
        storeLog.push(rest);
        // \Deleted 只打标不销账：EXPUNGE 才真删（RFC 3501 两段式语义）
        if (/\\Deleted/i.test(rest)) {
          const set = expandUidSet(rest.split(/\s+/)[0]);
          for (const u of (isUid ? set : set.map((s) => s + 100))) flagged.add(u);
        }
        sock.write(`${tag2} OK store done\r\n`);
      } else if (C === 'EXPUNGE' && isUid) {
        // UID EXPUNGE（服务器带 UIDPLUS 能力才会发）：
        // 模拟 QQ 怪癖——带逗号列表的多 uid 回 OK 但不删（假成功），单个 uid 正常删
        const set = expandUidSet(rest);
        if (rest.includes(',') && set.length > 1) {
          qqRefusedLog.push(rest);
          sock.write(`${tag2} OK expunge done\r\n`);
        } else {
          expungeCount++;
          for (const u of set) {
            if (alive.delete(u)) {
              flagged.delete(u);
              sock.write(`* ${u - 100} EXPUNGE\r\n`);
            }
          }
          sock.write(`${tag2} OK expunge done\r\n`);
        }
      } else if (C === 'EXPUNGE') {
        expungeCount++;
        // 真服务器必须推未应答 EXPUNGE 行，imapflow 才会把 mailbox.exists 减到 0；
        // 不推的话「清空后校验剩余数」会误判为没删掉
        for (const u of [...flagged].sort((a, b) => b - a)) {
          if (alive.delete(u)) sock.write(`* ${u - 100} EXPUNGE\r\n`);
        }
        flagged.clear();
        sock.write(`${tag2} OK expunge done\r\n`);
      } else if (C === 'DELETE') {
        deleteLog.push(rest);
        sock.write(`${tag2} OK delete done\r\n`);
      } else if (C === 'CREATE' || C === 'RENAME' || C === 'SUBSCRIBE') {
        sock.write(`${tag2} OK done\r\n`);
      } else if (C === 'LOGOUT') {
        sock.write(`* BYE bye\r\n${tag2} OK done\r\n`);
        sock.end();
      } else if (C === 'NOOP' || C === 'UNSELECT') {
        sock.write(`${tag2} OK done\r\n`);
      } else if (C === 'CLOSE') {
        // RFC 3501 CLOSE：悄悄清除所有 \Deleted（没有未应答 EXPUNGE 行）
        for (const u of flagged) alive.delete(u);
        flagged.clear();
        sock.write(`${tag2} OK close done\r\n`);
      } else {
        sock.write(`${tag2} BAD unsupported ${cmd}\r\n`);
      }
    }
  });
  sock.on('error', () => {});
});

await new Promise((r) => server.listen(43143, '127.0.0.1', r));

const { createUser, saveAccounts, ensureDataDirs } = await import('../server/store.js');
const { listMessages, listFolders, unseenCounts, getMessage } = await import('../server/mail.js');

ensureDataDirs();
const user = createUser({ username: 'imaptest', password: 'password123', role: 'member' });
saveAccounts(user.id, [
  {
    id: 'a_test',
    email: 'me@qq.com',
    displayName: '测试',
    color: '#2d6cf6',
    preset: null,
    imap: { host: '127.0.0.1', port: 43143, tls: false, allowInsecureTls: true },
    smtp: { host: '127.0.0.1', port: 43143, tls: false, allowInsecureTls: true },
    auth: { user: 'me@qq.com', pass: 'x'.repeat(10) },
    createdAt: Date.now(),
  },
  {
    // Outlook 这类 OAuth2 账号：没有密码，只有 refresh_token + 当前 access_token
    id: 'a_oauth',
    email: 'demo@outlook.com',
    displayName: 'Outlook',
    color: '#2d6cf6',
    preset: 'outlook',
    imap: { host: '127.0.0.1', port: 43143, tls: false, allowInsecureTls: true },
    smtp: { host: '127.0.0.1', port: 43143, tls: false, allowInsecureTls: true },
    auth: {
      type: 'oauth2',
      user: 'demo@outlook.com',
      refreshToken: 'rt-1',
      accessToken: 'fake-access-token',
      expiresAt: Date.now() + 3600 * 1000,
      clientId: '11111111-2222-3333-4444-555555555555',
    },
    createdAt: Date.now(),
  },
]);

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra); }
};

// 并发触发（复刻真实前端：folder + unread 同时来），验证连接池与列表都正常
const [folders, unread, page1] = await Promise.all([
  listFolders(user.id, 'a_test'),
  unseenCounts(user.id, 'a_test'),
  listMessages(user.id, 'a_test', 'INBOX', { page: 1, pageSize: 50 }),
]);

check('文件夹列表非空', folders.length === 4, JSON.stringify(folders.map((f) => f.path)));
check('未读数', unread.INBOX === 14, JSON.stringify(unread));
check('邮件总数 = 14', page1.total === 14, `total=${page1.total}`);
check('返回邮件条数 = 14', page1.messages.length === 14, `len=${page1.messages.length}`);
check('主题解析正确', page1.messages[0].subject.startsWith('测试邮件'), page1.messages[0]?.subject);
check('发件人解析正确', page1.messages[0].from.address === 'zhangsan@qq.com', JSON.stringify(page1.messages[0]?.from));
check('附件标记为 false', page1.messages[0].hasAttachment === false);

// 第二页：应只剩空（pageSize 10）
const p2 = await listMessages(user.id, 'a_test', 'INBOX', { page: 2, pageSize: 10 });
check('分页 page2 有 4 条', p2.messages.length === 4, `len=${p2.messages.length}`);

// 只看未读：SEARCH UNSEEN 拿名单 → 按名单 FETCH，不再整夹拉信封
const un = await listMessages(user.id, 'a_test', 'INBOX', { unreadOnly: true, page: 1, pageSize: 5 });
check('未读分页发出 SEARCH UNSEEN', searchLog.some((l) => /UNSEEN/i.test(l)), JSON.stringify(searchLog));
check('未读总数来自 SEARCH', un.total === 3, `total=${un.total}`);
check('未读分页只取名单内的 uid', un.messages.length === 3 && un.messages.every((m) => [103, 105, 107].includes(m.uid)),
  JSON.stringify(un.messages.map((m) => m.uid)));
check('未读列表新的在前', un.messages[0].uid === 107, JSON.stringify(un.messages.map((m) => m.uid)));
const un2 = await listMessages(user.id, 'a_test', 'INBOX', { unreadOnly: true, page: 2, pageSize: 5 });
check('未读分页第二页为空', un2.total === 3 && un2.messages.length === 0, `len=${un2.messages.length}`);

// 读信正文（回归：raw.flags is not iterable —— fetchOne 查询必须显式要 flags）
const msg = await getMessage(user.id, 'a_test', 'INBOX', 101);
check('正文主题解析', msg.subject === '测试邮件 1', msg.subject);
check('正文内容解析', (msg.text || '').includes('正文内容 hello body'), JSON.stringify(msg.text));
check('正文 flags 可迭代且含 \\Seen', Array.isArray(msg.flags) && msg.flags.includes('\\Seen'), JSON.stringify(msg.flags));
check('正文发件人地址', msg.from.address === 'zhangsan@qq.com', JSON.stringify(msg.from));
// 防钓鱼信头：Reply-To 与发件人不一致、Return-Path、认证结果原样透出
check('正文带防钓鱼信头', msg.replyTo?.address === 'fake@evil.com'
  && /bounce@qq\.com/.test(msg.returnPath || '')
  && /spf=fail/.test(msg.authResults || ''),
JSON.stringify({ replyTo: msg.replyTo, returnPath: msg.returnPath, authResults: msg.authResults }));

// OAuth2 账号（Outlook）：必须走 AUTHENTICATE XOAUTH2，而不是 LOGIN
const oauthPage = await listMessages(user.id, 'a_oauth', 'INBOX', { page: 1, pageSize: 50 });
check('OAuth 账号能收信', oauthPage.total === 14 && oauthPage.messages.length === 14, `total=${oauthPage.total} len=${oauthPage.messages.length}`);
check('OAuth 认证走 XOAUTH2 而非密码', sawXoauth2 === true);

// ---------- 整夹操作：全部已读 / 清空（都应发 UID STORE，清空还要 EXPUNGE） ----------
const { markAllRead, emptyFolder } = await import('../server/mail.js');
await markAllRead(user.id, 'a_test', 'INBOX');
check('全部已读发出 STORE 1:* +\\Seen', storeLog.some((l) => /^1:\*\s+\+FLAGS/.test(l) && /\\Seen/.test(l)),
  JSON.stringify(storeLog));
await emptyFolder(user.id, 'a_test', 'Trash');
check('清空发出 STORE \\Deleted', storeLog.some((l) => /\\Deleted/.test(l)), JSON.stringify(storeLog));
check('清空触发 EXPUNGE（真删，不是再进垃圾箱）', expungeCount >= 1, String(expungeCount));

// 后台清空走独立连接（不占读写池）：要能自己握手、选夹、删干净
const { emptyFolderIsolated } = await import('../server/mail.js');
const expungeBefore = expungeCount;
await emptyFolderIsolated(user.id, 'a_test', 'Trash');
check('后台清空用独立连接也能真删', expungeCount > expungeBefore, `${expungeBefore} -> ${expungeCount}`);

// ---------- 增量对账回归：UID 区间必须以 UID 语义发 FETCH（2026-11-09「已删除夹丢新邮件」的根因） ----------
{
  const cache = await import('../server/cache.js');
  const { syncFolderSnapshot } = await import('../server/idle.js');
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: '127.0.0.1', port: 43143, tls: false, logger: false,
    auth: { user: 'me@qq.com', pass: 'x'.repeat(10) },
  });
  await client.connect();
  const F = 'Projects2026';
  // 种一个「停在旧状态」的索引：只有 uid 101..104 四封，全量索引完整、uidvalidity 未变
  cache.clearFolder(user.id, 'a_test', F);
  cache.upsertEnvelopes(user.id, 'a_test', F,
    [1, 2, 3, 4].map((i) => ({ uid: 100 + i, subject: `旧邮件 ${i}`, date: '2026-02-01T00:00:00Z', flags: ['\\Seen'] })),
    1);
  cache.markFullIndex(user.id, 'a_test', F, true);
  cache.setUidvalidity(user.id, 'a_test', F, 1);
  const fetchBefore = fetchLog.length;
  const out = await syncFolderSnapshot(user.id, 'a_test', client, F);
  // 服务器有 14 封（uid 101..114）、本地 4 封 → 增量应拉 uid 105..114 共 10 封；
  // 修 bug 前这里发的是「序号 FETCH 105:*」→ 服务器 BAD → 整个对账失败 → 文件夹永远停在 4 封
  check('增量对账走 incremental 且拉满差值', out.mode === 'incremental' && out.fetched === 10, JSON.stringify(out));
  check('增量 FETCH 以 UID 语义发出（带 UID 前缀，不是序号）',
    fetchLog.slice(fetchBefore).some((l) => /^UID 105:\*/.test(l)), JSON.stringify(fetchLog.slice(fetchBefore)));
  check('对账后本地总数与服务器一致', cache.folderTotal(user.id, 'a_test', F) === 14,
    String(cache.folderTotal(user.id, 'a_test', F)));
  client.close();
}

// ---------- 批量删除回归：messageDelete 静默失败绝不能当成功（「全选删除没效果」的兜底） ----------
{
  const { deleteMessages } = await import('../server/mail.js');
  // 把活账本重置满（前面的清空测试把它删光了），删 uid 101..103 三封。
  // 假服务器带 UIDPLUS 且模拟 QQ 怪癖：带逗号列表的 UID EXPUNGE 回 OK 但不删——
  // deleteMessages 必须靠删后校验发现、逐封兜底救回，而不是当成功。
  for (let i = 1; i <= COUNT; i++) alive.add(100 + i);
  flagged.clear();
  const refusedBefore = qqRefusedLog.length;
  const searchBefore = searchLog.length;
  await deleteMessages(user.id, 'a_test', 'Projects2026', [101, 102, 103]);
  check('批量删除 3 封不抛错（删后校验通过）', true);
  check('多 uid UID EXPUNGE 被假成功命中（QQ 怪癖被模拟）', qqRefusedLog.length > refusedBefore, JSON.stringify(qqRefusedLog));
  check('兜底逐封重删（单个 uid 的 UID EXPUNGE）', searchLog.slice(searchBefore).some((l) => /^UID\s+101[, ]|UID\s+102[, ]|UID\s+103/.test(l.trim())),
    JSON.stringify(searchLog.slice(searchBefore)));
  check('删后校验按 uid SEARCH 发出', searchLog.slice(searchBefore).some((l) => /^UID 101,102,103/i.test(l.trim())),
    JSON.stringify(searchLog.slice(searchBefore)));
  check('被删的 uid 从服务器账本消失', !alive.has(101) && !alive.has(102) && !alive.has(103), JSON.stringify([...alive]));
}

// ---------- 批量删除回归②：单 uid 的快路径不受怪癖影响 ----------
{
  const { deleteMessages } = await import('../server/mail.js');
  for (let i = 1; i <= COUNT; i++) alive.add(100 + i);
  flagged.clear();
  await deleteMessages(user.id, 'a_test', 'Projects2026', [102]);
  check('单封删除不抛错（单 uid UID EXPUNGE 正常删）', true);
  check('102 从账本消失', !alive.has(102), JSON.stringify([...alive]));
}

// ---------- 删除文件夹：只放行自建（无 special），INBOX/系统文件夹在进 IMAP 前就拒绝 ----------
const { deleteFolder: delFolder } = await import('../server/mail.js');
await delFolder(user.id, 'a_test', 'INBOX').then(() => check('INBOX 拒绝删除', false, '居然成功了')).catch((e) => check('INBOX 拒绝删除', /收件箱不能删除/.test(e.message), e.message));
await delFolder(user.id, 'a_test', 'Trash').then(() => check('系统文件夹拒绝删除', false, '居然成功了')).catch((e) => check('系统文件夹拒绝删除', /系统文件夹不能删除/.test(e.message), e.message));
await delFolder(user.id, 'a_test', '不存在/的文件夹').then(() => check('不存在的文件夹报 404 语义', false, '居然成功了')).catch((e) => check('不存在的文件夹报 404 语义', /文件夹不存在/.test(e.message), e.message));
console.log('DEBUG listFolders:', JSON.stringify(await listFolders(user.id, 'a_test')));
await delFolder(user.id, 'a_test', 'Projects2026');
check('自建文件夹发出 DELETE 命令', deleteLog.length === 1 && /Projects2026/.test(deleteLog[0]), JSON.stringify(deleteLog));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}  pass=${pass} fail=${fail}`);
server.close();
process.exit(fail === 0 ? 0 : 1);
