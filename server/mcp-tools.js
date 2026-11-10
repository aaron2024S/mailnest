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
import { htmlToText, bodyTextOf } from './htmltext.js';
import { zonedMidnight, zonedNow, fmtZoned, tzName } from './tz.js';

const BODY_LIMIT = 8000;        // 正文字符上限：再长会一次性灌满模型上下文
const ATT_TEXT_LIMIT = 20000;   // 附件文本上限
const ATT_B64_LIMIT = 200_000;  // 二进制附件转 base64 的上限（原始字节数）
const SEND_ATTACH_MAX = 20;     // 单封信附件上限（与 sendMail 一致）
const SEND_ATTACH_BYTES = 20 * 1024 * 1024; // 发信附件总大小上限（解码后）
const MAX_UIDS = 200;      // 单次批量操作上限：防止 agent 误传一整页
const PAGE_MAX = 50;

const SCOPE_TEXT = { read: '读取邮件', write: '整理邮件', send: '发送邮件' };

// ---- 入参宽容层 ----------------------------------------------------------
// 模型的 function calling 输出不由我们控制，这几种错法都真实发生过：
//   · {"account": null}      —— 想表达「不指定」，结果是 400 expected string, received null
//   · {"to": "a@b.com"}      —— 该给数组却给了字符串
//   · {"uids": "12,15"}      —— 该给数组却给了逗号串
// 语义清清楚楚，只是形状不对。这一层负责把「意思同、形状异」的入参掰正，
// 掰不动的才报错——把 400 原样丢给用户，是最不该发生的一类失败。
const optStr = () => z.preprocess((v) => {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim().replace(/^["'「『]+|["'」』]+$/g, '').trim();
  return s === '' ? undefined : s;
}, z.string().optional());

const splitList = (v) => (Array.isArray(v) ? v : String(v).split(/[,，;；、\s]+/))
  .map((x) => String(x).trim()).filter(Boolean);

const addrList = (required) => z.preprocess((v) => {
  if (v === null || v === undefined) return undefined;
  const list = splitList(v);
  return list.length ? list : undefined;
}, required ? z.array(z.string()).min(1) : z.array(z.string()).optional());

const uidList = () => z.preprocess((v) => {
  if (v === null || v === undefined) return undefined;
  const list = (Array.isArray(v) ? v : String(v).split(/[,，;；、\s]+/))
    .map((x) => Number(String(x).trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return list.length ? list : undefined;
}, z.array(z.number().int().positive()).min(1));

// 时间过滤：既收具体日期，也收相对说法。用户嘴里是「上个月」「去年 10 月」，
// 而这一层原来只能传关键词——想按时间问就只能把几千封拉下来自己比。
//
// 关键区别：有些说法本身就是**一段**（上个月、2025年10月、去年），必须同时给出
// 两端边界；只给 since 会让「去年 10 月」变成「2025-10 之后的所有邮件」，答案全错。
// 所以这里返回 { since, before }，而不是单个时间点。
// 这些边界都要落在用户所在时区（见 tz.js）。用 Date.UTC 直接造的话，
// 东八区用户问「上个月」会拿到北京时间 1 号早上 8 点作起点，
// 1 号 0-8 点收到的信会被算进上个月。
function monthStart(y, m, tz) {      // m 从 0 起，可以是负数/越界，内部会自己进位
  return zonedMidnight(y, m, 1, tz).toISOString();
}

function parseSpan(v, label, tz = tzName()) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const now = new Date();
  // 「今天」「今年」「上个月」按调用方指定的时区算（默认跟随部署配置），不是 UTC
  const { y: Y, m: M, d: D } = zonedNow(tz);

  // 单月 / 单年 —— 闭区间
  const mCn = /^(去年|前年|今年|明年)?\s*(\d{1,2})\s*月(?:份)?$/.exec(s);
  if (mCn) {
    const base = mCn[1] === '去年' ? Y - 1 : mCn[1] === '前年' ? Y - 2 : mCn[1] === '明年' ? Y + 1 : Y;
    const mm = Number(mCn[2]) - 1;
    if (mm < 0 || mm > 11) throw new Error(`${label} 的月份「${s}」不对，应该是 1 到 12 月`);
    return { since: monthStart(base, mm, tz), before: monthStart(base, mm + 1, tz) };
  }
  const mNum = /^(\d{4})\s*[年\-\/.]\s*(\d{1,2})\s*月?$/.exec(s);
  if (mNum) {
    const yy = Number(mNum[1]);
    const mm = Number(mNum[2]) - 1;
    if (mm < 0 || mm > 11) throw new Error(`${label} 的月份「${s}」不对，应该是 1 到 12 月`);
    return { since: monthStart(yy, mm, tz), before: monthStart(yy, mm + 1, tz) };
  }
  const yCn = /^(去年|前年|今年|明年)$/.exec(s);
  if (yCn) {
    const base = yCn[1] === '去年' ? Y - 1 : yCn[1] === '前年' ? Y - 2 : yCn[1] === '明年' ? Y + 1 : Y;
    return { since: monthStart(base, 0, tz), before: monthStart(base + 1, 0, tz) };
  }
  const yNum = /^(\d{4})\s*年$/.exec(s);
  if (yNum) {
    const yy = Number(yNum[1]);
    return { since: monthStart(yy, 0, tz), before: monthStart(yy + 1, 0, tz) };
  }
  if (s === '上个月' || s === '上月') return { since: monthStart(Y, M - 1, tz), before: monthStart(Y, M, tz) };
  if (s === '本月' || s === '这个月' || s === '当月') return { since: monthStart(Y, M, tz), before: null };
  if (s === '下个月' || s === '下月') return { since: monthStart(Y, M + 1, tz), before: monthStart(Y, M + 2, tz) };

  // 相对量：只给起点（「最近 7 天」本来就是到今天为止）
  const rel = /^(\d+)\s*(d|天|日|w|周|m|月|y|年)$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const u = rel[2].toLowerCase();
    const d = new Date(now.getTime());
    if (u === 'd' || u === '天' || u === '日') d.setUTCDate(d.getUTCDate() - n);
    else if (u === 'w' || u === '周') d.setUTCDate(d.getUTCDate() - n * 7);
    else if (u === 'm' || u === '月') d.setUTCMonth(d.getUTCMonth() - n);
    else d.setUTCFullYear(d.getUTCFullYear() - n);
    return { since: d.toISOString(), before: null };
  }
  if (s === '最近一周' || s === '这一周' || s === '本周') {
    return { since: new Date(now.getTime() - 7 * 86400000).toISOString(), before: null };
  }
  if (s === '今天' || s === '今日') {
    return { since: zonedMidnight(Y, M, D, tz).toISOString(), before: null };
  }

  // 具体日期：只当起点用（「2026-10-01 之后」），不做闭区间——
  // 除非调用方另外传了 before。
  // 纯日期要按本地零点算，跟「2025-10」保持同一口径；直接用 Date.parse
  // 会当成 UTC 零点，东八区等于从当天早上 8 点起算，边界当天的信就漏了。
  const dateOnly = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (dateOnly) {
    return {
      since: zonedMidnight(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), tz).toISOString(),
      before: null,
    };
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) {
    throw new Error(`${label} 看不懂「${s}」。可以填 上个月、去年10月、2025年10月、2025-10、7d、30d，或 2026-10-01 这样的日期`);
  }
  return { since: new Date(t).toISOString(), before: null };
}

// 把 since / before 两个参数合成一对边界。
// 用法：range = resolveRange(since, before, timezone)
function resolveRange(since, before, tz = tzName()) {
  const a = parseSpan(since, 'since', tz);
  const b = parseSpan(before, 'before', tz);
  let sinceIso = a?.since || null;
  let beforeIso = b?.since || null;
  // 「上个月」「2025年10月」自带另一端：调用方只给了 since 也要补上 before，
  // 否则「去年 10 月」会退化成「2025-10 之后」，把今年的邮件也算进去。
  if (a?.before && !beforeIso) beforeIso = a.before;
  if (b?.before && !sinceIso) sinceIso = b.since;
  return { sinceIso, beforeIso, ranged: !!(sinceIso || beforeIso) };
}

// 跨文件夹统计只算「收到的信」：已发送 / 草稿 / 垃圾箱 / 垃圾邮件里的内容
// 不是用户问「上个月有哪些邮件」时想看的。
// 实测不排除的话，2026-10 会从 4 封变成 9 封 —— 多出来的 5 封是自己发给自己的
// 告警邮件（在「已发送」里），用户完全不会把它们当成「收到的邮件」。
const NON_INBOUND_SPECIAL = new Set(['\\Sent', '\\Drafts', '\\Trash', '\\Junk']);
// 国内服务商经常不返回 SPECIAL-USE，只能靠夹名兜底
const NON_INBOUND_NAME = /(已发送|发件箱|草稿|已删除|废纸篓|垃圾邮件|\b(sent|drafts?|trash|deleted|junk|spam)\b)/i;

function nonInboundFolders(uid, accountIds) {
  const out = new Set();
  for (const id of accountIds) {
    for (const f of cache.getFolders(uid, id) || []) {
      if (!f || !f.path) continue;
      if (f.special) {
        if (NON_INBOUND_SPECIAL.has(f.special)) out.add(f.path);
      } else if (NON_INBOUND_NAME.test(`${f.name || ''} ${f.path}`)) {
        out.add(f.path);
      }
    }
  }
  return [...out];
}

// 把解析出的边界写回给人看的一句话，让模型回答时能说明「查的是哪段」
function describeRange(sinceIso, beforeIso, tz = tzName()) {
  // 说的是用户眼里的日期，所以按同一个时区取年月日；
  // 直接截 ISO 前 10 位拿到的是 UTC 日期，东八区会整体差一天。
  const d = (iso) => (iso ? fmtZoned(iso, tz) : null);
  if (sinceIso && beforeIso) return `${d(sinceIso)} 至 ${d(beforeIso)}（不含右端）`;
  if (sinceIso) return `${d(sinceIso)} 之后`;
  if (beforeIso) return `${d(beforeIso)} 之前`;
  return null;
}

// 时间范围过滤（IMAP 直拉那条路没有 SQL 可用，只能在这一层过一遍）
function inRange(date, sinceIso, beforeIso) {
  if (!sinceIso && !beforeIso) return true;
  const t = Date.parse(String(date || ''));
  if (!Number.isFinite(t)) return true;   // 时间认不出来就不过滤，宁多给别漏给
  if (sinceIso && t < Date.parse(sinceIso)) return false;
  if (beforeIso && t >= Date.parse(beforeIso)) return false;
  return true;
}


const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (o) => text(JSON.stringify(o, null, 2));
const fail = (s) => ({ content: [{ type: 'text', text: `执行失败：${s}` }], isError: true });

// 把异常压成人话。mail.js 已经把 IMAP 错误映射过一轮，这里只做兜底和截断。
function humanError(e) {
  const msg = String(e?.message || e || '未知错误');
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

// 未读口径：主口径 = 收件箱（与 list_messages 默认行为一致），全部文件夹合计作附加信息。
// 抽成纯函数方便单测。
export function splitUnread(counts) {
  const inboxKey = Object.keys(counts).find((k) => String(k).toUpperCase() === 'INBOX');
  const inbox = Number(inboxKey ? counts[inboxKey] : 0) || 0;
  const total = Object.values(counts).reduce((s, n) => s + (Number(n) || 0), 0);
  return { inbox, total, other: total - inbox };
}

// 认证结果（Authentication-Results）是 SPF/DKIM/DMARC 的原始报文，动辄两三百字：
//   mx.qq.com; spf=pass smtp.mailfrom=<a@b> (ip=1.2.3.4); dkim=pass header.d=b; dmarc=pass
// 它只用于判断钓鱼，却被拼在正文前面，用户看到的全是等号和 IP，正文还被挤到显示上限之外。
// 这里压成一句人话；原文只在异常时附在结果最后，留给模型复核。
export function summarizeAuth(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const pick = (k) => (s.match(new RegExp(`\\b${k}\\s*=\\s*([A-Za-z]+)`, 'i')) || [])[1]?.toLowerCase() || '';
  const ZH = {
    pass: '通过', fail: '未通过', softfail: '可疑', none: '未声明',
    permerror: '配置有误', temperror: '临时失败', policy: '按策略',
    quarantine: '被判隔离', reject: '被判拒绝',
  };
  const spf = pick('spf');
  const dkim = pick('dkim');
  const dmarc = pick('dmarc');
  const parts = [spf && `SPF ${ZH[spf] || spf}`, dkim && `DKIM ${ZH[dkim] || dkim}`, dmarc && `DMARC ${ZH[dmarc] || dmarc}`]
    .filter(Boolean);
  // 只认「认证结果本身」的取值，不再拿裸词去扫原文。
  // 2026-11-10 实测：微软/招行这类邮件写的是
  //   dmarc=pass (p=REJECT sp=REJECT dis=NONE)
  // 这里的 p=REJECT 是**发件方声明的处理策略**，不是这封信被判拒。
  // 老实现用 /\b(quarantine|reject)\b/i 扫整行，于是每封正常邮件都被判可疑，
  // 正文末尾那行「⚠ 信头校验未通过：SPF 通过 · DKIM 通过 · DMARC 通过」
  // 三项全绿却写着未通过，怎么改文案都消不掉——根因在这里。
  const bad = new Set(['fail', 'softfail', 'permerror', 'temperror', 'quarantine', 'reject']);
  const suspicious = [spf, dkim, dmarc].some((v) => bad.has(v));
  return {
    suspicious,
    brief: parts.join(' · ') || '无法解析',
    raw: s.length > 200 ? `${s.slice(0, 200)}…` : s,
  };
}

// ---- 正文收拾 ------------------------------------------------------------
// 邮件页脚对读信的人没有信息量，在手机上却能把正文挤出屏幕。Steam 这封登录码邮件就是典型：
//   「--」分隔线 + 「此通知已发送至…」 + 「这封电子邮件由系统自动生成，请勿回复」 +
//   「© Valve Corporation 保留所有权利」 + 「--」 + 「在网页上查看此消息：<八九百字的追踪链接>」
// 五行噪声围着两行正文。这里只从**尾部**往下数，命中 ≥2 行才切——宁漏不误：
// 正文中间出现「版权所有」这种句子不会被误删。
const FOOTER_PATTERNS = [
  /此(通知|邮件|电子邮件|消息).{0,6}(发送至|由系统|自动生成)/,
  /(邮件|通知|消息)(由|系)系统(自动)?(发送|生成)/,
  /(请勿|不要)(直接)?回复/,
  /(保留所有权利|全部?商标)/,
  /©|\(c\)\s*\d{4}/i,
  /在(网页|浏览器)上?(查看|打开)/,
  /view (this )?(email|message)? ?in (your )?browser/i,
  /(unsubscribe|opt.?out|退订|取消订阅)/i,
  /您(所以|之所以)?(会)?收到(这封|此)/,
  /this (email|message) was sent to|you (are|'re) receiving this/i,
];

// 整行只有一个重复的分隔符：`--`、`——`、`____`、`====`。单独的一个「-」不算。
const isSeparator = (line) => /^\s*([-–—_=*~])\1{1,}\s*$/.test(line);

export function trimBoilerplate(body) {
  const lines = String(body || '').split('\n');
  let cut = lines.length;   // 保留 [0, cut)
  let noise = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l || isSeparator(l)) { cut = i; continue; }
    if (FOOTER_PATTERNS.some((re) => re.test(l))) { noise += 1; cut = i; continue; }
    break;   // 碰到真内容，停
  }
  const kept = noise >= 2 ? lines.slice(0, cut) : lines;
  // 收尾的空行和分隔线永远没有意义，无论切没切都剥掉
  while (kept.length && (!kept[kept.length - 1].trim() || isSeparator(kept[kept.length - 1].trim()))) kept.pop();
  return kept.join('\n').trim();
}

// 行内超长链接（追踪链接、带一大串参数的登录链接）在手机上读不出信息，也点不动。
// 收成前 60 字，保留域名和路径开头。100 字以下的不动——正常链接还能用。
export function shortenLongUrls(text) {
  return String(text || '').replace(/https?[:：]\/\/[^\s，。；）)】」"]{100,}/gi, (u) => `${u.slice(0, 60)}…`);
}

// 账号参数允许多种写法：id、邮箱地址、显示名，且对显示名/地址做宽松匹配
//（用户嘴里的「QQ邮箱」「163」这种称呼不一定和备注一字不差）。只有一个账号时可以完全省略。
function accountLabel(a) {
  return a.displayName && a.displayName !== a.email
    ? `${a.displayName}（${a.email}，id ${a.id}）`
    : `${a.email}（id ${a.id}）`;
}

function resolveAccount(uid, ref) {
  const all = listAccounts(uid);
  if (!all.length) throw new Error('还没有添加任何邮箱账号，请先在 MailNest 网页端添加一个');
  // 剥掉 agent 可能原样转述的引号
  const key = String(ref || '').trim().replace(/^["'「『『]+|["'」』』]+$/g, '').trim();
  if (!key) {
    if (all.length === 1) return all[0];
    throw new Error(`有 ${all.length} 个账号，请用 account 指定其中一个（显示名、邮箱地址或 id 都行）：${all.map(accountLabel).join('、')}`);
  }
  const lower = key.toLowerCase();
  const squeeze = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  const ks = squeeze(key);
  const hit = all.find((a) => a.id === key)
    || all.find((a) => a.email.toLowerCase() === lower)
    || all.find((a) => (a.displayName || '').toLowerCase() === lower);
  if (hit) return hit;
  // 宽松匹配：显示名/地址去掉空格后互相包含（如备注「QQ 邮箱」对上「QQ邮箱」），唯一命中才放行
  const fuzzy = all.filter((a) => {
    const dn = squeeze(a.displayName);
    const em = squeeze(a.email);
    return (dn && dn.length > 1 && (dn.includes(ks) || ks.includes(dn)))
      || em.includes(ks);
  });
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new Error(`「${key}」能对上 ${fuzzy.length} 个账号，请说得更具体些（或用邮箱地址/id）：${fuzzy.map(accountLabel).join('、')}`);
  }
  throw new Error(`找不到账号「${key}」。account 可以填显示名、邮箱地址或 id，拿不准可先调 list_accounts。可用账号：${all.map(accountLabel).join('、')}`);
}

export { resolveAccount, parseSpan, resolveRange };

// 跨账号汇总：单个账号失败只记一笔，不拖垮整次查询（Outlook 掉 token 是常态）；
// 合并后按时间倒序，只留最新的 per 条。抽出来是为了能脱离 IMAP 单独测。
async function collectAcrossAccounts(accounts, fetchOne, per) {
  const merged = [];
  const failed = [];
  const perAccount = [];
  let total = 0;
  for (const acc of accounts) {
    try {
      const d = await fetchOne(acc);
      const t = Number(d.total) || 0;
      total += t;
      perAccount.push({ account: acc.displayName || acc.email, id: acc.id, total: t });
      for (const m of d.messages || []) merged.push(m);
    } catch (e) {
      failed.push(`${accountLabel(acc)}：${humanError(e)}`);
    }
  }
  merged.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return { merged, failed, total, perAccount, shown: merged.slice(0, per) };
}

export { collectAcrossAccounts };

function normUids(uids) {
  const list = (Array.isArray(uids) ? uids : [uids]).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) throw new Error('没有指定要操作的邮件 uid');
  if (list.length > MAX_UIDS) throw new Error(`一次最多操作 ${MAX_UIDS} 封，当前 ${list.length} 封`);
  return [...new Set(list)];
}

function normFolder(f) {
  const s = String(f || '').trim();
  if (!s) return 'INBOX';
  // 用户和模型都会说「收件箱」「垃圾箱」这种展示名。直接拿去当 IMAP 路径查，
  // 会得到一个不存在的文件夹。常见的这几个统一映射成规范名。
  const ALIAS = {
    收件箱: 'INBOX', inbox: 'INBOX',
    已发送: 'Sent', 发件箱: 'Sent', sent: 'Sent',
    已删除: 'Trash', 垃圾箱: 'Trash', 废纸篓: 'Trash', trash: 'Trash',
    垃圾邮件: 'Junk', 广告邮件: 'Junk', spam: 'Junk', junk: 'Junk',
    草稿: 'Drafts', 草稿箱: 'Drafts', drafts: 'Drafts',
  };
  return ALIAS[s.toLowerCase()] || s;
}

// 把「已发送」这类说法解析成该账号真实的 IMAP 路径。
// normFolder 只能给出一个假定的标准名（'Sent'），而真实路径可能是中文的
// 「已发送」（QQ/163 就是这样），也可能是 'Sent Items'（outlook）——
// 直接拿 'Sent' 去查，永远查不到这个文件夹。
const SPECIAL_OF = {
  INBOX: '\\Inbox', SENT: '\\Sent', TRASH: '\\Trash', JUNK: '\\Junk', DRAFTS: '\\Drafts',
};
function resolveFolderPath(uid, accountId, input) {
  const raw = String(input || '').trim();
  if (!raw) return 'INBOX';
  const want = normFolder(raw);
  const list = cache.getFolders(uid, accountId) || [];
  if (!list.length) return want;                       // 还没缓存过文件夹清单，只能照原样试
  if (list.some((f) => f.path === raw)) return raw;    // 用户直接给了真实路径
  if (list.some((f) => f.path === want)) return want;
  const sp = SPECIAL_OF[want.toUpperCase()];
  if (sp) {
    const hit = list.find((f) => f.special === sp);
    if (hit) return hit.path;
  }
  const byName = list.find((f) => String(f.name || '').toLowerCase() === raw.toLowerCase());
  return byName ? byName.path : want;
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
    // 别在这里写「问未读就用这个」：这句话会让模型拿账号列表去回答「有没有未读邮件」，
    // 而用户要看的是邮件本身。只回答数量用 unread_count，要邮件明细用 list_messages。
    description: '列出当前账号下已配置的邮箱，顺带给出各文件夹未读数——它的用途是核对账号清单、'
      + '以及确认其它工具的 account 参数该填什么（显示名、邮箱地址或 id 都行）。'
      + '凡是问未读的都不要用它（它只给统计）：问数量用 unread_count，要看具体是哪几封用 list_messages（unreadOnly=true）。',
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
        let counts = {};
        try { counts = await unseenCounts(uid, a.id); } catch { /* 单个账号连不上不影响整体列表 */ }
        const { inbox, total, other } = splitUnread(counts);
        // 主口径是收件箱未读（与 list_messages 默认行为一致），其它文件夹合计只作附加字段
        out.push({
          id: a.id, email: a.email, name: a.displayName,
          unread: inbox,
          ...(other > 0 ? { unreadOther: other } : {}),
        });
      }
      return json({ accounts: out });
    },
  });

  define(server, ctx, {
    name: 'unread_count',
    scope: 'read',
    title: '查询未读数量',
    description: '只回答未读邮件的数量，不返回邮件本身。用在用户明确只关心数字时（「几封未读」「未读多少」）；'
      + '要是他想看具体是哪几封，改用 list_messages（unreadOnly=true）。'
      + '不指定 account 且有多个账号时，返回每个账号的未读汇总；指定 account 时返回该账号的文件夹明细。',
    annotations: { readOnlyHint: true },
    schema: { account: optStr().describe('账号显示名、邮箱地址或 id（如「QQ邮箱」）；不填则汇总所有账号') },
    run: async ({ account }) => {
      const all = listAccounts(uid);
      if (!all.length) throw new Error('还没有添加任何邮箱账号，请先在 MailNest 网页端添加一个');
      const totalOf = async (a) => {
        try {
          const counts = await unseenCounts(uid, a.id);
          const folders = Object.entries(counts)
            .filter(([, n]) => Number(n) > 0)
            .map(([p, n]) => `${p} ${n} 封`);
          return { ...splitUnread(counts), folders };
        } catch (e) {
          return { inbox: 0, total: 0, other: 0, folders: [], error: humanError(e) };
        }
      };
      const label = (a) => `${a.displayName && a.displayName !== a.email ? `${a.displayName}（${a.email}）` : a.email}`;
      if (!account && all.length > 1) {
        const lines = [];
        let grand = 0;
        for (const a of all) {
          const r = await totalOf(a);
          grand += r.inbox;
          lines.push(`- ${label(a)}：收件箱 ${r.inbox} 封未读${r.other ? `（另有 ${r.other} 封在其它文件夹）` : ''}${r.error ? `（查询失败：${r.error}）` : ''}`);
        }
        return text(`所有账号收件箱共 ${grand} 封未读：\n${lines.join('\n')}\n\n要看到底是哪几封，跟我说「看未读邮件」就行。`);
      }
      const acc = resolveAccount(uid, account || (all.length === 1 ? '' : ''));
      const r = await totalOf(acc);
      const head = r.error
        ? `「${label(acc)}」未读数查询失败：${r.error}`
        : `「${label(acc)}」收件箱 ${r.inbox} 封未读，全部文件夹合计 ${r.total} 封${r.total > r.inbox ? `（${r.folders.join('、')}）` : r.total === 0 ? '（没有未读邮件）' : ''}`;
      return text(`${head}\n\n要看到底是哪几封、或看某一封的正文，直接说就行。`);
    },
  });

  define(server, ctx, {
    name: 'list_folders',
    scope: 'read',
    title: '列出文件夹',
    description: '列出某个邮箱账号的文件夹（收件箱、已发送、垃圾箱、自定义文件夹），带各文件夹未读数。',
    annotations: { readOnlyHint: true },
    schema: { account: optStr().describe('账号显示名、邮箱地址或 id；只有一个账号时可省略') },
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
    description: '按时间倒序分页列出邮件摘要（发件人、主题、时间、已读/星标），不含正文。要看正文再用 read_message。'
      + '用户问「有没有未读邮件」「有哪些未读」「未读的都是什么」时用这个，传 unreadOnly=true。'
      + '⚠ 用户指名了某个邮箱（如「outlook 的未读」「QQ邮箱的未读」）时必须传 account=那个邮箱，不要查全部账号；'
      + '只有用户没提任何邮箱时才省略 account（此时会合并全部账号并按时间排序）。',
    annotations: { readOnlyHint: true },
    schema: {
      account: optStr().describe('账号显示名、邮箱地址或 id（如「QQ邮箱」）；省略则查全部账号'),
      folder: optStr().describe('文件夹路径，默认 INBOX'),
      page: z.coerce.number().int().min(1).optional().describe('页码，从 1 开始（跨账号只支持第一页）'),
      pageSize: z.coerce.number().int().min(1).max(PAGE_MAX).optional().describe(`每页条数，最多 ${PAGE_MAX}，默认 20`),
      unreadOnly: z.boolean().optional().describe('只列未读邮件（默认 false 列全部）'),
      from: optStr().describe('按发件人筛：填名字或地址的一部分都行（如「华为」「steampowered」）。'
        + '用户问「有没有来自 X 的邮件」时用它，比把 X 丢进关键词搜更准——'
        + '搜关键词会连正文里提到的都算进去（账单正文里出现「华为京东自营」就会命中）'),
      since: optStr().describe('只要这段时间里的邮件：上个月、去年10月、2025年10月、7d、2026-10-01 都行'),
      before: optStr().describe('截止时间（不含），写法同 since；只给 since 时按 since 自带的区间算'),
    },
    run: async ({ account, folder, page, pageSize, unreadOnly, since, before, from }) => {
      const dir = normFolder(folder);
      const range = resolveRange(since, before);
      const sinceIso = range.sinceIso;
      const beforeIso = range.beforeIso;
      const needFilter = range.ranged || !!from;
      const per = Math.min(Math.max(1, pageSize || 20), PAGE_MAX);
      const pg = Math.max(1, page || 1);
      const toItem = (m, acc, folderPath) => {
        const it = {
          uid: m.uid,
          from: m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address,
          subject: m.subject,
          date: m.date,
          unread: !m.flags.includes('\\Seen'),
          starred: m.flags.includes('\\Flagged'),
          hasAttachment: m.hasAttachment,
        };
        // uid 只在「某个文件夹」里唯一，不在收件箱的信只看 uid 定位不到。
        // 把规范文件夹名带回去，上层「回 1 看正文」时才能原样带过来。
        if (folderPath) it.folder = folderPath;
        // 跨账号时每条都标来源：uid 只在单个账号内唯一，后续「回 1 看这封」
        // 必须连账号一起带回去，否则下一步定位不到是哪封信。
        if (acc) it.account = acc.displayName && acc.displayName !== acc.email ? acc.displayName : acc.email;
        return it;
      };

      const all = listAccounts(uid);
      if (!all.length) throw new Error('还没有添加任何邮箱账号，请先在 MailNest 网页端添加一个');

      // 带条件（时间范围 / 发件人）时走本地缓存：过滤在 SQL 里、分页在过滤之后。
      // IMAP 那条路是按序号取「最新第 N 页」，过滤只能落在这一页内——
      // 实测问「2025 年 10 月的邮件」返回 0 封，因为那些邮件根本不在最新 30 封里。
      if (needFilter) {
        const targets = account ? [resolveAccount(uid, account)] : all;
        // 不指名文件夹时，两类问法都该搜全部文件夹：
        //   ①「有没有来自 X 的邮件」——这个邮箱把 Steam 的 104 封全放在自定义夹，只查收件箱会答成「只有几封」；
        //   ②「上个月有哪些邮件」——2026-10 一共 4 封，其中 2 封在 Steam 夹里，只查收件箱会漏一半。
        // 早先只给 ① 开了跨夹，② 仍然只查收件箱，用户看到的就是「上个月只有 2 封」。
        const crossFolder = !folder && (!!from || range.ranged);
        // 「已发送」在不同服务商的真实路径不一样（QQ 是「已发送」，outlook 是 Sent Items），
        // 必须按账号各自解析；直接拿 normFolder 的 'Sent' 去查会一个都匹配不上。
        const dirOf = new Map(targets.map((a) => [a.id, folder ? resolveFolderPath(uid, a.id, folder) : dir]));
        const ids = targets.filter((a) => crossFolder || cache.folderSynced(uid, a.id, dirOf.get(a.id))).map((a) => a.id);
        const notSynced = crossFolder ? [] : targets.filter((a) => !cache.folderSynced(uid, a.id, dirOf.get(a.id)));
        const scopeDir = crossFolder ? null : dirOf.get(ids[0]);
        // 跨夹统计只覆盖「已经同步到本地」的夹。不说出来的话，偏小的 total 会被当成真实总数。
        const partialDirs = crossFolder
          ? targets
            .map((a) => [a, cache.unsyncedFolders(uid, a.id)])
            .filter(([, fs]) => fs.length)
          : [];
        if (!ids.length) {
          throw new Error('这些邮箱的「' + dir + '」还没同步到本地，暂时不能按条件筛选；'
            + '先用不带条件的 list_messages 打开一次让它同步，或稍等几秒再试');
        }
        const r = cache.listRange(uid, ids, {
          folder: scopeDir,
          // 跨夹时把「自己发出去的」那些夹排掉，否则「上个月有哪些邮件」会把
          // 已发送里的告警信一起算进来，数字偏大且看不出原因
          excludeFolders: crossFolder ? nonInboundFolders(uid, ids) : null,
          since: sinceIso, before: beforeIso, from: from || null,
          unreadOnly: !!unreadOnly, page: pg, pageSize: per,
        });
        const byId = new Map(targets.map((a) => [a.id, a]));
        // 跨夹时每条都要带 folder，否则「回第 2 封看正文」定不到位置
        const items = r.messages.map((m) => toItem(m, byId.get(m.account_id) || null, crossFolder ? m.folder : scopeDir));
        const label = describeRange(sinceIso, beforeIso);
        return json({
          account: account ? { id: targets[0].id, email: targets[0].email } : undefined,
          folder: crossFolder ? '（全部文件夹）' : scopeDir,
          // 说清楚统计口径，免得模型把「自己发出去的」也算进「收到的邮件」
          ...(crossFolder ? { scope: '收到的邮件（不含已发送、草稿、垃圾箱）' } : {}),
          // 这里的 total 是「条件命中的总数」，不是文件夹总数——问「上月几封」照它答
          total: r.total,
          page: r.page,
          pageSize: r.pageSize,
          ...(from ? { from } : {}),
          ...(label ? { range: label } : {}),
          messages: items,
          ...(notSynced.length
            ? { note: `${notSynced.map(accountLabel).join('、')} 的「${dir}」还没同步完，上面的数字不含这些账号` }
            : {}),
          ...(partialDirs.length
            ? { note3: `${partialDirs.map(([a, fs]) => `${accountLabel(a)} 还有 ${fs.length} 个文件夹没同步完`).join('；')}，上面的数字只算了已同步的文件夹` }
            : {}),
          ...(r.total > items.length
            ? { note2: `共 ${r.total} 封，本页显示 ${items.length} 封，往后翻用 page=${pg + 1}` }
            : {}),
        });
      }

      // 指定账号（或本来就只有一个）：沿用原来的分页语义
      if (account || all.length === 1) {
        const acc = account ? resolveAccount(uid, account) : all[0];
        // 实时拉取也要用真实路径：「已发送」在 QQ 是中文路径，normFolder 给的 'Sent' 查不到
        const accDir = resolveFolderPath(uid, acc.id, dir);
        const d = await listMessages(uid, acc.id, accDir, { page: pg, pageSize: per, unreadOnly: !!unreadOnly });
        return json({
          account: { id: acc.id, email: acc.email },
          folder: accDir,
          total: d.total,
          page: d.page,
          pageSize: d.pageSize,
          messages: d.messages.map((m) => toItem(m, null, accDir)),
        });
      }

      // 没指定账号 + 多个账号：合并查询。
      // 「有没有未读邮件」这种没人指名道姓的问法就走这里——它是唯一能给出邮件本身的路径，
      // 只回一串账号计数用户是不认的（2026-11-09 实测）。
      if (pg > 1) {
        throw new Error(`有 ${all.length} 个账号，一次只能列第一页；要往后翻请先说是哪个邮箱：${all.map(accountLabel).join('、')}`);
      }
      const { failed, total, perAccount, shown } = await collectAcrossAccounts(
        all,
        async (acc) => {
          const accDir = resolveFolderPath(uid, acc.id, dir);
          const d = await listMessages(uid, acc.id, accDir, { page: 1, pageSize: per, unreadOnly: !!unreadOnly });
          return { total: d.total, messages: d.messages.map((m) => toItem(m, acc, accDir)) };
        },
        per,
      );
      if (!shown.length) {
        // 「全失败」和「确实没有」是两件事，不能都说成「没有」：
        // 前者要让模型知道可以重试，后者要让它敢确定地回答「没有」。
        // 而且这两种都不该退回纯文本——同一个工具，有结果给 JSON、没结果给文本，
        // 调用方按 JSON 解析就会直接崩（2026-11-10 线上实测）。
        const what = unreadOnly ? '未读邮件' : '邮件';
        if (failed.length === all.length) {
          throw new Error(`没有查到${what}：${failed.length} 个账号都查询失败（${failed.join('；')}）。`
            + '这不代表没有，等邮箱恢复后再试一次。');
        }
        return json({
          total: 0,
          messages: [],
          hint: failed.length
            ? `没有查到${what}（有 ${failed.length} 个账号查询失败：${failed.join('；')}），这不代表没有`
            : `所有账号都没有${what}`,
          ...(failed.length ? { failedAccounts: failed } : {}),
        });
      }
      // 到这个位置说明没有任何时间/发件人条件（有的话上面已经走缓存那条路）
      const notes = [];
      if (total > shown.length) {
        notes.push(`共 ${total} 封，只列了最新的 ${shown.length} 封；要更多请带 account 或调大 pageSize`);
      }
      return json({
        // ⚠ 指令放最前面：弱模型从上往下读，禁令必须先于数据出现
        warning: '⚠ 这是全部账号合并的结果。规则：'
          + '① 用户问题里提到了任何具体邮箱（如「QQ邮箱」「outlook」）时，禁止把本结果直接当作答案——'
          + '先看 perAccount 里该邮箱的数量，需要明细就带 account=该邮箱重新调用一次本工具；'
          + '② 用户没提任何邮箱时，才可以把本结果作为答案，并逐条说明来源邮箱。',
        accounts: all.map((a) => a.email),
        // 分账号计数：用户问「XX邮箱有没有/有几封」时，答案就在这一行，不用重查也能答对数字
        perAccount,
        folder: dir,
        total,
        pageSize: per,
        messages: shown,
        ...(notes.length ? { note: notes.join('；') } : {}),
        ...(failed.length ? { failedAccounts: failed } : {}),
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
      account: optStr().describe('账号显示名、邮箱地址或 id；省略则搜索全部账号'),
      folder: optStr().describe('只搜某个文件夹（路径从 list_folders 拿）；省略则搜所有文件夹'),
      limit: z.coerce.number().int().min(1).max(50).optional().describe('最多返回多少封，默认 20'),
      from: optStr().describe('只留发件人是这个的（名字或地址片段，如「华为」「steampowered」）；'
        + '问「有没有来自 X 的邮件」时用它，能排除掉只是正文提到 X 的邮件'),
      unreadOnly: z.boolean().optional().describe('只返回未读的（问「有没有新邮件」时用）'),
      since: optStr().describe('只要这段时间里的邮件：上个月、去年10月、2025年10月、7d、2026-10-01 都行'),
      before: optStr().describe('截止时间（不含），写法同 since'),
    },
    run: async ({ query, account, folder, limit, since, before, from, unreadOnly }) => {
      const q = String(query).trim();
      const range = resolveRange(since, before);
      const sinceIso = range.sinceIso;
      const beforeIso = range.beforeIso;
      const all = listAccounts(uid);
      if (!all.length) throw new Error('还没有添加任何邮箱账号，请先在 MailNest 网页端添加一个');
      const targets = account ? [resolveAccount(uid, account)] : all;
      const dir = folder ? String(folder).trim() : null;
      const cap = Math.min(Math.max(1, limit || 20), 50);

      const hits = [];
      let indexing = false;
      const failed = [];
      for (const acc of targets) {
        // 每个账号的真实路径可能不同（QQ 叫「已发送」，outlook 叫 Sent Items）
        const accDir = dir ? resolveFolderPath(uid, acc.id, dir) : null;
        if (accDir) {
          const folders = await listFolders(uid, acc.id);
          if (!folders.some((f) => f.path === accDir)) {
            throw new Error(`「${acc.email}」没有名为「${accDir}」的文件夹，可用：${folders.slice(0, 12).map((f) => f.path).join('、')}`);
          }
        }
        try {
          if (await ensureIndexed(uid, acc, accDir) === 'partial') indexing = true;
          for (const m of cache.searchMessages(uid, acc.id, q, {
            folder: accDir, limit: cap, since: sinceIso, before: beforeIso,
            from: from || null, unreadOnly: !!unreadOnly,
          })) {
            hits.push({ acc, ...m });
          }
        } catch (e) {
          // 单个账号搜不了（掉线、令牌过期、索引建一半）：记下来继续搜别的，
          // 但必须在结果里说出来——否则「6 封」和「31 封」看起来都像完整答案，
          // 用户会以为确实只有这么多（2026-11-10 实测：同一句话三次搜出 12/6/31）。
          failed.push(`${acc.displayName || acc.email}：${humanError(e)}`);
        }
      }
      hits.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      const shown = hits.slice(0, cap);

      if (!shown.length) {
        // 无一命中时也要给结构化结果：模型拿 total:0 才敢确定地说「没有」，
        // 也给不出「到底搜了几个词」这种模糊回答。查询失败是另一回事——那是
        // 「没查成」，必须走错误通道，否则会被当成「确实没有」（见下）。
        if (failed.length === targets.length) {
          throw new Error(`这次没搜到「${q}」：${failed.length} 个账号都查询失败（${failed.join('；')}）。`
            + '这不代表没有这些邮件——等那个邮箱恢复后再搜一次。');
        }
        const hint = indexing
          ? '部分邮箱正在建立搜索索引，等几秒再搜一次可能会有结果。'
          : '可以换一个更接近平台/发件人的词再搜（例如「火车票」换成「12306」），'
            + '也可以放宽时间范围，或者用 list_messages 逐页翻。';
        const scope = [
          dir ? `范围：${dir}` : null,
          from ? `发件人含「${from}」` : null,
          unreadOnly ? '只要未读' : null,
          describeRange(sinceIso, beforeIso) ? `时间：${describeRange(sinceIso, beforeIso)}` : null,
        ].filter(Boolean).join('，');
        return json({
          query: q,
          total: 0,
          messages: [],
          hint: `没搜到和「${q}」相关的邮件${scope ? `（${scope}）` : ''}。${hint}`,
          ...(failed.length ? { failedAccounts: failed } : {}),
        });
      }
      // 结构化返回：uid / 来源账号都在字段里，模型接「看第 N 封」时直接取用，
      // 文本层不再出现 uid=xxx 这类用户看不懂的东西
      const folderName = (p) => (String(p).toUpperCase() === 'INBOX' ? '收件箱' : p);
      const notes = [];
      if (failed.length) notes.push(`有 ${failed.length} 个账号没查成（${failed.join('；')}），下面的结果是其余账号的`);
      if (hits.length > shown.length) notes.push(`共找到 ${hits.length} 封，只显示最新的 ${shown.length} 封，想缩小范围直接说`);
      if (indexing) notes.push('部分邮箱的搜索索引刚建立，稍后再搜结果可能更全');
      return json({
        query: q,
        total: hits.length,
        messages: shown.map((m) => ({
          account: m.acc.displayName && m.acc.displayName !== m.acc.email ? m.acc.displayName : m.acc.email,
          // folder 给机器（下一步原样传给 read_message / set_flags 等），folderName 给人看。
          // 只给「收件箱」这种展示名的话，模型照着回传会去找一个叫「收件箱」的文件夹，必然失败。
          folder: m.folder,
          folderName: folderName(m.folder),
          uid: m.uid,
          from: m.from?.name ? `${m.from.name} <${m.from.address}>` : (m.from?.address || '未知'),
          subject: m.subject,
          date: m.date,
          unread: !m.flags.includes('\\Seen'),
          hasAttachment: m.hasAttachment,
          ...(m.snippet ? { snippet: m.snippet } : {}),
        })),
        ...(notes.length ? { note: notes.join('；') } : {}),
        ...(failed.length ? { failedAccounts: failed } : {}),
      });
    },
  });

  define(server, ctx, {
    name: 'read_message',
    scope: 'read',
    title: '读取邮件正文',
    description: `读取一封邮件的正文（纯文本）和基础信头。正文超过 ${BODY_LIMIT} 字会截断并标注；`
      + '附件只列清单（带编号），要看附件内容再调 read_attachment。查未读数/列邮件清单不要用本工具 —— '
      + '那是 list_accounts（自带未读数）和 list_messages（unreadOnly=true）的事。'
      + 'uid 自己用 list_messages 查，不要向用户索要。正文只给有用的部分：邮件自带的页脚'
      + '（免责声明/版权/退订/「在网页上查看」）和超长追踪链接已去掉；信头校验只在异常时提示，'
      + '异常时会附原始认证结果，可用于判断钓鱼邮件。',
    annotations: { readOnlyHint: true },
    schema: {
      account: optStr().describe('账号显示名、邮箱地址或 id（如「QQ邮箱」）'),
      folder: optStr().describe('邮件所在文件夹，默认 INBOX'),
      uid: z.coerce.number().int().positive().describe('邮件的 uid，先用 list_messages 查到再传（不要向用户索要）'),
      format: optStr().describe('默认 text（收拾过的纯文本）；填 html 直接给原始 HTML —— '
        + '纯文本把表格/版式吃掉了、数字对不上时用这个回去看原文'),
    },
    run: async ({ account, folder, uid: msgUid, format }) => {
      const acc = resolveAccount(uid, account);
      const dir = normFolder(folder);
      const m = await getMessage(uid, acc.id, dir, String(msgUid));
      const wantHtml = String(format || '').toLowerCase() === 'html';
      let body;
      if (wantHtml) {
        // 原文兜底：抽取器出错时（表格散架、纯图片排版）让上层能自己看结构
        body = String(m.html || '').trim() || String(m.text || '').trim();
      } else {
        // 表格在 htmlToText 里补了单元格分隔符，所以这里必须走同一份实现
        body = bodyTextOf(m);
        // 先收拾页脚和超长追踪链接，再判截断——否则正文额度全花在版权声明上
        body = trimBoilerplate(shortenLongUrls(body));
      }
      const truncated = body.length > BODY_LIMIT;
      if (truncated) body = body.slice(0, BODY_LIMIT);

      // 用户在微信里要的是正文。所以信头只留「这封是谁、什么时候、带没带附件」这几行，
      // 机器串（认证结果 / Return-Path）挪到最后：正常时一句话，异常时才附原文。
      // 2026-11-09 实测：正常营销邮件里 `认证结果：mx.qq.com; spf=pass smtp.mailfrom=<…>(ip=…)`
      // 占了三百字还排在最前面，用户看到的全是等号和 IP。
      const auth = summarizeAuth(m.authResults);
      const replyToDiff = !!(m.replyTo?.address && m.replyTo.address !== m.from?.address);
      const domainOf = (a) => String(a || '').toLowerCase().split('@').pop().replace(/[>\s),]+$/, '');
      const returnPathDiff = !!(m.returnPath && domainOf(m.returnPath) && domainOf(m.returnPath) !== domainOf(m.from?.address));
      const toList = (m.to || []).map((t) => t.address).filter(Boolean);
      const ccList = (m.cc || []).map((t) => t.address).filter(Boolean);

      const head = [
        `主题：${m.subject}`,
        `发件人：${m.from?.name ? `${m.from.name} <${m.from.address}>` : (m.from?.address || m.from?.text || '未知')}`,
        // 只有一个收件人时不啰嗦——用户自己知道这封信是寄给他的；抄送/多收件人才需要标
        (toList.length > 1 || ccList.length) ? `收件人：${toList.join(', ') || '(无)'}` : '',
        ccList.length ? `抄送：${ccList.join(', ')}` : '',
        `时间：${m.date || '未知'}`,
        m.attachments?.length
          ? `附件：${m.attachments.map((a, i) => `#${i + 1} ${a.filename}（${Math.round(a.size / 1024)} KB）`).join('、')}`
          : '附件：无',
      ].filter(Boolean).join('\n');

      const warn = [];
      if (replyToDiff) warn.push(`⚠ 回信地址是 ${m.replyTo.address}，与发件人不一致，回复会寄给第三方。`);
      if (returnPathDiff) warn.push(`⚠ 退信地址是 ${m.returnPath}，与发件人不同（群发/代发常见，可疑时留意）。`);
      if (auth?.suspicious) warn.push(`⚠ 信头校验未通过：${auth.brief}。`);
      const tail = [
        ...warn,
        // 校验全通过时不写这一行：用户两次反馈「正文里怎么夹着认证结果」，而全通过是零信息量。
        // 只有异常时才有话要说（warn 已经带了 ⚠ 一句，这里补原始报文给模型复核）。
        auth?.suspicious ? `原始认证结果：${auth.raw}` : '',
      ].filter(Boolean).join('\n');

      return text(`${head}\n\n${body || '(这封邮件没有可显示的正文)'}`
        + `${truncated ? `\n\n[正文已截断，只显示了前 ${BODY_LIMIT} 字]` : ''}`
        + `${tail ? `\n\n${tail}` : ''}`);
    },
  });

  define(server, ctx, {
    name: 'read_attachment',
    scope: 'read',
    title: '读取附件内容',
    description: '读取某封邮件里一个附件的内容（必须先用 read_message 拿到该邮件的附件清单和编号）。'
      + '⚠ 不要用它查未读、列邮件或读正文 —— 那是 list_accounts / list_messages / read_message 的事。'
      + 'uid 自己用 list_messages 查，不要向用户索要。文本类附件（txt/csv/json/html 等）直接返回文本；'
      + '小体积二进制（如 PDF）返回 base64；过大的二进制只报大小，请让用户到网页端下载。',
    annotations: { readOnlyHint: true },
    schema: {
      account: optStr().describe('账号显示名、邮箱地址或 id（如「QQ邮箱」）'),
      folder: optStr().describe('邮件所在文件夹，默认 INBOX'),
      uid: z.coerce.number().int().positive().describe('邮件的 uid，先用 list_messages 查到再传（不要向用户索要）'),
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
      account: optStr().describe('账号显示名、邮箱地址或 id（如「QQ邮箱」）'),
      folder: optStr().describe('邮件所在文件夹，默认 INBOX'),
      uids: uidList().describe('邮件 uid 列表'),
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
      account: optStr().describe('账号显示名、邮箱地址或 id（如「QQ邮箱」）'),
      folder: optStr().describe('邮件当前所在文件夹，默认 INBOX'),
      uids: uidList().describe('邮件 uid 列表'),
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
      account: optStr().describe('账号显示名、邮箱地址或 id（如「QQ邮箱」）'),
      folder: optStr().describe('邮件当前所在文件夹，默认 INBOX'),
      uids: uidList().describe('邮件 uid 列表'),
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
      account: optStr().describe('账号显示名、邮箱地址或 id（如「QQ邮箱」）'),
      folder: optStr().describe('文件夹路径，默认 INBOX'),
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
      account: optStr().describe('账号显示名、邮箱地址或 id（如「QQ邮箱」）'),
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
      account: optStr().describe('账号显示名、邮箱地址或 id（如「QQ邮箱」）'),
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
      account: optStr().describe('账号显示名、邮箱地址或 id（如「QQ邮箱」）'),
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
      account: optStr().describe('用哪个账号发（显示名/邮箱地址/id）；只有一个账号时可省略'),
      to: addrList(true).describe('收件人邮箱地址列表'),
      cc: addrList().describe('抄送地址列表'),
      bcc: addrList().describe('密送地址列表'),
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
      account: optStr().describe('账号显示名、邮箱地址或 id（如「QQ邮箱」）'),
      folder: optStr().describe('原邮件所在文件夹，默认 INBOX'),
      uid: z.coerce.number().int().positive().describe('原邮件的 uid，先用 list_messages 查到再传（不要向用户索要）'),
      to: addrList(true).describe('转发给谁（邮箱地址列表）'),
      cc: addrList().describe('抄送地址列表'),
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
      account: optStr().describe('账号显示名、邮箱地址或 id（如「QQ邮箱」）'),
      folder: optStr().describe('原邮件所在文件夹，默认 INBOX'),
      uid: z.coerce.number().int().positive().describe('原邮件的 uid，先用 list_messages 查到再传（不要向用户索要）'),
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
      account: optStr().describe('用哪个账号保存（显示名/邮箱地址/id）'),
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
      return text(`已保存草稿（编号 ${d.id}），可在网页端「草稿」里继续编辑；要发的时候跟我说一声。`);
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
        return `- 编号 ${d.id}（${who}）→ ${(d.to || '(无收件人)')}「${d.subject}」，正文 ${String(d.text || '').length} 字`;
      });
      return text(`共 ${drafts.length} 份草稿：\n${lines.join('\n')}\n\n继续编辑请在网页端「草稿」操作；要发哪一份跟我说编号。`);
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

export const TOOL_COUNT = 21;
