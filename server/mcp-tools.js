// MCP 工具层：11 个工具全部是对 mail.js / store.js 现有函数的映射，不引入新的业务逻辑。
// 三条硬约束：
//  1. 每个工具先过 scope 检查，令牌没给的权限一律拒绝（不是靠工具不注册，而是靠显式拒绝给出可读理由）
//  2. 所有入参都按「这个用户自己的账号」解析，findAccount/listAccounts 天然按 uid 隔离
//  3. 错误信息给人话，不抛内部路径、类名、IMAP 原始响应
import { z } from 'zod';
import { listAccounts, findAccount } from './store.js';
import {
  listFolders, listMessages, getMessage, setFlags, moveMessages,
  createFolder, sendMail, saveDraft, unseenCounts,
} from './mail.js';
import * as cache from './cache.js';
import * as idle from './idle.js';

const BODY_LIMIT = 8000;   // 正文字符上限：再长会一次性灌满模型上下文
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
    description: '按时间倒序分页列出某文件夹的邮件摘要（发件人、主题、时间、已读/星标），不含正文。要看正文再用 read_message。',
    annotations: { readOnlyHint: true },
    schema: {
      account: z.string().optional().describe('账号 id 或邮箱地址'),
      folder: z.string().optional().describe('文件夹路径，默认 INBOX'),
      page: z.coerce.number().int().min(1).optional().describe('页码，从 1 开始'),
      pageSize: z.coerce.number().int().min(1).max(PAGE_MAX).optional().describe(`每页条数，最多 ${PAGE_MAX}，默认 20`),
    },
    run: async ({ account, folder, page, pageSize }) => {
      const acc = resolveAccount(uid, account);
      const dir = normFolder(folder);
      const d = await listMessages(uid, acc.id, dir, { page: page || 1, pageSize: pageSize || 20 });
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
    name: 'read_message',
    scope: 'read',
    title: '读取邮件正文',
    description: `读取一封邮件的正文（纯文本）。正文超过 ${BODY_LIMIT} 字会截断并标注；附件只列文件名，不返回内容。`,
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
        m.attachments?.length ? `附件：${m.attachments.map((a) => `${a.filename}（${Math.round(a.size / 1024)} KB）`).join('、')}` : '附件：无',
      ].filter(Boolean).join('\n');

      return text(`${head}\n\n${body || '(这封邮件没有可显示的正文)'}${truncated ? `\n\n[正文已截断，只显示了前 ${BODY_LIMIT} 字]` : ''}`);
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
    description: '用指定账号发送一封新邮件。纯文本正文。发送前请把收件人、主题、正文完整展示给用户确认。',
    annotations: { readOnlyHint: false, destructiveHint: true },
    schema: {
      account: z.string().optional().describe('用哪个账号发；只有一个账号时可省略'),
      to: z.array(z.string()).min(1).describe('收件人邮箱地址列表'),
      cc: z.array(z.string()).optional().describe('抄送地址列表'),
      subject: z.string().describe('邮件主题'),
      text: z.string().min(1).describe('邮件正文（纯文本）'),
    },
    run: async ({ account, to, cc, subject, text: body }) => {
      const acc = resolveAccount(uid, account);
      const result = await sendMail(uid, acc, { to, cc: cc || [], subject, text: body });
      syncSentCache(uid, acc.id);
      const rejected = (result.rejected || []).filter(Boolean);
      return text(`已通过「${acc.email}」发送给 ${to.join(', ')}。${rejected.length ? `\n被拒收：${rejected.join(', ')}` : ''}`);
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
    },
    run: async ({ account, folder, uid: msgUid, text: body, replyAll }) => {
      const acc = resolveAccount(uid, account);
      const dir = normFolder(folder);
      const orig = await getMessage(uid, acc.id, dir, String(msgUid));
      const to = orig.from?.address || orig.from?.text || '';
      if (!to) throw new Error('这封邮件没有可回复的发件人地址');
      const cc = replyAll ? (orig.cc || []).map((t) => t.address).filter(Boolean) : [];
      const refs = Array.isArray(orig.references) ? orig.references : (orig.references ? [orig.references] : []);
      const references = [...refs, orig.messageId].filter(Boolean).join(' ');
      const subject = /^re:\s*/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`;
      await sendMail(uid, acc, {
        to: [to], cc, subject, text: body,
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
      const acc = resolveAccount(uid, account);
      const d = saveDraft(uid, {
        accountId: acc.id,
        to: Array.isArray(to) ? to.join(', ') : (to || ''),
        subject: subject || '(无主题)',
        text: body,
      });
      return text(`已保存草稿${d?.id ? `（草稿 id ${d.id}）` : ''}，可在网页端「草稿」里继续编辑。`);
    },
  });
}

export const TOOL_COUNT = 11;
