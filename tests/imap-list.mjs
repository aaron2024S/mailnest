// 假 IMAP 服务器 + listMessages 端到端验证（本机无真实邮箱时用）
// 用法：node tests/imap-list.mjs
import net from 'node:net';

// store.js 在导入时读取 MAILNEST_DATA，必须先设好（保持跨平台，不依赖 shell 变量语法）
process.env.MAILNEST_DATA = process.env.MAILNEST_DATA || '.imap-test';

const COUNT = 14;
const SENT_BODY = 'BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 20 1)';

function envelope(i) {
  return `ENVELOPE ("Mon, 2 Nov 2026 09:${String(i).padStart(2, '0')}:00 +0800" "测试邮件 ${i}" (("张三" NIL "zhangsan" "qq.com")) (("张三" NIL "zhangsan" "qq.com")) (("张三" NIL "zhangsan" "qq.com")) (("me" NIL "me" "qq.com")) NIL NIL NIL "<msg${i}@qq.com>")`;
}

let sawXoauth2 = false;

const server = net.createServer((sock) => {
  sock.setEncoding('utf8');
  sock.write('* OK [CAPABILITY IMAP4rev1 ID AUTH=XOAUTH2 SASL-IR] mock ready\r\n');
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
        sock.write(`* CAPABILITY IMAP4rev1 ID AUTH=XOAUTH2 SASL-IR\r\n${tag2} OK done\r\n`);
      } else if (C === 'ID') {
        sock.write(`* ID ("name" "mock")\r\n${tag2} OK done\r\n`);
      } else if (C === 'LOGIN') {
        sock.write(`${tag2} OK [CAPABILITY IMAP4rev1 ID AUTH=XOAUTH2 SASL-IR] logged in\r\n`);
      } else if (C === 'AUTHENTICATE') {
        // OAuth2 账号走 AUTHENTICATE XOAUTH2 <base64(user=..\x01auth=Bearer ..\x01\x01)>
        const parts = rest.split(/\s+/);
        const mech = (parts[0] || '').toUpperCase();
        let raw = '';
        try { raw = Buffer.from(parts[1] || '', 'base64').toString('utf8'); } catch { raw = ''; }
        if (mech === 'XOAUTH2' && /^user=[^\u0001]+\u0001auth=Bearer [^\u0001]+\u0001\u0001$/.test(raw)) {
          sawXoauth2 = true;
          sock.write(`${tag2} OK [CAPABILITY IMAP4rev1 ID AUTH=XOAUTH2 SASL-IR] authenticated\r\n`);
        } else {
          sock.write(`${tag2} NO [AUTHENTICATIONFAILED] bad token\r\n`);
        }
      } else if (C === 'SELECT' || C === 'EXAMINE') {
        sock.write('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n');
        sock.write(`* ${COUNT} EXISTS\r\n* 0 RECENT\r\n`);
        sock.write('* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 115] ok\r\n');
        sock.write(`${tag2} OK [READ-WRITE] selected\r\n`);
      } else if (C === 'LIST') {
        sock.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
        sock.write('* LIST (\\HasNoChildren \\Trash) "/" "Trash"\r\n');
        sock.write('* LIST (\\HasNoChildren \\Sent) "/" "Sent"\r\n');
        sock.write(`${tag2} OK done\r\n`);
      } else if (C === 'STATUS') {
        sock.write(`* STATUS ${rest.split(/\s+/).slice(0, -1).join(' ')} (UNSEEN 14)\r\n${tag2} OK done\r\n`);
      } else if (C === 'FETCH') {
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
        const [a, b] = range.split(':').map((x) => parseInt(x, 10));
        const from = Number.isFinite(a) ? a : 1;
        const to = Number.isFinite(b) ? b : from;
        if (!(to >= 1)) {
          sock.write(`${tag2} OK done\r\n`);
          continue;
        }
        for (let i = from; i <= Math.min(to, COUNT); i++) {
          sock.write(`* ${i} FETCH (UID ${100 + i} FLAGS (\\Seen) INTERNALDATE "02-Nov-2026 09:00:00 +0800" RFC822.SIZE 1234 ${envelope(i)} ${SENT_BODY})\r\n`);
        }
        sock.write(`${tag2} OK fetch done\r\n`);
      } else if (C === 'LOGOUT') {
        sock.write(`* BYE bye\r\n${tag2} OK done\r\n`);
        sock.end();
      } else if (C === 'NOOP' || C === 'CLOSE' || C === 'UNSELECT') {
        sock.write(`${tag2} OK done\r\n`);
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

check('文件夹列表非空', folders.length === 3, JSON.stringify(folders.map((f) => f.path)));
check('未读数', unread.INBOX === 14, JSON.stringify(unread));
check('邮件总数 = 14', page1.total === 14, `total=${page1.total}`);
check('返回邮件条数 = 14', page1.messages.length === 14, `len=${page1.messages.length}`);
check('主题解析正确', page1.messages[0].subject.startsWith('测试邮件'), page1.messages[0]?.subject);
check('发件人解析正确', page1.messages[0].from.address === 'zhangsan@qq.com', JSON.stringify(page1.messages[0]?.from));
check('附件标记为 false', page1.messages[0].hasAttachment === false);

// 第二页：应只剩空（pageSize 10）
const p2 = await listMessages(user.id, 'a_test', 'INBOX', { page: 2, pageSize: 10 });
check('分页 page2 有 4 条', p2.messages.length === 4, `len=${p2.messages.length}`);

// 读信正文（回归：raw.flags is not iterable —— fetchOne 查询必须显式要 flags）
const msg = await getMessage(user.id, 'a_test', 'INBOX', 101);
check('正文主题解析', msg.subject === '测试邮件 1', msg.subject);
check('正文内容解析', (msg.text || '').includes('正文内容 hello body'), JSON.stringify(msg.text));
check('正文 flags 可迭代且含 \\Seen', Array.isArray(msg.flags) && msg.flags.includes('\\Seen'), JSON.stringify(msg.flags));
check('正文发件人地址', msg.from.address === 'zhangsan@qq.com', JSON.stringify(msg.from));

// OAuth2 账号（Outlook）：必须走 AUTHENTICATE XOAUTH2，而不是 LOGIN
const oauthPage = await listMessages(user.id, 'a_oauth', 'INBOX', { page: 1, pageSize: 50 });
check('OAuth 账号能收信', oauthPage.total === 14 && oauthPage.messages.length === 14, `total=${oauthPage.total} len=${oauthPage.messages.length}`);
check('OAuth 认证走 XOAUTH2 而非密码', sawXoauth2 === true);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}  pass=${pass} fail=${fail}`);
server.close();
process.exit(fail === 0 ? 0 : 1);
