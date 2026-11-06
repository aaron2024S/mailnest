// MCP 工具层：所有工具都是对 mail.js / store.js 现有函数的映射，不引入新的业务逻辑。
// 三条硬约束：
//  1. 每个工具先过 scope 检查，令牌没给的权限一律拒绝（不是靠工具不注册，而是靠显式拒绝给出可读理由）
//  2. 所有入参都按「这个用户自己的账号」解析，findAccount/listAccounts 天然按 uid 隔离
//  3. 错误信息给人话，不抛内部路径、类名、IMAP 原始响应
import { z } from 'zod';
import { listAccounts, findAccount } from './store.js';
import {
  listFolders, listMessages, getMessage, getAttachment, setFlags, moveMessages,
  markAllRead, emptyFolder, deleteFolder,
  createFolder, sendMail, saveDraft, listDrafts, deleteDraft, unseenCounts,
} from './mail.js';
import * as cache from './cache.js';
import * as idle from './idle.js';

const BODY_LIMIT = 8000;        // 正文字符上限：再长会一次性灌满模型上下文
const ATT_TEXT_LIMIT = 20000;   // 附件文本上限
const ATT_B64_LIMIT = 200_000;  // 二进制附件转 base64 的上限（原始字节数）
const SEND_ATTACH_MAX = 20;     // 单封信附件上限（与 sendMail 一致）
const SEND_ATTACH_BYTES = 20 * 1024 * 1024; // 发信附件总大小上限（解码后）
const MAX_UIDS = 200;      // 单次批量操作上限：防止 agent 误传一整页
const PAGE_MAX = 50;

const SCOPE_TEXT = { read: '读取邮件', write: '整理邮件', send: '发送邮件' };

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (o) => text(JSON.stringify(o, null, 2));
const fail = (s) => ({ content: [{ type: 'text', text: `执行失败：${s}` }], isError: true });

// 把异常压成人话。mail.js 已经把 IMAP 错误映射过一轮，这里只做兜底和截断。
function humanError(e) {
  const msg = String(e?.message || e || '未知错误');
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 账号参数允许三种写法：id、邮箱地址、显示名。只有一个账号时可以完全省略。
function resolveAccount(uid, ref) {
  const all = listAccounts(uid);
  if (!all.length) throw new Error('还没有添加任何邮箱账号，请先在 MailNest 网页端添加一个');
  const key = String(ref || '').trim();
  if (!key) {
    if (all.length === 1) return all[0];
    throw new Error(`有 ${all.length} 个账号，请用 account 指定其中一个：${all.map((a) => `${a.email}（id ${a.id}）`).join('、')}`);
  }
  const lower = key.toLowerCase();
  const hit = all.find((a) => a.id === key)
    || all.find((a) => a.email.toLowerCase() === lower)
    || all.find((a) => (a.displayName || '').toLowerCase() === lower);
  if (!hit) {
    throw new Error(`找不到账号「${key}」。可用账号：${all.map((a) => `${a.email}（id ${a.id}）`).join('、')}`);
  }
  return hit;
}

function normUids(uids) {
  const list = (Array.isArray(uids) ? uids : [uids]).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) throw new Error('没有指定要操作的邮件 uid');
  if (list.length > MAX_UIDS) throw new Error(`一次最多操作 ${MAX_UIDS} 封，当前 ${list.length} 封`);
  return [...new Set(list)];
}

function normFolder(f) {
  return String(f || 'INBOX').trim() || 'INBOX';
}

// 发信附件参数：content 必须是 base64（agent 读本地文件后自己编码）。
// 数量与解码后总大小都在这里拦，避免把几 MB 的 base64 灌进 SMTP 才失败
const attachSchema = z.array(z.object({
  filename: z.string().min(1).max(200).describe('附件文件名，例如 报告.pdf'),
  content: z.string().min(1).describe('附件内容，base64 编码'),
  contentType: z.string().optional().describe('MIME 类型，例如 application/pdf；不确定可省略'),
})).max(SEND_ATTACH_MAX).optional().describe(`附件列表（base64 编码），最多 ${SEND_ATTACH_MAX} 个、总计不超过 20MB`);

function checkAttachSize(list) {
  let total = 0;
  for (const a of list || []) {
    total += Math.floor((a.content || '').length * 3 / 4);
    if (total > SEND_ATTACH_BYTES) {
      throw new Error(`附件总体积超过 20MB（当前约 ${Math.round(total / 1024 / 1024)}MB），请压缩或分多封发送`);
    }
  }
}

// 附件按「文本类」处理就给文本，否则给 base64 —— agent 能直接读 CSV/日志/JSON，
// 图片和 PDF 这种给 base64 让上游模型自己决定
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml|sql))/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|log|json|xml|yaml|yml|ini|conf|html?|eml)$/i;

function isTextLike(contentType, filename) {
  if (TEXT_MIME.test(String(contentType || ''))) return true;
  return TEXT_EXT.test(String(filename || ''));
}

