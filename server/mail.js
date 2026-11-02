import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import { findAccount } from './store.js';

// ---------- 连接管理 ----------
// key: `${uid}:${accountId}` -> { client, ready: Promise<ImapFlow> }
const pools = new Map();

function clientConfig(acc) {
  return {
    host: acc.imap.host,
    port: Number(acc.imap.port) || 993,
    secure: acc.imap.tls !== false,
    auth: { user: acc.auth.user, pass: acc.auth.pass },
    // 网易系要求客户端在握手时发 IMAP ID，imapflow 检测到服务端 ID 能力后自动发送
    clientInfo: { name: 'MailNest', version: '0.1.1', vendor: 'MailNest' },
    logger: false,
    tls: { rejectUnauthorized: acc.imap.allowInsecureTls !== true },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
  };
}

function poolKey(uid, accountId) {
  return `${uid}:${accountId}`;
}

async function getClient(uid, accountId) {
  const acc = findAccount(uid, accountId);
  if (!acc) throw Object.assign(new Error('邮箱账号不存在'), { status: 404 });

  const key = poolKey(uid, accountId);
  const stamp = JSON.stringify(clientConfig(acc));
  let entry = pools.get(key);
  if (entry && (entry.accountStamp !== stamp || entry.client.closed)) {
    try { entry.client.close(); } catch { /* ignore */ }
    pools.delete(key);
    entry = null;
  }
  if (!entry) {
    const client = new ImapFlow(clientConfig(acc));
    entry = { client, acc, accountStamp: stamp };
    // ready 存进 entry：并发请求共享同一个连接建立过程，杜绝「连接未就绪就发命令」的竞态
    entry.ready = client
      .connect()
      .then(() => entry)
      .catch((e) => {
        pools.delete(key);
        try { client.close(); } catch { /* ignore */ }
        throw e;
      });
    pools.set(key, entry);
  }
  await entry.ready;
  return entry;
}

export async function dropConnections(uid, accountId = null) {
  for (const [key, entry] of pools.entries()) {
    if (!key.startsWith(`${uid}:`)) continue;
    if (accountId && !key.endsWith(`:${accountId}`)) continue;
    try { entry.client.close(); } catch { /* ignore */ }
    pools.delete(key);
  }
}

async function withMailbox(uid, accountId, folder, fn) {
  const { client } = await getClient(uid, accountId);
  const lock = await client.getMailboxLock(folder);
  try {
    return await fn(client, lock);
  } finally {
    lock.release();
  }
}

function imapError(e) {
  const msg = String(e?.responseText || e?.message || e || '未知错误');
  if (/AUTHENTICATIONFAILED|AUTHORIZATIONFAILED|Invalid credentials|LOGIN/i.test(msg)) {
    return Object.assign(new Error('登录失败：请检查邮箱地址与授权码（不是网页登录密码）'), { status: 401 });
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timeout/i.test(msg)) {
    return Object.assign(new Error('无法连接邮件服务器：请检查服务器地址、端口与网络'), { status: 502 });
  }
  if (/Unsafe Login|SAFEAUTH/i.test(msg)) {
    return Object.assign(new Error('服务器拒绝了这次登录（Unsafe Login）：确认已在邮箱网页端开启 IMAP 服务'), { status: 403 });
  }
  if (/TRYCREATE/i.test(msg)) {
    return Object.assign(new Error('目标文件夹不存在'), { status: 400 });
  }
  return Object.assign(new Error(`邮件服务器错误：${msg}`), { status: 502 });
}

// ---------- 文件夹 ----------
function folderNode(f) {
  return {
    path: f.path,
    name: f.name,
    delim: f.delimiter || '/',
    special: f.specialUse || null,
    subscribed: !!f.subscribed,
  };
}

export async function listFolders(uid, accountId) {
  try {
    const { client } = await getClient(uid, accountId);
    const list = await client.list();
    return list.filter((f) => !f.flags.has('\\Noselect')).map(folderNode);
  } catch (e) {
    throw imapError(e);
  }
}

// ---------- 邮件列表 ----------
const PAGE_MAX = 100;

function bodyHasAttachment(bodyStructure) {
  const walk = (node) => {
    if (!node) return false;
    if ((node.disposition || '').toLowerCase() === 'attachment') return true;
    return (node.childNodes || []).some(walk);
  };
  return walk(bodyStructure);
}

