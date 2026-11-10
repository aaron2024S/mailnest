// 「按发件人 / 按时间问」这一整类问题的回归测试。
//
// 背景：用户随口问「有没有来自华为的新邮件」「去年某个月的邮件」，
// 之前的测试只覆盖了「正文里提到了什么」（语义检索），元数据这条路一条没测，
// 于是 list_messages 的 from 参数压根没实现、since 只在「最新 20 封」里过滤，
// 全都没被发现。这里把这一类钉死。
//
// 不用真实邮箱数据：发件人、域名、主题全是占位。
// 用法：node tests/range.mjs
import fs from 'node:fs';
import path from 'node:path';

let pass = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { failed++; console.error(`✗ ${name} ${extra}`); }
};

const DIR = path.resolve('.range-test');
fs.rmSync(DIR, { recursive: true, force: true });
process.env.MAILNEST_DATA = DIR;
// 夹具里的时间都是按东八区写的（跨月那封、「上个月」4 封……），
// 这里把口径钉死，换台机器跑结果也一致。时区段会临时改它再改回来。
if (!process.env.TZ) process.env.TZ = 'Asia/Shanghai';

const store = await import('../server/store.js');
const cache = await import('../server/cache.js');
const { registerTools } = await import('../server/mcp-tools.js');

store.ensureDataDirs();
const user = store.createUser({ username: 'range', password: 'password123', role: 'owner' });
const uid = user.id;

const QQ = { id: 'acc_qq', email: 'user@example.com', displayName: 'QQ邮箱' };
const OUT = { id: 'acc_out', email: 'work@example.net', displayName: 'outlook' };
store.saveAccounts(uid, [QQ, OUT]);

// ---------- 夹具 ----------
// 时间都写死，避免「今天」影响相对区间断言
const m = (n, from, subject, date, flags = [], extra = {}) => ({
  uid: n,
  from: { name: from[0], address: from[1] },
  to: [{ name: '', address: 'user@example.com' }],
  subject,
  date,
  flags,
  hasAttachment: false,
  ...extra,
});

const UNREAD = [];
const READ = ['\\Seen'];

const inboxQQ = [
  // 真正的华为来信 2 封
  m(101, ['华为开发者联盟', 'news@notice01.huawei.example'], '升级审核已通过', '2026-11-09T02:00:00.000Z', READ),
  m(102, ['华为开发者联盟', 'news@notice01.huawei.example'], '上架审核快问快答', '2026-08-20T03:00:00.000Z', READ),
  // 正文里会出现「华为京东自营」的账单 —— 不能因为搜关键词就算成「来自华为」
  m(103, ['招商银行信用卡', 'ccsvc@cmb.example'], '信用卡电子账单', '2026-10-25T01:00:00.000Z', READ),
];
const inboxOUT = [
  // 转发，主题里带「华为开发者」，同样不能算成「来自华为」
  m(201, ['朋友', 'friend@mail.example'], '转发：华为开发者上架审核卡住了', '2026-11-10T02:00:00.000Z', READ),
  // 去年 10 月唯一一封：问「去年10月」就该只回它
  m(202, ['某人', 'someone@cnonas.example'], '1.9 赵梦雨', '2025-10-14T02:00:00.000Z', READ),
  // 上个月（2026-10）的 Steam 通知
  m(203, ['Steam Support', 'noreply@steam.example'], '感谢您在 Steam 上的购买！', '2026-10-02T02:00:00.000Z', READ),
  // 贴着月份边界的信：UTC 还是 9-30 23:00，北京时间已经是 10-01 07:00。
  // 「上个月」按本地时区算就该包含它；按 UTC 算会漏掉。
  m(204, ['某人', 'night@cnonas.example'], '深夜到的信', '2026-09-30T23:00:00.000Z', READ),
];
// Steam 的自定义夹：问「Steam 给我发过邮件吗」时必须一起算上
const steamFolder = [
  m(301, ['Steam Support', 'noreply@steam.example'], '购买回执', '2026-06-01T02:00:00.000Z', READ),
  m(302, ['Steam Support', 'noreply@steam.example'], '购买回执', '2026-06-05T02:00:00.000Z', READ),
  m(303, ['Steam Support', 'noreply@steam.example'], '新设备访问', '2026-09-01T02:00:00.000Z', UNREAD),
  // 上个月的一封，故意放在自定义夹里：「上个月有哪些邮件」不指名文件夹时也该算上它
  m(304, ['Steam Support', 'noreply@steam.example'], '感谢您在 Steam 上的购买！', '2026-10-15T02:00:00.000Z', READ),
];
// 12306 也在自定义夹
const trainFolder = [
  m(401, ['12306', '12306@rails.example'], '购票通知', '2026-04-03T02:00:00.000Z', READ),
  m(402, ['12306', '12306@rails.example'], '购票通知', '2026-04-20T02:00:00.000Z', READ),
];
// 「已发送」：自己发出去的告警信。问「上个月有哪些邮件」时不该算进来——
// 线上实测就是被这类信把 4 封撑成了 9 封。
const sentQQ = [
  m(501, ['我', 'user@example.com'], 'BMC Warning', '2026-10-23T07:16:00.000Z', READ),
  m(502, ['我', 'user@example.com'], 'BMC Warning', '2026-10-23T07:04:00.000Z', READ),
];
// 有的服务商不返回 SPECIAL-USE，只能靠夹名认
const sentOUT = [
  m(601, ['我', 'work@example.net'], 'Re: 合同', '2026-10-11T02:00:00.000Z', READ),
];

