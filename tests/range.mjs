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
];
// Steam 的自定义夹：问「Steam 给我发过邮件吗」时必须一起算上
const steamFolder = [
  m(301, ['Steam Support', 'noreply@steam.example'], '购买回执', '2026-06-01T02:00:00.000Z', READ),
  m(302, ['Steam Support', 'noreply@steam.example'], '购买回执', '2026-06-05T02:00:00.000Z', READ),
  m(303, ['Steam Support', 'noreply@steam.example'], '新设备访问', '2026-09-01T02:00:00.000Z', UNREAD),
];
// 12306 也在自定义夹
const trainFolder = [
  m(401, ['12306', '12306@rails.example'], '购票通知', '2026-04-03T02:00:00.000Z', READ),
  m(402, ['12306', '12306@rails.example'], '购票通知', '2026-04-20T02:00:00.000Z', READ),
];

cache.upsertEnvelopes(uid, QQ.id, 'INBOX', inboxQQ, 111);
cache.upsertEnvelopes(uid, OUT.id, 'INBOX', inboxOUT, 222);
cache.upsertEnvelopes(uid, OUT.id, 'Steam', steamFolder, 333);
cache.upsertEnvelopes(uid, QQ.id, '12306订票', trainFolder, 444);
// 标记同步完成，否则带条件的查询会以「还没同步」为由拒绝
for (const [acc, dir] of [[QQ, 'INBOX'], [OUT, 'INBOX'], [OUT, 'Steam'], [QQ, '12306订票']]) {
  cache.touchFolder(uid, acc.id, dir);
}

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
  ok('from=Steam 跨文件夹汇总（收件箱 + 自定义夹）= 4 封',
    !r.error && r.json.total === 4, JSON.stringify(r.json?.total));
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
  ok('since=上个月 = 整月区间（2026-10 的 2 封），不把本月的算进来',
    !r.error && r.json.total === 2 && (r.json.messages || []).every((x) => String(x.date).slice(0, 7) === '2026-10'),
    JSON.stringify((r.json?.messages || []).map((x) => x.date)));
}

{
  const r = await callList({ since: '2026-01-01', before: '2026-05-01', folder: '12306订票' });
  ok('显式日期区间 + 指定文件夹：2026 年 1-4 月的订票通知 2 封',
    !r.error && r.json.total === 2, JSON.stringify(r.json?.total));
}

{
  const r = await callList({ since: '2026-01-01', before: '2026-05-01' });
  ok('只给时间不给文件夹时按收件箱算（不会偷偷去翻别的夹）：0 封',
    !r.error && r.json.total === 0, JSON.stringify(r.json?.total));
}

// ---------- 发件人 + 时间 ----------
{
  const r = await callList({ from: 'Steam', since: '上个月' });
  ok('from + since 组合：上个月 Steam 1 封',
    !r.error && r.json.total === 1 && allFrom(r.json, 'steam'), JSON.stringify(r.json?.total));
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
    !r.error && r.json.total === 4 && r.json.messages.length === 2, `${r.json?.total}/${r.json?.messages?.length}`);
  ok('还有更多时提示怎么翻页', !r.error && !!r.json.note2, JSON.stringify(r.json?.note2));
}

{
  const r = await callList({ from: 'Steam', pageSize: 2, page: 2 });
  ok('第二页接得上', !r.error && r.json.messages.length === 2, String(r.json?.messages?.length));
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
