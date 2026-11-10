// HTML → 纯文本。读信和建索引共用同一份实现，避免「读的时候有正文、搜的时候是空」。
//
// 2026-11-10 定位到的真实事故：cache.putBody 只索引 body.text，而很多邮件（银行账单、
// 12306 发票）是 HTML-only，text 为空、内容全在 html 里。结果正文进了库却搜不到——
// 用户搜「G3120」明明正文写着，返回 0 封。
//
// 表格必须保留行列：原来的实现只把 </p></div></tr> 换成换行，单元格之间的 </td>
// 直接删掉，于是「发票号码 | 乘车日期 | 车次 | 发到站」变成「26119…2026年04月15日G745北京南-苏州北」
// 挤成一行，或者标签一列、数值另一列，对不上号。招行账单就是被这么读坏的：
// 拿到的是一串光秃秃的数字，1686.68 到底是「应还」还是「消费合计」得靠求和反推。
// 现在单元格之间补 ' | '，一行一条，标签和数值天然对齐。

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–', middot: '·', times: '×',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => (ENTITIES[name.toLowerCase()] ?? m));
}

function safeChar(code) {
  try { return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''; } catch { return ''; }
}

// 一行里的收尾整理：合并连续空格、清掉空单元格留下的 `| | |`、去掉首尾竖线
function cleanLine(line) {
  let s = ` ${line} `;
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/(\s*\|\s*){2,}/g, ' | ');
  s = s.replace(/^\s*\|\s*|\s*\|\s*$/g, '');
  s = s.replace(/\s*\|\s*$/g, '');
  return s.trim();
}

export function htmlToText(html) {
  let s = String(html || '');
  if (!s) return '';
  // 脚本/样式/头部整块丢掉（邮件模板里 style 常几千字，进正文毫无意义）
  s = s.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // 表格：单元格补分隔符，行末换行 —— 必须在去标签之前做
  s = s.replace(/<\/t[dh]\s*>/gi, ' | ');
  s = s.replace(/<\/tr\s*>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<hr\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|h[1-6]|table|thead|tbody|section|article|blockquote|dd|dt)\s*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '- ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  const lines = s.split('\n').map(cleanLine);
  // 连续空行压成一个，首尾空行去掉
  const out = [];
  for (const l of lines) {
    if (!l && out[out.length - 1] === '') continue;
    out.push(l);
  }
  return out.join('\n').trim();
}

// 给索引和摘要用：正文可能只有 html 的情况统一从这两处取值
export function bodyTextOf(parsed) {
  const t = String(parsed?.text || '').trim();
  if (t) return t;
  return htmlToText(parsed?.html || '');
}