export async function listMessages(uid, accountId, folder, { page = 1, pageSize = 50 } = {}) {
  pageSize = Math.min(Math.max(1, pageSize | 0), PAGE_MAX);
  page = Math.max(1, page | 0);
  try {
    return await withMailbox(uid, accountId, folder, async (client) => {
      // 注意：getMailboxLock 返回的锁对象只有 { path, release }，没有 count；
      // 邮件总数要从 client.mailbox.exists 取（选中的邮箱对象）
      const total = client.mailbox?.exists || 0;
      const start = Math.max(1, total - (page - 1) * pageSize - pageSize + 1);
      const end = total - (page - 1) * pageSize;
      const out = [];
      if (end < 1) return { total, page, pageSize, messages: [] };
      for await (const msg of client.fetch(`${start}:${end}`, {
        uid: true, flags: true, envelope: true, bodyStructure: true,
        internalDate: true, size: true,
      })) {
        const env = msg.envelope || {};
        out.push({
          uid: msg.uid,
          from: env.from?.[0]
            ? { name: env.from[0].name || '', address: env.from[0].address || '' }
            : { name: '', address: '' },
          to: (env.to || []).map((t) => ({ name: t.name || '', address: t.address || '' })),
          subject: env.subject || '(无主题)',
          date: msg.internalDate ? msg.internalDate.toISOString() : null,
          flags: [...msg.flags],
          size: msg.size || 0,
          hasAttachment: bodyHasAttachment(msg.bodyStructure),
        });
      }
      out.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
      return { total, page, pageSize, messages: out };
    });
  } catch (e) {
    throw imapError(e);
  }
}

// ---------- 邮件正文 ----------
function cleanHtml(html) {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'style', 'table', 'thead', 'tbody', 'tr', 'td', 'th']),
    allowedAttributes: {
      '*': ['style', 'class', 'align', 'width', 'height', 'colspan', 'rowspan', 'dir'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      table: ['border', 'cellpadding', 'cellspacing'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data'],
    allowedStyles: {
      '*': {
        color: [/.*/], 'background-color': [/.*/], 'text-align': [/.*/], 'font-size': [/.*/],
        'font-weight': [/.*/], 'font-family': [/.*/], border: [/.*/], padding: [/.*/],
        margin: [/.*/], width: [/.*/], 'line-height': [/.*/], 'text-decoration': [/.*/],
        'vertical-align': [/.*/], 'white-space': [/.*/],
      },
    },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer nofollow' }),
    },
  });
}

export async function getMessage(uid, accountId, folder, messageUid) {
  try {
    return await withMailbox(uid, accountId, folder, async (client) => {
      const raw = await client.fetchOne(String(messageUid), { uid: true, source: true }, { uid: true });
      if (!raw) throw Object.assign(new Error('邮件不存在'), { status: 404 });
      const parsed = await simpleParser(raw.source);
      const attachments = (parsed.attachments || []).map((a, i) => ({
        id: i,
        filename: a.filename || `attachment-${i + 1}`,
        contentType: a.contentType || 'application/octet-stream',
        size: a.size ?? (a.content ? a.content.length : 0),
        cid: a.cid || null,
      }));
      let html = null;
      if (parsed.html) {
        html = cleanHtml(typeof parsed.html === 'string' ? parsed.html : parsed.html.toString());
      }
      return {
        uid: Number(messageUid),
        from: parsed.from ? { name: parsed.from.text ? '' : '', address: parsed.from.value?.[0]?.address || '', text: parsed.from?.text || '' } : null,
        to: (parsed.to?.value || []).map((t) => ({ name: t.name || '', address: t.address || '' })),
        cc: (parsed.cc?.value || []).map((t) => ({ name: t.name || '', address: t.address || '' })),
        subject: parsed.subject || '(无主题)',
        date: parsed.date ? parsed.date.toISOString() : null,
        messageId: parsed.messageId || '',
        inReplyTo: parsed.inReplyTo || null,
        references: parsed.references || null,
        text: parsed.text || '',
        html,
        attachments,
        flags: [...raw.flags],
      };
    });
  } catch (e) {
    if (e.status) throw e;
    throw imapError(e);
  }
}

export async function getAttachment(uid, accountId, folder, messageUid, attachmentIndex) {
  // 通过完整源码解析并返回指定附件（数量在百级以内都可接受）
  return withMailbox(uid, accountId, folder, async (client) => {
    const raw = await client.fetchOne(String(messageUid), { uid: true, source: true }, { uid: true });
    if (!raw) throw Object.assign(new Error('邮件不存在'), { status: 404 });
    const parsed = await simpleParser(raw.source);
    const att = (parsed.attachments || [])[attachmentIndex];
    if (!att) throw Object.assign(new Error('附件不存在'), { status: 404 });
    return {
      filename: att.filename || `attachment-${attachmentIndex + 1}`,
      contentType: att.contentType || 'application/octet-stream',
      content: att.content,
    };
  });
}