cache.upsertEnvelopes(uid, QQ.id, 'INBOX', inboxQQ, 111);
cache.upsertEnvelopes(uid, OUT.id, 'INBOX', inboxOUT, 222);
cache.upsertEnvelopes(uid, OUT.id, 'Steam', steamFolder, 333);
cache.upsertEnvelopes(uid, QQ.id, '12306订票', trainFolder, 444);
cache.upsertEnvelopes(uid, QQ.id, '已发送', sentQQ, 555);
cache.upsertEnvelopes(uid, OUT.id, 'Sent Items', sentOUT, 666);
// 标记同步完成，否则带条件的查询会以「还没同步」为由拒绝
for (const [acc, dir] of [[QQ, 'INBOX'], [OUT, 'INBOX'], [OUT, 'Steam'], [QQ, '12306订票'],
  [QQ, '已发送'], [OUT, 'Sent Items']]) {
  cache.touchFolder(uid, acc.id, dir);
}
// IMAP LIST 的结果（含 \\Sent 这类特殊用途标记）。跨夹统计要靠它认出「已发送」。
cache.putFolders(uid, QQ.id, [
  { path: 'INBOX', name: '收件箱', delim: '/', special: null, subscribed: true },
  { path: '12306订票', name: '12306订票', delim: '/', special: null, subscribed: true },
  { path: '已发送', name: '已发送', delim: '/', special: '\\Sent', subscribed: true },
]);
cache.putFolders(uid, OUT.id, [
  { path: 'INBOX', name: '收件箱', delim: '/', special: null, subscribed: true },
  { path: 'Steam', name: 'Steam', delim: '/', special: null, subscribed: true },
  // 没有 special，只能靠名字
  { path: 'Sent Items', name: 'Sent Items', delim: '/', special: null, subscribed: true },
]);

// ---------- 用真实注册流程拿工具句柄（scope 拦截、异常转人话都走真代码） ----------
const tools = {};
registerTools({
  registerTool: (name, _meta, fn) => { tools[name] = fn; },
}, { uid, scopes: ['read', 'write', 'send'] });

const callList = async (args) => {
  const res = await tools.list_messages(args);
  const text = (res.content || []).map((c) => c.text).join('');
  if (res.isError) return { error: text, json: null };
  try {
    return { error: null, json: JSON.parse(text) };
  } catch {
    // 有些失败是「没有查到邮件（…）」这种纯文本，不是 JSON 也不是 isError
    return { error: text, json: null };
  }
};