// 发信后让「已发送」缓存追上服务器（sendMail 已把原信 APPEND 到 Sent，本地缓存缺这封）
function syncSentCache(uid, accountId) {
  try {
    listFolders(uid, accountId)
      .then((folders) => {
        const sent = folders.find((f) => f.special === '\\Sent');
        if (sent) return idle.resyncFolder(uid, accountId, sent.path);
      })
      .catch(() => { /* 下次访问兜底 */ });
  } catch { /* 缓存回写失败不影响发信结果 */ }
}

// 搜索前保证索引可用：只补「从没同步过」的文件夹，已有索引的不重复拉。
// 冷启动大邮箱可能很久，给 20 秒预算，超了就返回 partial，让 agent 提示用户稍后再搜
const INDEX_BUDGET_MS = 20000;

async function ensureIndexed(uid, acc, onlyFolder = null) {
  if (cache.hasAccountData(uid, acc.id)) {
    // 已有索引：只在指定了文件夹且该夹从没同步过时补一次
    if (!onlyFolder) return 'ok';
    if (cache.getPage(uid, acc.id, onlyFolder, { page: 1, pageSize: 1 })) return 'ok';
    try { await idle.resyncFolder(uid, acc.id, onlyFolder); return 'ok'; } catch { return 'partial'; }
  }
  let folders = await listFolders(uid, acc.id);
  if (onlyFolder) folders = folders.filter((f) => f.path === onlyFolder);
  const started = Date.now();
  let partial = false;
  for (const f of folders) {
    if (cache.getPage(uid, acc.id, f.path, { page: 1, pageSize: 1 })) continue;
    if (Date.now() - started > INDEX_BUDGET_MS) { partial = true; break; }
    try {
      await idle.resyncFolder(uid, acc.id, f.path);
    } catch { partial = true; }
  }
  return partial ? 'partial' : 'ok';
}

// 统一包装：scope 拦截 → 执行 → 异常转人话。任何工具都不允许绕过这一层。
function define(server, ctx, def) {
  server.registerTool(
    def.name,
    { title: def.title, description: def.description, inputSchema: def.schema, annotations: def.annotations },
    async (args) => {
      if (!ctx.scopes.includes(def.scope)) {
        return fail(`当前令牌没有「${SCOPE_TEXT[def.scope]}」权限，请在网页端「设置 → Agent 接入」里给令牌勾上这个权限`);
      }
      try {
        return await def.run(args || {});
      } catch (e) {
        return fail(humanError(e));
      }
    },
  );
}

