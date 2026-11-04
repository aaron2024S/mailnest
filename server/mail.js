import fs from 'node:fs';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import { findAccount, listAccounts, saveAccounts } from './store.js';
import { refreshAccessToken } from './oauth.js';
import * as attachments from './attachments.js';

// 版本号唯一来源：package.json。IMAP 握手要把版本报给服务端（网易系会校验客户端 ID），
// 以前这里硬编码，bump 版本时必漏一处 —— 改成读文件。
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
})();

// ---------- 连接管理 ----------
// key: `${uid}:${accountId}` -> { client, ready: Promise<ImapFlow> }
const pools = new Map();

function isOAuth(acc) {
  return acc?.auth?.type === 'oauth2';
}

function clientConfig(acc, accessToken = null) {
  return {
    host: acc.imap.host,
    port: Number(acc.imap.port) || 993,
    secure: acc.imap.tls !== false,
    auth: isOAuth(acc)
      ? { user: acc.auth.user, accessToken }
      : { user: acc.auth.user, pass: acc.auth.pass },
    // 网易系要求客户端在握手时发 IMAP ID，imapflow 检测到服务端 ID 能力后自动发送
    clientInfo: { name: 'MailNest', version: APP_VERSION, vendor: 'MailNest' },
    logger: false,
    tls: { rejectUnauthorized: acc.imap.allowInsecureTls !== true },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
  };
}

// ---------- OAuth2 access token（Outlook） ----------
// 同一账号的并发请求必须共享同一次续期：refresh_token 会轮换，刷新两次会让先拿到的那份失效
const refreshes = new Map(); // `${uid}:${accountId}` -> Promise<string>

async function accessTokenFor(uid, acc) {
  const a = acc.auth || {};
  if (a.accessToken && a.expiresAt && a.expiresAt > Date.now() + 60_000) return a.accessToken;

  const key = poolKey(uid, acc.id);
  const running = refreshes.get(key);
  if (running) return running;

  const task = (async () => {
    const t = await refreshAccessToken(a.refreshToken, a.clientId || undefined);
    // 写回磁盘：refresh_token 可能已轮换，旧的不能再用
    const accounts = listAccounts(uid);
    const target = accounts.find((x) => x.id === acc.id);
    if (target) {
      target.auth = {
        ...target.auth,
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        expiresAt: t.expiresAt,
      };
      saveAccounts(uid, accounts);
    }
    Object.assign(acc.auth, { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt });
    return t.accessToken;
  })().finally(() => refreshes.delete(key));

  refreshes.set(key, task);
  return task;
}

function poolKey(uid, accountId) {
  return `${uid}:${accountId}`;
}