const sendersOf = (j) => (j.messages || []).map((x) => String(x.from || ''));
const allFrom = (j, pat) => sendersOf(j).every((s) => s.toLowerCase().includes(pat));

// ---------- 按发件人 ----------
{
  const r = await callList({ from: '华为' });
  ok('from=华为 只返回华为发的（账单正文提到华为不算）',
    !r.error && r.json.total === 2 && allFrom(r.json, 'huawei'), JSON.stringify(r.json?.total));
  ok('from=华为 带 address 而不是正文匹配',
    !r.error && sendersOf(r.json).every((s) => !s.includes('cmb.example')), sendersOf(r.json).join(' | '));
}

{
  const r = await callList({ from: 'Steam' });
  ok('from=Steam 跨文件夹汇总（收件箱 + 自定义夹）= 5 封',
    !r.error && r.json.total === 5, JSON.stringify(r.json?.total));
  ok('跨文件夹时每条都带回 folder，后续「看第 2 封」才定得到位',
    !r.error && r.json.messages.every((x) => x.folder), JSON.stringify(r.json?.messages?.map((x) => x.folder)));
}

{
  const r = await callList({ from: '12306' });
  ok('from=12306 能查到放在自定义夹里的 2 封',
    !r.error && r.json.total === 2, JSON.stringify(r.json?.total));
}

{
  const r = await callList({ from: '京东' });
  ok('from=京东 真没有就返回 0 封，不是把收件箱全倒出来',
    !r.error && r.json.total === 0 && (r.json.messages || []).length === 0, JSON.stringify(r.json?.total));
}

{
  const r = await callList({ from: '华为', unreadOnly: true });
  ok('from + unreadOnly 组合：华为有 0 封未读',
    !r.error && r.json.total === 0, JSON.stringify(r.json?.total));
}

// ---------- 按时间 ----------
{
  const r = await callList({ since: '去年10月' });
  ok('since=去年10月 解析成整月区间，只回 2025-10 那 1 封',
    !r.error && r.json.total === 1 && r.json.messages[0].subject === '1.9 赵梦雨',
    JSON.stringify(r.json?.total));
}

{
  const r = await callList({ since: '2025年10月' });
  ok('since=2025年10月 同上', !r.error && r.json.total === 1, JSON.stringify(r.json?.total));
}

{
  const r = await callList({ since: '上个月' });
  // 4 封：收件箱 3 封（含北京 10-01 07:00 那封，UTC 是 9-30）+ Steam 自定义夹 1 封。
  // 只查收件箱会答成 3 封；按 UTC 算边界会漏掉跨月那封。
  // 「已发送」里那 3 封（2 封带 \Sent 标记、1 封只靠夹名认出）不算——那是自己发出去的。
  const { fmtZoned } = await import('../server/tz.js');
  ok('since=上个月 = 整月区间且跨全部文件夹（4 封），不把本月的算进来',
    !r.error && r.json.total === 4
    && (r.json.messages || []).every((x) => fmtZoned(x.date).slice(0, 7) === '2026-10'),
    JSON.stringify((r.json?.messages || []).map((x) => x.date)));
  ok('跨夹不含「已发送」（线上真把 4 封撑成 9 封的那类 BMC Warning）',
    !r.error && !(r.json.messages || []).some((x) => /BMC Warning|Re: 合同/.test(x.subject || '')),
    JSON.stringify((r.json?.messages || []).map((x) => x.subject)));
  ok('跨夹结果自带口径说明，模型不会把「发出去的」算进「收到的」',
    !r.error && /不含已发送/.test(String(r.json.scope || '')), String(r.json?.scope));
}

{
  // 排除只发生在「没指定文件夹」时；指名了「已发送」就该老老实实查那个夹
  const r = await callList({ folder: '已发送', since: '上个月' });
  ok('显式查「已发送」时不被排除（2 封）',
    !r.error && r.json.total === 2, String(r.error || r.json?.total));
}

{
  const r = await callList({ since: '2026-01-01', before: '2026-05-01', folder: '12306订票' });
  ok('显式日期区间 + 指定文件夹：2026 年 1-4 月的订票通知 2 封',
    !r.error && r.json.total === 2, JSON.stringify(r.json?.total));
}