export function registerTools(server, ctx) {
  const uid = ctx.uid;

  // ---------- 只读 ----------
  define(server, ctx, {
    name: 'list_accounts',
    scope: 'read',
    title: '列出邮箱账号',
    description: '列出当前账号下已配置的邮箱（含各文件夹未读数）。其它工具里的 account 参数可以填这里的 id、邮箱地址或显示名。',
    annotations: { readOnlyHint: true },
    schema: {},
    run: async () => {
      const all = listAccounts(uid);
      if (!all.length) {
        // 空列表不当作错误（agent 可能只是想探一下），但要明确告诉它下一步该干什么
        return json({ accounts: [], hint: '当前还没有添加任何邮箱账号，请先在 MailNest 网页端「设置 → 邮箱账号」里添加一个' });
      }
      const out = [];
      for (const a of all) {
        let unread = 0;
        try {
          const counts = await unseenCounts(uid, a.id);
          unread = Object.values(counts).reduce((s, n) => s + (Number(n) || 0), 0);
        } catch { /* 单个账号连不上不影响整体列表 */ }
        out.push({ id: a.id, email: a.email, name: a.displayName, unread });
      }
      return json({ accounts: out });
    },
  });

  define(server, ctx, {
    name: 'list_folders',
    scope: 'read',
    title: '列出文件夹',
    description: '列出某个邮箱账号的文件夹（收件箱、已发送、垃圾箱、自定义文件夹），带各文件夹未读数。',
    annotations: { readOnlyHint: true },
    schema: { account: z.string().optional().describe('账号 id 或邮箱地址；只有一个账号时可省略') },
    run: async ({ account }) => {
      const acc = resolveAccount(uid, account);
      const folders = await listFolders(uid, acc.id);
      let counts = {};
      try { counts = await unseenCounts(uid, acc.id); } catch { /* 未读数拿不到不算失败 */ }
      return json({
        account: { id: acc.id, email: acc.email, name: acc.displayName },
        folders: folders.map((f) => ({ ...f, unread: Number(counts[f.path]) || 0 })),
      });
    },
  });

  define(server, ctx, {
    name: 'list_messages',
    scope: 'read',
    title: '列出邮件',
    description: '按时间倒序分页列出某文件夹的邮件摘要（发件人、主题、时间、已读/星标），不含正文。要看正文再用 read_message；'
      + '只关心未读时传 unreadOnly=true，不用翻整夹去找。',
    annotations: { readOnlyHint: true },
    schema: {
      account: z.string().optional().describe('账号 id 或邮箱地址'),
      folder: z.string().optional().describe('文件夹路径，默认 INBOX'),
      page: z.coerce.number().int().min(1).optional().describe('页码，从 1 开始'),
      pageSize: z.coerce.number().int().min(1).max(PAGE_MAX).optional().describe(`每页条数，最多 ${PAGE_MAX}，默认 20`),
      unreadOnly: z.boolean().optional().describe('只列未读邮件（默认 false 列全部）'),
    },
    run: async ({ account, folder, page, pageSize, unreadOnly }) => {
      const acc = resolveAccount(uid, account);
      const dir = normFolder(folder);
      const d = await listMessages(uid, acc.id, dir, { page: page || 1, pageSize: pageSize || 20, unreadOnly: !!unreadOnly });
      return json({
        account: { id: acc.id, email: acc.email },
        folder: dir,
        total: d.total,
        page: d.page,
        pageSize: d.pageSize,
        messages: d.messages.map((m) => ({
          uid: m.uid,
          from: m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address,
          subject: m.subject,
          date: m.date,
          unread: !m.flags.includes('\\Seen'),
          starred: m.flags.includes('\\Flagged'),
          hasAttachment: m.hasAttachment,
        })),
      });
    },
  });

  define(server, ctx, {
    name: 'search_messages',
    scope: 'read',
    title: '搜索邮件',
    description: '按关键词搜索邮件（主题、发件人、收件人、以及已读过的正文）。比逐页翻 list_messages 快得多；'
      + '搜索走 MailNest 的本地索引，首次搜索会先建索引（大邮箱可能要几秒）。不传 account 时搜索所有账号。',
    annotations: { readOnlyHint: true },
    schema: {
      query: z.string().min(1).max(200).describe('关键词，例如「发票」或「noreply@github.com」'),
      account: z.string().optional().describe('账号 id 或邮箱地址；省略则搜索全部账号'),
      folder: z.string().optional().describe('只搜某个文件夹（路径从 list_folders 拿）；省略则搜所有文件夹'),
      limit: z.coerce.number().int().min(1).max(50).optional().describe('最多返回多少封，默认 20'),
    },
    run: async ({ query, account, folder, limit }) => {
      const q = String(query).trim();
      const all = listAccounts(uid);
      if (!all.length) throw new Error('还没有添加任何邮箱账号，请先在 MailNest 网页端添加一个');
      const targets = account ? [resolveAccount(uid, account)] : all;
      const dir = folder ? String(folder).trim() : null;
      const cap = Math.min(Math.max(1, limit || 20), 50);

      const hits = [];
      let indexing = false;
      for (const acc of targets) {
        if (dir) {
          const folders = await listFolders(uid, acc.id);
          if (!folders.some((f) => f.path === dir)) {
            throw new Error(`「${acc.email}」没有名为「${dir}」的文件夹，可用：${folders.slice(0, 12).map((f) => f.path).join('、')}`);
          }
        }
        if (await ensureIndexed(uid, acc, dir) === 'partial') indexing = true;
        for (const m of cache.searchMessages(uid, acc.id, q, { folder: dir, limit: cap })) {
          hits.push({ acc, ...m });
        }
      }
      hits.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      const shown = hits.slice(0, cap);

      if (!shown.length) {
        const hint = indexing ? '\n提示：该账号正在首次建立索引，等几秒后再搜一次可能会有结果。'
          : '\n提示：正文只搜索已打开过（已缓存）的邮件；也可以换更短的关键词，或用 list_messages 逐页查看。';
        return text(`没搜到和「${q}」相关的邮件${dir ? `（范围：${dir}）` : ''}。${hint}`);
      }
      const lines = shown.map((m, i) => {
        const from = m.from?.name ? `${m.from.name} <${m.from.address}>` : (m.from?.address || '未知');
        const who = targets.length > 1 ? `${m.acc.email} / ` : '';
        const head = `${i + 1}. [${who}${m.folder}] ${m.subject} — ${from} · ${m.date || '未知时间'} · uid=${m.uid}`
          + `${m.flags.includes('\\Seen') ? '' : ' · 未读'}${m.hasAttachment ? ' · 有附件' : ''}`;
        return m.snippet ? `${head}\n   命中正文：${m.snippet}` : head;
      });
      const tail = shown.length >= cap ? `\n\n（只显示前 ${cap} 封，可用 limit 或 folder 缩小范围）` : '';
      return text(`搜到 ${shown.length} 封和「${q}」相关的邮件：\n\n${lines.join('\n')}${tail}`);
    },
  });

  define(server, ctx, {
    name: 'read_message',
    scope: 'read',
    title: '读取邮件正文',
    description: `读取一封邮件的正文（纯文本）和基础信头。正文超过 ${BODY_LIMIT} 字会截断并标注；`
      + '附件只列清单（带编号），要看附件内容用 read_attachment。信头里的认证结果可用于判断钓鱼邮件。',
    annotations: { readOnlyHint: true },
    schema: {
      account: z.string().optional().describe('账号 id 或邮箱地址'),
      folder: z.string().optional().describe('邮件所在文件夹，默认 INBOX'),
      uid: z.coerce.number().int().positive().describe('邮件的 uid，从 list_messages 拿'),
    },
    run: async ({ account, folder, uid: msgUid }) => {
      const acc = resolveAccount(uid, account);
      const dir = normFolder(folder);
      const m = await getMessage(uid, acc.id, dir, String(msgUid));
      let body = String(m.text || '').trim();
      if (!body && m.html) body = htmlToText(m.html);
      const truncated = body.length > BODY_LIMIT;
      if (truncated) body = body.slice(0, BODY_LIMIT);

      const head = [
        `主题：${m.subject}`,
        `发件人：${m.from?.name ? `${m.from.name} <${m.from.address}>` : (m.from?.address || m.from?.text || '未知')}`,
        `收件人：${(m.to || []).map((t) => t.address).filter(Boolean).join(', ') || '(无)'}`,
        m.cc?.length ? `抄送：${m.cc.map((t) => t.address).filter(Boolean).join(', ')}` : '',
        `时间：${m.date || '未知'}`,
        m.replyTo?.address && m.replyTo.address !== m.from?.address
          ? `回信地址：${m.replyTo.address}（⚠ 与发件人不一致，回复会寄到第三方，谨防钓鱼）` : '',
        m.returnPath ? `Return-Path：${m.returnPath}` : '',
        m.authResults ? `认证结果：${String(m.authResults).slice(0, 300)}` : '',
        m.attachments?.length
          ? `附件：${m.attachments.map((a, i) => `#${i + 1} ${a.filename}（${Math.round(a.size / 1024)} KB）`).join('、')}`
          : '附件：无',
      ].filter(Boolean).join('\n');

      return text(`${head}\n\n${body || '(这封邮件没有可显示的正文)'}${truncated ? `\n\n[正文已截断，只显示了前 ${BODY_LIMIT} 字]` : ''}`);
    },
  });

  define(server, ctx, {
    name: 'read_attachment',
    scope: 'read',
    title: '读取附件内容',
    description: '读取一封邮件里某个附件的内容。文本类附件（txt/csv/json/html 等）直接返回文本；'
      + '小体积二进制（如 PDF）返回 base64；过大的二进制只报大小，请让用户到网页端下载。',
    annotations: { readOnlyHint: true },
    schema: {
      account: z.string().optional().describe('账号 id 或邮箱地址'),
      folder: z.string().optional().describe('邮件所在文件夹，默认 INBOX'),
      uid: z.coerce.number().int().positive().describe('邮件的 uid'),
      index: z.coerce.number().int().min(1).max(50).describe('第几个附件（从 1 开始，编号见 read_message 的附件清单）'),
    },
    run: async ({ account, folder, uid: msgUid, index }) => {
      const acc = resolveAccount(uid, account);
      const dir = normFolder(folder);
      const att = await getAttachment(uid, acc.id, dir, String(msgUid), index - 1);
      const kb = Math.round((att.content?.length || 0) / 102.4) / 10;
      if (isTextLike(att.contentType, att.filename)) {
        let txt = att.content.toString('utf8').replace(/^\uFEFF/, '');
        const cut = txt.length > ATT_TEXT_LIMIT;
        if (cut) txt = txt.slice(0, ATT_TEXT_LIMIT);
        return text(`附件：${att.filename}（${kb} KB，${att.contentType}）\n\n${txt}${cut ? `\n\n[文本已截断，只显示前 ${ATT_TEXT_LIMIT} 字]` : ''}`);
      }
      if ((att.content?.length || 0) > ATT_B64_LIMIT) {
        return text(`附件「${att.filename}」是二进制文件（${att.contentType}，${kb} KB），体积超出可直接传输的上限。`
          + `请让用户在 MailNest 网页端打开这封邮件直接下载。`);
      }
      const b64 = att.content.toString('base64');
      return text(`附件：${att.filename}（${kb} KB，${att.contentType}）\n以下为文件完整内容的 base64 编码（自行解码后即为原文件）：\n\n${b64}`);
    },
  });

  // ---------- 整理 ----------
  define(server, ctx, {
    name: 'set_flags',
    scope: 'write',
    title: '标记已读 / 未读 / 星标',
    description: '批量设置邮件的已读、未读、星标状态。',
    annotations: { readOnlyHint: false, destructiveHint: false },
    schema: {
      account: z.string().optional().describe('账号 id 或邮箱地址'),
      folder: z.string().optional().describe('邮件所在文件夹，默认 INBOX'),
      uids: z.array(z.coerce.number().int().positive()).min(1).describe('邮件 uid 列表'),
      action: z.enum(['read', 'unread', 'star', 'unstar']).describe('read=标为已读，unread=标为未读，star=加星标，unstar=取消星标'),
    },
    run: async ({ account, folder, uids, action }) => {
      const acc = resolveAccount(uid, account);
      const dir = normFolder(folder);
      const list = normUids(uids);
      const map = {
        read: { add: ['\\Seen'] },
        unread: { remove: ['\\Seen'] },
        star: { add: ['\\Flagged'] },
        unstar: { remove: ['\\Flagged'] },
      };
      await setFlags(uid, acc.id, dir, list, map[action]);
      // 缓存回写：MCP 改了旗标，网页端读缓存不能再看到旧状态
      try { cache.updateFlags(uid, acc.id, dir, list, map[action]); } catch { /* 缓存回写失败不影响主流程 */ }
      const label = { read: '标为已读', unread: '标为未读', star: '加星标', unstar: '取消星标' }[action];
      return text(`已把 ${list.length} 封邮件${label}（${acc.email} / ${dir}）。`);
    },
  });

  define(server, ctx, {
    name: 'move_messages',
    scope: 'write',
    title: '移动邮件',
    description: '把邮件移动到同账号的另一个文件夹。目标文件夹路径可从 list_folders 获取。',
    annotations: { readOnlyHint: false, destructiveHint: false },
    schema: {
      account: z.string().optional().describe('账号 id 或邮箱地址'),
      folder: z.string().optional().describe('邮件当前所在文件夹，默认 INBOX'),
      uids: z.array(z.coerce.number().int().positive()).min(1).describe('邮件 uid 列表'),
      dest: z.string().min(1).describe('目标文件夹路径，例如 Archive 或 项目/2026'),
    },
    run: async ({ account, folder, uids, dest }) => {
      const acc = resolveAccount(uid, account);
      const dir = normFolder(folder);
      const list = normUids(uids);
      const target = String(dest).trim();
      await moveMessages(uid, acc.id, dir, list, target);
      // 缓存回写：源夹摘除；目的夹 UID 由服务器重新分配，推算不了，异步重同步
      try {
        cache.moveUids(uid, acc.id, dir, list);
        idle.resyncFolder(uid, acc.id, target).catch(() => { /* 下次访问兜底 */ });
      } catch { /* 缓存回写失败不影响主流程 */ }
      return text(`已把 ${list.length} 封邮件从「${dir}」移动到「${target}」（${acc.email}）。`);
    },
  });

  define(server, ctx, {
    name: 'delete_messages',
    scope: 'write',
    title: '删除邮件（进垃圾箱）',
    description: '把邮件移到「已删除」文件夹。已在「已删除」里的邮件不会被永久删除 —— 这一步只能由用户在网页端手动执行。',
    annotations: { readOnlyHint: false, destructiveHint: true },
    schema: {
      account: z.string().optional().describe('账号 id 或邮箱地址'),
      folder: z.string().optional().describe('邮件当前所在文件夹，默认 INBOX'),
      uids: z.array(z.coerce.number().int().positive()).min(1).describe('邮件 uid 列表'),
    },
    run: async ({ account, folder, uids }) => {
      const acc = resolveAccount(uid, account);
      const dir = normFolder(folder);
      const list = normUids(uids);
      const folders = await listFolders(uid, acc.id);
      const trash = folders.find((f) => f.special === '\\Trash');
      if (!trash) throw new Error(`「${acc.email}」没有「已删除」文件夹，无法安全地删除邮件`);
      if (dir === trash.path) {
        throw new Error('这些邮件已经在「已删除」里了。为避免误删，Agent 不执行永久删除，请让用户到网页端手动清空');
      }
      await moveMessages(uid, acc.id, dir, list, trash.path);
      // 缓存回写（同 move_messages）：源夹摘除，垃圾箱异步重同步
      try {
        cache.moveUids(uid, acc.id, dir, list);
        idle.resyncFolder(uid, acc.id, trash.path).catch(() => { /* 下次访问兜底 */ });
      } catch { /* 缓存回写失败不影响主流程 */ }
      return text(`已把 ${list.length} 封邮件移到「${trash.path}」（${acc.email}），可在网页端恢复或清空。`);
    },
  });

  define(server, ctx, {
    name: 'mark_all_read',
    scope: 'write',
    title: '全部标为已读',
    description: '把整个文件夹的所有邮件一次性标为已读（服务端一条命令完成，几千封也很快）。单个/少量邮件请用 set_flags。',
    annotations: { readOnlyHint: false, destructiveHint: false },
    schema: {
      account: z.string().optional().describe('账号 id 或邮箱地址'),
      folder: z.string().optional().describe('文件夹路径，默认 INBOX'),
    },
    run: async ({ account, folder }) => {
      const acc = resolveAccount(uid, account);
      const dir = normFolder(folder);
      await markAllRead(uid, acc.id, dir);
      try { cache.addFlagToAll(uid, acc.id, dir, '\\Seen'); } catch { /* 缓存回写失败不影响主流程 */ }
      return text(`已把「${acc.email} / ${dir}」的全部邮件标为已读。`);
    },
  });

  define(server, ctx, {
    name: 'empty_folder',
    scope: 'write',
    title: '清空垃圾箱类文件夹',
    description: '永久删除某文件夹里的全部邮件（IMAP \\\\Deleted + EXPUNGE，不可恢复）。'
      + '只允许对垃圾箱/垃圾邮件类文件夹执行；普通文件夹请用 delete_messages 先移入垃圾箱。',
    annotations: { readOnlyHint: false, destructiveHint: true },
    schema: {
      account: z.string().optional().describe('账号 id 或邮箱地址'),
      folder: z.string().min(1).describe('要清空的文件夹路径（须为垃圾箱/垃圾邮件类）'),
    },
    run: async ({ account, folder }) => {
      const acc = resolveAccount(uid, account);
      const dir = String(folder || '').trim();
      const folders = await listFolders(uid, acc.id);
      const node = folders.find((f) => f.path === dir);
      if (!node) {
        throw new Error(`「${acc.email}」没有名为「${dir}」的文件夹，可用：${folders.slice(0, 12).map((f) => f.path).join('、')}`);
      }
      const trashy = node.special === '\\Trash' || node.special === '\\Junk'
        || /trash|junk|spam|deleted|垃圾|已删除/i.test(dir);
      if (!trashy) {
        throw new Error(`「${dir}」不是垃圾箱类文件夹，不允许一键清空（永久删除不可恢复）。`
          + `普通文件夹的邮件请用 delete_messages 移入垃圾箱`);
      }
      await emptyFolder(uid, acc.id, dir);
      try { cache.clearFolder(uid, acc.id, dir); } catch { /* 缓存回写失败不影响主流程 */ }
      return text(`已永久清空「${acc.email} / ${dir}」（共不可恢复）。`);
    },
  });

  define(server, ctx, {
    name: 'delete_folder',
    scope: 'write',
    title: '删除文件夹',
    description: '删除一个自定义文件夹及其中的全部邮件（不可恢复）。收件箱和系统文件夹（已发送/垃圾箱等）不允许删除。',
    annotations: { readOnlyHint: false, destructiveHint: true },
    schema: {
      account: z.string().optional().describe('账号 id 或邮箱地址'),
      path: z.string().min(1).max(100).describe('要删除的文件夹路径'),
    },
    run: async ({ account, path }) => {
      const acc = resolveAccount(uid, account);
      const p = String(path || '').trim();
      await deleteFolder(uid, acc.id, p); // 内部已拦 INBOX 与系统文件夹
      try { cache.dropFolder(uid, acc.id, p); } catch { /* 缓存回写失败不影响主流程 */ }
      return text(`已删除「${acc.email}」下的文件夹「${p}」及其全部邮件。`);
    },
  });

  define(server, ctx, {
    name: 'create_folder',
    scope: 'write',
    title: '新建文件夹',
    description: '在某个账号下新建文件夹。多级文件夹用该账号的分隔符（通常「/」）连接，例如「项目/2026」。',
    annotations: { readOnlyHint: false, destructiveHint: false },
    schema: {
      account: z.string().optional().describe('账号 id 或邮箱地址'),
      path: z.string().min(1).max(100).describe('文件夹路径，例如 待办 或 项目/2026'),
    },
    run: async ({ account, path }) => {
      const acc = resolveAccount(uid, account);
      const p = String(path).trim();
      if (/[\u0000-\u001f]/.test(p)) throw new Error('文件夹名称含非法字符');
      if (/^\/|\/$/.test(p) || p.includes('//')) throw new Error('文件夹名称不能以分隔符开头或结尾');
      await createFolder(uid, acc.id, p);
      return text(`已在「${acc.email}」下新建文件夹「${p}」。`);
    },
  });

  // ---------- 发信 ----------
  define(server, ctx, {
    name: 'send_message',
    scope: 'send',
    title: '发送新邮件',
    description: '用指定账号发送一封新邮件，可带附件。发送前请把收件人、主题、正文（和附件清单）完整展示给用户确认。',
    annotations: { readOnlyHint: false, destructiveHint: true },
    schema: {
      account: z.string().optional().describe('用哪个账号发；只有一个账号时可省略'),
      to: z.array(z.string()).min(1).describe('收件人邮箱地址列表'),
      cc: z.array(z.string()).optional().describe('抄送地址列表'),
      bcc: z.array(z.string()).optional().describe('密送地址列表'),
      subject: z.string().describe('邮件主题'),
      text: z.string().min(1).describe('邮件正文（纯文本）'),
      attachments: attachSchema,
    },
    run: async ({ account, to, cc, bcc, subject, text: body, attachments }) => {
      const acc = resolveAccount(uid, account);
      checkAttachSize(attachments);
      const result = await sendMail(uid, acc, { to, cc: cc || [], bcc: bcc || [], subject, text: body, attachments });
      syncSentCache(uid, acc.id);
      const rejected = (result.rejected || []).filter(Boolean);
      const attNote = attachments?.length ? `，含 ${attachments.length} 个附件` : '';
      return text(`已通过「${acc.email}」发送给 ${to.join(', ')}${attNote}。${rejected.length ? `\n被拒收：${rejected.join(', ')}` : ''}`);
    },
  });

  define(server, ctx, {
    name: 'forward_message',
    scope: 'send',
    title: '转发邮件',
    description: '把一封已有邮件（含全部附件）转发给别人。原邮件以引用块形式附在正文前。',
    annotations: { readOnlyHint: false, destructiveHint: true },
    schema: {
      account: z.string().optional().describe('账号 id 或邮箱地址'),
      folder: z.string().optional().describe('原邮件所在文件夹，默认 INBOX'),
      uid: z.coerce.number().int().positive().describe('原邮件的 uid'),
      to: z.array(z.string()).min(1).describe('转发给谁（邮箱地址列表）'),
      cc: z.array(z.string()).optional().describe('抄送地址列表'),
      text: z.string().optional().describe('转发时附上的说明文字（可省略）'),
    },
    run: async ({ account, folder, uid: msgUid, to, cc, text: note }) => {
      const acc = resolveAccount(uid, account);
      const dir = normFolder(folder);
      const orig = await getMessage(uid, acc.id, dir, String(msgUid));
      // 附件逐个取回（本地缓存命中就是磁盘读），超 20MB 拒发
      const attachments = [];
      let bytes = 0;
      for (let i = 0; i < (orig.attachments || []).length; i++) {
        const att = await getAttachment(uid, acc.id, dir, String(msgUid), i);
        bytes += att.content?.length || 0;
        if (bytes > SEND_ATTACH_BYTES) throw new Error('原邮件附件总体积超过 20MB，转发被拒；请让用户在网页端手动操作');
        attachments.push({ filename: att.filename, contentType: att.contentType, content: att.content.toString('base64') });
      }
      const quote = [
        '---------- 转发的邮件 ----------',
        `发件人：${orig.from?.text || orig.from?.address || '未知'}`,
        `主题：${orig.subject}`,
        `时间：${orig.date || '未知'}`,
        orig.attachments?.length ? `附件：${orig.attachments.map((a) => a.filename).join('、')}` : '',
        '',
        htmlToText(orig.text ? '' : (orig.html || '')) || orig.text || '(无正文)',
      ].filter((l) => l !== undefined).join('\n');
      const subject = /^fwd:\s*/i.test(orig.subject) ? orig.subject : `Fwd: ${orig.subject}`;
      const body = `${note ? `${note}\n\n` : ''}${quote}`;
      await sendMail(uid, acc, { to, cc: cc || [], subject, text: body, attachments });
      syncSentCache(uid, acc.id);
      return text(`已把「${orig.subject}」转发给 ${to.join(', ')}` +
        `${attachments.length ? `（含 ${attachments.length} 个附件）` : ''}。`);
    },
  });

  define(server, ctx, {
    name: 'reply_message',
    scope: 'send',
    title: '回复邮件',
    description: '回复一封已有邮件，自动带上原邮件的主题、In-Reply-To 和 References，保证邮件客户端里能正确归档到同一会话。',
    annotations: { readOnlyHint: false, destructiveHint: true },
    schema: {
      account: z.string().optional().describe('账号 id 或邮箱地址'),
      folder: z.string().optional().describe('原邮件所在文件夹，默认 INBOX'),
      uid: z.coerce.number().int().positive().describe('原邮件的 uid'),
      text: z.string().min(1).describe('回复正文（纯文本）'),
      replyAll: z.boolean().optional().describe('是否回复全部（含原邮件抄送人），默认 false'),
      attachments: attachSchema,
    },
    run: async ({ account, folder, uid: msgUid, text: body, replyAll, attachments }) => {
      const acc = resolveAccount(uid, account);
      const dir = normFolder(folder);
      const orig = await getMessage(uid, acc.id, dir, String(msgUid));
      const to = orig.from?.address || orig.from?.text || '';
      if (!to) throw new Error('这封邮件没有可回复的发件人地址');
      const cc = replyAll ? (orig.cc || []).map((t) => t.address).filter(Boolean) : [];
      const refs = Array.isArray(orig.references) ? orig.references : (orig.references ? [orig.references] : []);
      const references = [...refs, orig.messageId].filter(Boolean).join(' ');
      const subject = /^re:\s*/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`;
      checkAttachSize(attachments);
      await sendMail(uid, acc, {
        to: [to], cc, subject, text: body, attachments,
        inReplyTo: orig.messageId || undefined,
        references: references || undefined,
      });
      syncSentCache(uid, acc.id);
      return text(`已回复「${orig.subject}」（发给 ${to}${cc.length ? `，抄送 ${cc.join(', ')}` : ''}）。`);
    },
  });

  define(server, ctx, {
    name: 'save_draft',
    scope: 'send',
    title: '保存草稿',
    description: '把一封没写完的邮件存成草稿，用户可在网页端继续编辑或直接发送。',
    annotations: { readOnlyHint: false, destructiveHint: false },
    schema: {
      account: z.string().optional().describe('用哪个账号保存'),
      to: z.array(z.string()).optional().describe('收件人'),
      subject: z.string().optional().describe('主题'),
      text: z.string().min(1).describe('正文'),
    },
    run: async ({ account, to, subject, text: body }) => {
      // 草稿允许在没配账号时先存下来（发送时再校验账号），所以这里不能直接 resolveAccount
      const all = listAccounts(uid);
      let accId = '';
      if (account) accId = resolveAccount(uid, account).id;
      else if (all.length === 1) accId = all[0].id;
      else if (all.length > 1) throw new Error(`有 ${all.length} 个账号，请用 account 指定保存到哪个：${all.map((a) => a.email).join('、')}`);
      const d = saveDraft(uid, {
        accountId: accId,
        to: Array.isArray(to) ? to.join(', ') : (to || ''),
        subject: subject || '(无主题)',
        text: body,
      });
      return text(`已保存草稿（草稿 id ${d.id}），可在网页端「草稿」里继续编辑，或用 send_draft 发送。`);
    },
  });

  define(server, ctx, {
    name: 'list_drafts',
    scope: 'read',
    title: '列出草稿',
    description: '列出所有没发出去的草稿（含 id、账号、收件人、主题）。草稿存在 MailNest 本地，不占邮箱服务器的 Drafts。',
    annotations: { readOnlyHint: true },
    schema: {},
    run: async () => {
      const drafts = listDrafts(uid);
      if (!drafts.length) return text('当前没有草稿。');
      const lines = drafts.map((d) => {
        const acc = listAccounts(uid).find((a) => a.id === d.accountId);
        const who = acc?.email || (d.accountId ? '账号已删除' : '未指定账号');
        return `- id=${d.id}（${who}）→ ${(d.to || '(无收件人)')}「${d.subject}」，正文 ${String(d.text || '').length} 字`;
      });
      return text(`共 ${drafts.length} 份草稿：\n${lines.join('\n')}\n\n继续编辑请在网页端「草稿」操作；直接发送用 send_draft。`);
    },
  });

  define(server, ctx, {
    name: 'send_draft',
    scope: 'send',
    title: '发送草稿',
    description: '把一份已有草稿直接发出去（按草稿里存的收件人/主题/正文），发送成功后草稿自动删除。',
    annotations: { readOnlyHint: false, destructiveHint: true },
    schema: {
      draftId: z.string().min(1).describe('草稿 id，从 list_drafts 拿'),
    },
    run: async ({ draftId }) => {
      const id = String(draftId || '').trim();
      const d = listDrafts(uid).find((x) => x.id === id);
      if (!d) throw new Error(`找不到草稿「${id}」，可用 list_drafts 查看现有草稿`);
      const acc = listAccounts(uid).find((a) => a.id === d.accountId);
      if (!acc) throw new Error('这份草稿对应的邮箱账号已被删除，无法发送');
      const to = String(d.to || '').split(/[,;，；]/).map((s) => s.trim()).filter(Boolean);
      if (!to.length) throw new Error('这份草稿没有收件人，请让用户在网页端补上后再发');
      await sendMail(uid, acc, { to, subject: d.subject || '(无主题)', text: d.text });
      deleteDraft(uid, id);
      syncSentCache(uid, acc.id);
      return text(`草稿「${d.subject}」已通过「${acc.email}」发送给 ${to.join(', ')}，草稿已删除。`);
    },
  });

  define(server, ctx, {
    name: 'delete_draft',
    scope: 'send',
    title: '删除草稿',
    description: '删除一份草稿（只是 MailNest 本地的草稿，不影响服务器）。',
    annotations: { readOnlyHint: false, destructiveHint: true },
    schema: {
      draftId: z.string().min(1).describe('草稿 id，从 list_drafts 拿'),
    },
    run: async ({ draftId }) => {
      const id = String(draftId || '').trim();
      if (!listDrafts(uid).some((x) => x.id === id)) {
        throw new Error(`找不到草稿「${id}」，可用 list_drafts 查看现有草稿`);
      }
      deleteDraft(uid, id);
      return text(`已删除草稿「${id}」。`);
    },
  });
}

export const TOOL_COUNT = 20;