// ---------- 标记 / 移动 / 删除 ----------
export async function setFlags(uid, accountId, folder, messageUid, { add = [], remove = [], set = null }) {
  try {
    return await withMailbox(uid, accountId, folder, async (client) => {
      const opts = { uid: true };
      if (Array.isArray(set)) {
        await client.messageFlagsSet(String(messageUid), set, opts);
        return { ok: true, flags: set };
      }
      if (add.length) await client.messageFlagsAdd(String(messageUid), add, opts);
      if (remove.length) await client.messageFlagsRemove(String(messageUid), remove, opts);
      return { ok: true };
    });
  } catch (e) {
    throw imapError(e);
  }
}

export async function moveMessages(uid, accountId, folder, messageUids, dest) {
  try {
    return await withMailbox(uid, accountId, folder, async (client) => {
      const seq = messageUids.map(String).join(',');
      await client.messageMove(seq, dest, { uid: true });
      return { ok: true };
    });
  } catch (e) {
    throw imapError(e);
  }
}

export async function deleteMessages(uid, accountId, folder, messageUids) {
  try {
    return await withMailbox(uid, accountId, folder, async (client) => {
      const seq = messageUids.map(String).join(',');
      await client.messageDelete(seq, { uid: true });
      return { ok: true };
    });
  } catch (e) {
    throw imapError(e);
  }
}

// ---------- SMTP 发信 ----------
function transport(acc) {
  return nodemailer.createTransport({
    host: acc.smtp.host,
    port: Number(acc.smtp.port) || 465,
    secure: acc.smtp.tls !== false,
    auth: { user: acc.auth.user, pass: acc.auth.pass },
    tls: { rejectUnauthorized: acc.smtp.allowInsecureTls !== true },
    connectionTimeout: 20000,
  });
}

export async function sendMail(uid, account, opts) {
  const { to, cc, bcc, subject, text, html, inReplyTo, references, attachments = [] } = opts;
  const trans = transport(account);
  const mail = {
    from: `"${account.displayName || account.email}" <${account.email}>`,
    to: Array.isArray(to) ? to.join(', ') : to,
    cc: Array.isArray(cc) ? cc.join(', ') : cc || undefined,
    bcc: Array.isArray(bcc) ? bcc.join(', ') : bcc || undefined,
    subject: subject || '(无主题)',
    text: text || undefined,
    html: html || undefined,
    inReplyTo: inReplyTo || undefined,
    references: references || undefined,
    attachments: (attachments || []).slice(0, 20).map((a) => ({
      filename: String(a.filename || 'attachment').slice(0, 200),
      content: Buffer.from(String(a.content || ''), 'base64'),
      contentType: a.contentType || undefined,
    })),
  };
  const info = await trans.sendMail(mail);
  // 发送后归档到「已发送」（服务器支持 APPEND 才能落，失败不影响发信结果）
  try {
    const { client } = await getClient(uid, account.id);
    const folders = await client.list();
    const sent = folders.find((f) => f.specialUse === '\\Sent');
    if (sent) {
      const raw = info.message; // nodemailer 返回原始流缓冲
      const lock = await client.getMailboxLock(sent.path);
      try { await client.append(sent.path, raw, ['\\Seen']); } finally { lock.release(); }
    }
  } catch { /* 已发送归档失败静默处理 */ }
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

// ---------- 连通性测试（添加账号前调用） ----------
export async function testAccount(cfg) {
  const client = new ImapFlow({ ...clientConfig(cfg), connectionTimeout: 12000, greetingTimeout: 12000 });
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (e) {
    const err = imapError(e);
    try { client.close(); } catch { /* ignore */ }
    throw err;
  }
}

// ---------- 未读计数 ----------
export async function unseenCounts(uid, accountId) {
  try {
    const { client } = await getClient(uid, accountId);
    const list = await client.list();
    const out = {};
    for (const f of list) {
      if (f.flags.has('\\Noselect') || f.flags.has('\\Trash')) continue;
      try {
        const st = await client.status(f.path, { unseen: true });
        if (st && typeof st.unseen === 'number') out[f.path] = st.unseen;
      } catch { /* 单个文件夹失败不影响整体 */ }
    }
    return out;
  } catch (e) {
    throw imapError(e);
  }
}

// ---------- 草稿 ----------
// 草稿只存本地（不 APPEND 到服务器，避免网易等对并发写限流），每用户 drafts/ 目录
import fs from 'node:fs';
import path from 'node:path';
import { userDir } from './store.js';

function draftsDir(uid) {
  return path.join(userDir(uid), 'drafts');
}

export function listDrafts(uid) {
  const dir = draftsDir(uid);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveDraft(uid, draft) {
  const dir = draftsDir(uid);
  fs.mkdirSync(dir, { recursive: true });
  const id = draft.id || 'd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const doc = { ...draft, id, updatedAt: Date.now() };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(doc));
  return doc;
}

export function deleteDraft(uid, id) {
  const file = path.join(draftsDir(uid), `${id}.json`);
  if (!file.startsWith(draftsDir(uid))) throw new Error('bad id');
  fs.rmSync(file, { force: true });
  return { ok: true };
}