{
  const r = await callList({ since: '2026-01-01', before: '2026-05-01' });
  // 这 2 封都在「12306订票」夹里；纯时间问句如果只查收件箱，用户会得到「那段时间没邮件」
  ok('只给时间不给文件夹时也跨全部文件夹：2026 年 1-4 月 2 封（在自定义夹里）',
    !r.error && r.json.total === 2, JSON.stringify(r.json?.total));
}

// ---------- 发件人 + 时间 ----------
{
  const r = await callList({ from: 'Steam', since: '上个月' });
  ok('from + since 组合：上个月 Steam 2 封',
    !r.error && r.json.total === 2 && allFrom(r.json, 'steam'), JSON.stringify(r.json?.total));
}

{
  const r = await callList({ from: '华为', since: '2026年3月' });
  ok('from + since 无交集时返回 0，而不是退回全量',
    !r.error && r.json.total === 0, JSON.stringify(r.json?.total));
}

// ---------- 分页与 total 的语义 ----------
{
  const r = await callList({ from: 'Steam', pageSize: 2 });
  ok('total 是条件命中的真实封数，不是本页条数',
    !r.error && r.json.total === 5 && r.json.messages.length === 2, `${r.json?.total}/${r.json?.messages?.length}`);
  ok('还有更多时提示怎么翻页', !r.error && !!r.json.note2, JSON.stringify(r.json?.note2));
}

{
  const r = await callList({ from: 'Steam', pageSize: 2, page: 2 });
  ok('第二页接得上', !r.error && r.json.messages.length === 2, String(r.json?.messages?.length));
}

// ---------- 指定账号（用户常问「QQ邮箱里有没有华为的邮件」） ----------
{
  const r = await callList({ from: '华为', account: 'QQ邮箱' });
  ok('account + from：QQ邮箱里的华为邮件 2 封',
    !r.error && r.json.total === 2 && allFrom(r.json, 'huawei'), JSON.stringify(r.json?.total));
}

{
  const r = await callList({ from: '华为', account: 'outlook' });
  ok('account + from：outlook 里没有华为的，返回 0 而不是另一个账号的',
    !r.error && r.json.total === 0, JSON.stringify(r.json?.total));
}

{
  const r = await callList({ since: '2025年10月', account: 'outlook' });
  ok('account + since：outlook 去年 10 月 1 封（那封在 outlook 收件箱）',
    !r.error && r.json.total === 1, JSON.stringify(r.json?.total));
}

// ---------- 搜索也要支持同一套条件 ----------
{
  const r = await tools.search_messages({ query: '购买', from: 'Steam' });
  const t = (r.content || []).map((c) => c.text).join('');
  const j = JSON.parse(t);
  ok('search + from：「购买」只回 Steam 发的，不把正文提到购买的也算进来',
    Array.isArray(j.messages) && j.messages.length > 0
    && j.messages.every((x) => String(x.from || '').toLowerCase().includes('steam')),
    JSON.stringify((j.messages || []).map((x) => x.from)));
}

{
  const r = await tools.search_messages({ query: '购买', from: '华为' });
  const t = (r.content || []).map((c) => c.text).join('');
  // 空结果也必须是 JSON：同一个工具「有结果给 JSON、没结果给纯文本」的话，
  // 调用方（网关、模型）按 JSON 解析会直接崩。2026-11-10 线上实测踩到。
  let j = null;
  try { j = JSON.parse(t); } catch { /* 留给下面断言报错 */ }
  ok('search + from 无交集时明确说没搜到（不是返回全量）',
    t.includes('没搜到'), t.slice(0, 80));
  ok('空结果仍是可解析的 JSON（不是一段纯文本）',
    j !== null, t.slice(0, 80));
  ok('空结果给 total:0 + messages:[]，模型才敢确定地说「没有」',
    j && j.total === 0 && Array.isArray(j.messages) && j.messages.length === 0,
    JSON.stringify(j && { total: j.total, n: (j.messages || []).length }));
}