async function getClient(uid, accountId) {
  const acc = findAccount(uid, accountId);
  if (!acc) throw Object.assign(new Error('邮箱账号不存在'), { status: 404 });

  const key = poolKey(uid, accountId);
  // stamp 刻意不含 access token：已认证的连接不需要 token，token 过期后连接会自己断开再重建
  const stamp = JSON.stringify(clientConfig(acc, isOAuth(acc) ? 'oauth' : null));
  let entry = pools.get(key);
  if (entry && (entry.accountStamp !== stamp || entry.client.closed)) {
    try { entry.client.close(); } catch { /* ignore */ }
    pools.delete(key);
    entry = null;
  }
  if (!entry) {
    const token = isOAuth(acc) ? await accessTokenFor(uid, acc) : null;
    const client = new ImapFlow(clientConfig(acc, token));
    entry = { client, acc, accountStamp: stamp };
    // ready 存进 entry：并发请求共享同一个连接建立过程，杜绝「连接未就绪就发命令」的竞态
    entry.ready = client
      .connect()
      .then(() => entry)
      .catch((e) => {
        pools.delete(key);
        try { client.close(); } catch { /* ignore */ }
        const friendly = imapError(e);
        if (isOAuth(acc) && friendly.status === 401) {
          friendly.message = 'Outlook 授权已失效（可能改过密码或撤销了授权），请删除这个账号后重新添加';
          friendly.oauth = true;
        }
        throw friendly;
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

// 陈旧连接特征：服务器已单方面断开，但 client.closed 标志尚未置位，命令直接撞死。
// 命中就弃掉池中连接重建、自动重试一次（切换账号后回到汇总视图的典型场景）。
function isStaleConn(e) {
  return /Connection not available|NoConnection|ECONNRESET|socket hang up/i.test(String(e?.message || e));
}

async function withClient(uid, accountId, fn) {
  try {
    return await fn(await getClient(uid, accountId));
  } catch (e) {
    if (!isStaleConn(e)) throw e;
    await dropConnections(uid, accountId);
    return await fn(await getClient(uid, accountId));
  }
}

// 每个账号只有一条读写连接，所有操作靠 getMailboxLock 排他排队 —— 没有超时的话，
// 一个慢请求（大文件夹直拉、半死连接）就会把这个账号之后的所有操作永久堵在队列里：
// 用户看到的就是「切了文件夹没反应」。这两个上限就是那道保险。
const LOCK_TIMEOUT = Number(process.env.MAILNEST_LOCK_TIMEOUT_MS) || 20000;
const OP_TIMEOUT = Number(process.env.MAILNEST_OP_TIMEOUT_MS) || 60000;

async function withMailbox(uid, accountId, folder, fn, { lockMs = LOCK_TIMEOUT, opMs = OP_TIMEOUT } = {}) {
  return withClient(uid, accountId, async ({ client }) => {
    let lock;
    let timer = null;
    try {
      lock = await Promise.race([
        client.getMailboxLock(folder),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(
            new Error('邮箱服务器响应太慢，请稍后重试'), { status: 503, code: 'LOCK_TIMEOUT' },
          )), lockMs);
        }),
      ]);
    } catch (e) {
      clearTimeout(timer);
      // 等不到锁说明连接上还有别的操作卡着；弃掉这条连接让下一个请求重建，
      // 否则排队的请求会继续堵（重连比等待便宜）
      if (e.code === 'LOCK_TIMEOUT') await dropConnections(uid, accountId);
      throw e;
    }
    clearTimeout(timer);
    try {
      const op = fn(client, lock);
      const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(
          new Error('邮箱服务器响应超时，请重试（已重置连接）'), { status: 504, code: 'OP_TIMEOUT' },
        )), opMs);
      });
      return await Promise.race([op, guard]);
    } catch (e) {
      // 操作超时 = 连接上还挂着一个不返回的命令，内部队列已经不可信，弃掉重建
      if (e.code === 'OP_TIMEOUT') await dropConnections(uid, accountId);
      throw e;
    } finally {
      clearTimeout(timer);
      try { lock.release(); } catch { /* 连接已重置时释放会失败，忽略 */ }
    }
  });
}

// 专用监听连接（IDLE 用）：与读写池完全独立，互不挤占。
// 调用方（idle.js）负责关闭与重连。
export async function createListenerClient(uid, accountId) {
  const acc = findAccount(uid, accountId);
  if (!acc) throw Object.assign(new Error('邮箱账号不存在'), { status: 404 });
  const token = isOAuth(acc) ? await accessTokenFor(uid, acc) : null;
  const client = new ImapFlow(clientConfig(acc, token));
  try {
    await client.connect();
  } catch (e) {
    try { client.close(); } catch { /* ignore */ }
    throw imapError(e);
  }
  return { client, acc };
}

function imapError(e) {
  // 已经是翻译过的、给用户看的中文错误（例如 OAuth 失效、超时类 503/504），别再套一层
  if (e?.oauth || e?.status) return e;
  const msg = String(e?.responseText || e?.message || e || '未知错误');
  if (/AUTHENTICATIONFAILED|AUTHORIZATIONFAILED|Invalid credentials|LOGIN/i.test(msg)) {
    return Object.assign(new Error('登录失败：请检查邮箱地址与授权码（不是网页登录密码）'), { status: 401 });
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timeout/i.test(msg)) {
    return Object.assign(new Error('无法连接邮件服务器：请检查服务器地址、端口与网络'), { status: 502 });
  }
  if (/Connection not available|NoConnection/i.test(msg)) {
    return Object.assign(new Error('与邮箱服务器的连接已断开，请重试'), { status: 502 });
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
    return await withClient(uid, accountId, async ({ client }) => {
      const list = await client.list();
      return list.filter((f) => !f.flags.has('\\Noselect')).map(folderNode);
    });
  } catch (e) {
    throw imapError(e);
  }
}

// 新建文件夹：path 由前端拼好（父目录 + 该账号的分隔符 + 名称），服务器按 IMAP CREATE 处理
export async function createFolder(uid, accountId, path) {
  try {
    return await withClient(uid, accountId, async ({ client }) => {
      await client.mailboxCreate(path);
      return { ok: true, path };
    });
  } catch (e) {
    const msg = String(e?.message || '');
    if (/ALREADYEXISTS|already exists/i.test(msg)) {
      throw Object.assign(new Error('同名文件夹已存在'), { status: 400 });
    }
    throw imapError(e);
  }
}

// 删除文件夹：只允许用户自建的（无 special 标记且非 INBOX）。
// IMAP DELETE 语义：文件夹连同其中的邮件一并消失（多数服务器不转移），必须由前端 confirm 兜底
export async function deleteFolder(uid, accountId, path) {
  if (path === 'INBOX') throw Object.assign(new Error('收件箱不能删除'), { status: 400 });
  const node = (await listFolders(uid, accountId)).find((f) => f.path === path);
  if (!node) throw Object.assign(new Error('文件夹不存在'), { status: 404 });
  if (node.special) throw Object.assign(new Error('系统文件夹不能删除'), { status: 400 });
  try {
    return await withClient(uid, accountId, async ({ client }) => {
      await client.mailboxDelete(path);
      return { ok: true, path };
    });
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

// 列表页是「点一下就等结果」的交互，不该跟批量操作共用 60 秒上限：
// 真卡住时用户盯着空白列表一分钟，比直接报错重试难受得多。
// 20 秒对冷连接 + SELECT + 一页信封已经足够宽裕（实测 outlook 最慢十几秒）。
const LIST_TIMEOUT = Number(process.env.MAILNEST_LIST_TIMEOUT_MS) || 20000;

export async function listMessages(uid, accountId, folder, { page = 1, pageSize = 50 } = {}) {
  pageSize = Math.min(Math.max(1, pageSize | 0), PAGE_MAX);
  page = Math.max(1, page | 0);
  try {
    return await withMailbox(uid, accountId, folder, async (client) => {
      // 注意：getMailboxLock 返回的锁对象只有 { path, release }，没有 count；
      // 邮件总数要从 client.mailbox.exists 取（选中的邮箱对象）
      const total = client.mailbox?.exists || 0;
      const uidvalidity = client.mailbox?.uidValidity != null ? Number(client.mailbox.uidValidity) : null;
      const start = Math.max(1, total - (page - 1) * pageSize - pageSize + 1);
      const end = total - (page - 1) * pageSize;
      const out = [];
      if (end < 1) return { total, page, pageSize, uidvalidity, messages: [] };
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
      return { total, page, pageSize, uidvalidity, messages: out };
    }, { opMs: LIST_TIMEOUT });
  } catch (e) {
    throw imapError(e);
  }
}

// ---------- 邮件正文 ----------
// 邮件模板（Steam / Outlook 通知 / 营销邮件）靠大量内联 CSS + bgcolor/background 属性撑布局。
// 样式白名单开小了会把深色底、背景图整块剥掉 —— 白底上浅字几乎不可读（0.2.1 用户实测 Steam 邮件）。
// 所以 CSS 属性按"属性族"全放行；安全由标签与 URL scheme 白名单兜底（script/事件属性本就不在名单里）。
const cssProps = new Set([
  // 背景族
  'background', 'background-color', 'background-image', 'background-repeat', 'background-position',
  'background-position-x', 'background-position-y', 'background-size', 'background-clip', 'background-origin', 'background-attachment',
  // 边框族
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-width', 'border-style', 'border-color', 'border-radius',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'border-collapse', 'border-spacing',
  // 盒模型
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
  'box-shadow', 'box-sizing', 'outline', 'outline-width', 'outline-style', 'outline-color', 'outline-offset',
  // 布局
  'display', 'visibility', 'overflow', 'overflow-x', 'overflow-y', 'float', 'clear', 'vertical-align',
  'table-layout', 'caption-side', 'empty-cells',
  'flex', 'flex-grow', 'flex-shrink', 'flex-basis', 'flex-direction', 'flex-wrap',
  'align-items', 'align-self', 'justify-content', 'gap',
  // 文字
  'color', 'opacity', 'cursor', 'direction', 'unicode-bidi',
  'font', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant', 'font-stretch',
  'line-height', 'letter-spacing', 'word-spacing', 'word-break', 'word-wrap', 'overflow-wrap', 'white-space',
  'text-indent', 'text-align', 'text-decoration', 'text-decoration-line', 'text-decoration-color', 'text-decoration-style',
  'text-transform', 'text-shadow', 'text-overflow', 'hyphens',
  'list-style', 'list-style-type', 'list-style-position', 'list-style-image',
  'transform', 'zoom', 'object-fit', 'object-position',
]);
const allowedStyles = { '*': Object.fromEntries([...cssProps].map((p) => [p, [/.*/]])) };

function cleanHtml(html) {
  return sanitizeHtml(html, {
    // <style> 块是邮件模板布局的一部分（类选择器 + 媒体查询），sanitize-html 对它默认告警
    allowVulnerableTags: true,
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'style', 'center', 'font', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'col', 'colgroup']),
    allowedAttributes: {
      '*': ['style', 'class', 'align', 'valign', 'width', 'height', 'colspan', 'rowspan', 'dir', 'bgcolor', 'background', 'title', 'lang', 'role'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'srcset', 'sizes', 'border', 'hspace', 'vspace'],
      table: ['border', 'cellpadding', 'cellspacing', 'summary'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data'],
    allowedStyles,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer nofollow' }),
      // <body> 不在标签白名单里会被连皮剥掉 —— 邮件普遍把背景色写在 body 上。
      // 转成 div 保住属性（bgcolor/style 再走属性白名单过滤）。
      body: sanitizeHtml.simpleTransform('div'),
    },
  });
}

// 把 mime 里的 cid: 引用换成本地附件地址 —— 否则阅读区里的内嵌图片（签名 logo、
// 表格截图、邮件模板图）全是裂图，而 Outlook 里它们是直接显示的。
// 解析时替换一次即写进正文缓存，之后每次都命中本地。
function inlineCid(html, list, ctx) {
  if (!html || !list || !list.length) return html;
  const map = new Map();
  for (const a of list) {
    const k = attachments.normCid(a.cid);
    if (k) map.set(k, a.id);
  }
  if (!map.size) return html;
  return html.replace(/cid:([^"'\s>)]+)/gi, (whole, ref) => {
    let decoded = ref;
    try { decoded = decodeURIComponent(ref); } catch { /* 保持原样 */ }
    const idx = map.get(attachments.normCid(ref)) ?? map.get(attachments.normCid(decoded));
    if (idx == null) return whole;
    return attachments.attachUrl(ctx.accountId, ctx.folder, ctx.uid, idx, true);
  });
}

// 解析结果 → 缓存 / 接口的公共结构。打开邮件与后台预热共用这一份，避免两处写法漂移。
export function extractMessage(parsed, ctx) {
  const attachments = (parsed.attachments || []).map((a, i) => ({
    id: i,
    filename: a.filename || `attachment-${i + 1}`,
    contentType: a.contentType || 'application/octet-stream',
    size: a.size ?? (a.content ? a.content.length : 0),
    cid: a.cid || null,
  }));
  let html = null;
  if (parsed.html) html = cleanHtml(typeof parsed.html === 'string' ? parsed.html : parsed.html.toString());
  html = inlineCid(html, attachments, ctx);
  return {
    from: parsed.from ? { name: '', address: parsed.from.value?.[0]?.address || '', text: parsed.from?.text || '' } : null,
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
  };
}

// 附件本体顺手落盘：源码已经整封下载解析过了，写文件几乎不额外花时间
export function cacheAttachments(uid, accountId, folder, messageUid, parsed) {
  const raw = (parsed.attachments || []).map((a, i) => ({
    id: i,
    filename: a.filename || `attachment-${i + 1}`,
    contentType: a.contentType || 'application/octet-stream',
    size: a.size ?? (a.content ? a.content.length : 0),
    cid: a.cid || null,
    content: a.content,
  }));
  if (raw.length) attachments.saveAll(uid, accountId, folder, messageUid, raw).catch(() => {});
}

export async function getMessage(uid, accountId, folder, messageUid) {
  try {
    return await withMailbox(uid, accountId, folder, async (client) => {
      // flags 必须显式请求，否则服务器不返回，[...raw.flags] 会抛 "not iterable"
      const raw = await client.fetchOne(String(messageUid), { uid: true, source: true, flags: true }, { uid: true });
      if (!raw) throw Object.assign(new Error('邮件不存在'), { status: 404 });
      const parsed = await simpleParser(raw.source);
      cacheAttachments(uid, accountId, folder, messageUid, parsed);
      return { uid: Number(messageUid), ...extractMessage(parsed, { accountId, folder, uid: messageUid }), flags: [...raw.flags] };
    });
  } catch (e) {
    if (e.status) throw e;
    throw imapError(e);
  }
}

export async function getAttachment(uid, accountId, folder, messageUid, attachmentIndex) {
  // 先看本地：附件跟着正文一起落过盘，绝大多数点开是纯磁盘读
  const hit = attachments.get(uid, accountId, folder, messageUid, attachmentIndex);
  if (hit) return hit;
  // 未命中（缓存被清过 / 只缓存了正文）：整封源码取回解析
  return withMailbox(uid, accountId, folder, async (client) => {
    const raw = await client.fetchOne(String(messageUid), { uid: true, source: true }, { uid: true });
    if (!raw) throw Object.assign(new Error('邮件不存在'), { status: 404 });
    const parsed = await simpleParser(raw.source);
    cacheAttachments(uid, accountId, folder, messageUid, parsed);
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
export async function setFlags(uid, accountId, folder, messageUids, { add = [], remove = [], set = null }) {
  try {
    // 支持单个 uid 或 uid 数组：imapflow 的 flags 系列都吃逗号分隔的 UID 集合
    const seq = Array.isArray(messageUids) ? messageUids.map(String).join(',') : String(messageUids);
    if (!seq) throw new Error('没有选择邮件');
    return await withMailbox(uid, accountId, folder, async (client) => {
      const opts = { uid: true };
      if (Array.isArray(set)) {
        await client.messageFlagsSet(seq, set, opts);
        return { ok: true, flags: set };
      }
      if (add.length) await client.messageFlagsAdd(seq, add, opts);
      if (remove.length) await client.messageFlagsRemove(seq, remove, opts);
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

// 整夹标记已读：STORE 1:* +FLAGS (\Seen)，服务端一次完成 —— 不依赖前端翻页，
// 「只看未读」筛出几百封时也无需先全部加载
export async function markAllRead(uid, accountId, folder) {
  try {
    return await withMailbox(uid, accountId, folder, async (client) => {
      await client.messageFlagsAdd('1:*', ['\\Seen'], { uid: true });
      return { ok: true };
    });
  } catch (e) {
    throw imapError(e);
  }
}

// 清空文件夹：STORE \Deleted + EXPUNGE，真删（区别于删进垃圾箱）。
// 只允许对垃圾箱类文件夹调用；special 由路由层用 listFolders 校验
export async function emptyFolder(uid, accountId, folder) {
  try {
    // 几千封的 EXPUNGE 几十秒很正常，别用默认 60s 上限把它误杀
    return await withMailbox(uid, accountId, folder, async (client) => {
      await client.messageDelete('1:*', { uid: true });
      return { ok: true };
    }, { opMs: 10 * 60_000 });
  } catch (e) {
    throw imapError(e);
  }
}

// 后台清空专用：不碰读写池（一个账号只有一条池连接，几千封 EXPUNGE 可能跑几十秒，
// 复用池会让这期间所有请求排队）。后台任务不怕多一次握手开销。
// 后台清空专用：绝不与读写池抢锁（一条几十秒的 EXPUNGE 会把整账号堵死）。
// 但独立连接同样需要上限：服务器半死时没有兜底，连接和 emptyJobs 里的登记会永远挂着，
// 之后这个夹再也清不了、也永远显示「正在清空」。
const EMPTY_TIMEOUT = Number(process.env.MAILNEST_EMPTY_TIMEOUT_MS) || 10 * 60_000;

export async function emptyFolderIsolated(uid, accountId, folder) {
  const { client } = await createListenerClient(uid, accountId);
  let timer;
  try {
    const op = (async () => {
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageDelete('1:*', { uid: true });
      } finally {
        lock.release();
      }
    })();
    op.catch(() => { /* 超时后成为孤儿，别冒成 unhandledRejection */ });
    await Promise.race([
      op,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(
          new Error('清空超时：服务器长时间没有响应，已中断（可能已删除一部分，重新打开文件夹会刷新）'),
          { code: 'EMPTY_TIMEOUT', status: 504 },
        )), EMPTY_TIMEOUT);
      }),
    ]);
    return { ok: true };
  } catch (e) {
    throw imapError(e);
  } finally {
    clearTimeout(timer);
    try { client.close(); } catch { /* ignore */ }
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
function transport(acc, accessToken = null) {
  const auth = isOAuth(acc)
    ? { type: 'OAuth2', user: acc.auth.user, accessToken }
    : { user: acc.auth.user, pass: acc.auth.pass };
  return nodemailer.createTransport({
    host: acc.smtp.host,
    port: Number(acc.smtp.port) || 465,
    secure: acc.smtp.tls !== false,
    auth,
    tls: { rejectUnauthorized: acc.smtp.allowInsecureTls !== true },
    connectionTimeout: 20000,
  });
}

export async function sendMail(uid, account, opts) {
  const { to, cc, bcc, subject, text, html, inReplyTo, references, attachments = [] } = opts;
  const token = isOAuth(account) ? await accessTokenFor(uid, account) : null;
  const trans = transport(account, token);
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
      // 归档只是锦上添花：锁等不到就放弃，绝不能让"信已经发出去了"的请求挂在这里
      // （挂住 → 用户以为没发出 → 重发 → 对方收到两封）
      let timer = null;
      const lock = await Promise.race([
        client.getMailboxLock(sent.path),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('归档超时'), { code: 'SKIP_ARCHIVE' })), 5000);
        }),
      ]).catch((e) => { if (e.code === 'SKIP_ARCHIVE') return null; throw e; });
      clearTimeout(timer);
      if (lock) {
        try { await client.append(sent.path, raw, ['\\Seen']); } finally { lock.release(); }
      }
    }
  } catch { /* 已发送归档失败静默处理 */ }
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

// ---------- 连通性测试（添加账号前调用） ----------
export async function testAccount(cfg) {
  // OAuth 账号此时还没入库、没有可续期的 refresh_token，直接用带过来的 access token 试连
  const token = isOAuth(cfg) ? cfg.auth.accessToken || null : null;
  if (isOAuth(cfg) && !token) {
    throw Object.assign(new Error('Outlook 账号需要先完成授权，点「连接 Outlook」即可'), { status: 400 });
  }
  const client = new ImapFlow({ ...clientConfig(cfg, token), connectionTimeout: 12000, greetingTimeout: 12000 });
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
    return await withClient(uid, accountId, async ({ client }) => {
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
    });
  } catch (e) {
    throw imapError(e);
  }
}

// ---------- 草稿 ----------
// 草稿只存本地（不 APPEND 到服务器，避免网易等对并发写限流），每用户 drafts/ 目录
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