// ---------- 分页不能重复也不能漏 ----------
{
  const seen = [];
  let total = null;
  for (let p = 1; p <= 3; p++) {
    const r = await callList({ from: 'Steam', pageSize: 2, page: p });
    total = r.json.total;
    seen.push(...r.json.messages.map((x) => `${x.account}|${x.folder}|${x.uid}`));
  }
  ok('翻页不重复（3 页 × 2 条，实际 5 封，去重后仍是 5）',
    new Set(seen).size === 5 && seen.length === 5, `total=${total} got=${seen.length} uniq=${new Set(seen).size}`);
}

// ---------- 时区：区间边界必须落在用户时区 ----------
// 场景：2026-09-30T23:00Z 这封信，北京时间是 10-01 07:00（属于 10 月），
// UTC 还是 9-30（属于 9 月）。同一条问句，两种时区口径必须给出不同结果，
// 而且「用户口径」那个才是对的。
{
  const prev = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  const cst = await callList({ since: '上个月', pageSize: 50 });
  process.env.TZ = 'UTC';
  const utc = await callList({ since: '上个月', pageSize: 50 });
  process.env.TZ = prev || 'Asia/Shanghai';

  const has = (r) => (r.json?.messages || []).some((x) => x.subject === '深夜到的信');
  ok('北京 10-01 早上 7 点到的信算 10 月（UTC 口径会漏成 9 月）',
    !cst.error && !utc.error && has(cst) && !has(utc),
    `cst=${cst.json?.total} utc=${utc.json?.total}`);
  ok('两种口径差在这 1 封上',
    (cst.json?.total || 0) === (utc.json?.total || 0) + 1,
    `${cst.json?.total} vs ${utc.json?.total}`);
  ok('区间说明按本地日期写，不是截 UTC 前 10 位',
    /2026-10-01 至 2026-11-01/.test(String(cst.json?.range || '')), String(cst.json?.range));
}

// ---------- 时区配置本身 ----------
// 用标准 TZ，不搞第二套变量；镜像不给默认值，谁部署谁设。
{
  const { tzName, assertTz } = await import('../server/tz.js');
  const prev = process.env.TZ;
  const UNSET = 'UTC';   // 没配 TZ 就是 UTC（不猜系统时区）
  const warned = [];
  const origWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    delete process.env.TZ;
    ok('不设 TZ 时按 UTC（不预设地域，也不猜系统时区）',
      tzName() === UNSET, String(tzName()));

    process.env.TZ = 'Europe/London';
    ok('TZ 可以覆盖运行环境时区', tzName() === 'Europe/London', String(tzName()));

    process.env.TZ = '';
    ok('TZ 设成空串时按没设处理', tzName() === UNSET, JSON.stringify(tzName()));

    // 写错不拦启动（容器起不来像镜像坏了），但必须回落到一个确定的时区，
    // 不能让非法值一路传到 Intl 抛 RangeError。
    process.env.TZ = 'Asia/Shanghia';   // 少一个 n，最常见的拼错
    let threw = false;
    let got = '';
    try { got = assertTz(); } catch { threw = true; }
    ok('时区名拼错时不抛错、回落到 UTC', !threw && got === UNSET, `threw=${threw} got=${got}`);
    ok('回落时打一条提醒（否则算错半天没人知道）',
      /不是合法时区名/.test(warned.join('')), warned.join('').slice(0, 40));
  } finally {
    console.warn = origWarn;
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
}

// ---------- 不带条件时保持原行为 ----------
// 无参数会走 IMAP 直拉，测试环境没有网络，这里只验证「它没被改成走缓存」
{
  const r = await callList({ pageSize: 50 });
  ok('不带条件时仍走原来的实时拉取（不是从缓存拼结果）',
    !!r.error && /邮件服务器|没有查到/.test(r.error), String(r.error).slice(0, 60));
}

console.log(`\n${failed ? '✗' : '✓'} 全部通过：${pass} 项断言${failed ? `，失败 ${failed}` : ''}`);
cache.closeAll();
fs.rmSync(DIR, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
