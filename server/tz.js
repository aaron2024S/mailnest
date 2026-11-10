// 自然语言时间范围的边界必须落在用户所在时区，不能落在 UTC。
//
// 容器默认 UTC，用户在北京：UTC 零点 = 北京时间早上 8 点。于是
//   「今天」漏掉当天 0-8 点的信（那时还按 UTC 算「昨天」）
//   「上个月」把 1 号 0-8 点的信算成上个月，又把 31 号 8 点之后的算进本月
// 邮件本身的时间一直是 ISO UTC，比较也一直用 ISO 字符串（字典序等于时间序），
// 那些都不用动；只改「某个说法对应的边界怎么算」。
//
// 用标准 TZ 环境变量，而不是自造一个 MAILNEST_TZ：
// 容器、Node、运维脚本、NAS 面板都认这个名字，用户不用记第二套。
//
// 用进程本地时区（new Date(y, m, 1) 那套）是不行的：它依赖系统时区库，
// alpine 默认没装 tzdata，musl 会悄悄按 UTC 处理。所以一律走 Intl 显式
// 指定时区 —— ICU 自带时区数据，跟系统库无关，容器里也准。
//
// 这是个需要显式配置的项：镜像不预设任何地域，也不猜（猜错了比空着更糟）。
// 谁部署谁设 TZ，设错了不崩，日志里提醒一句然后按运行环境时区算。
const TZ_HINT = '要填 IANA 时区名，例如 Asia/Shanghai、Asia/Tokyo、Europe/London、America/New_York';

// 没配 TZ 就用 UTC：中性、确定，也正是容器的实际时区。
// 不去用 Intl.DateTimeFormat().resolvedOptions().timeZone 猜系统时区 ——
// 实测 Windows 上它会返回 'Etc/Unknown'，既不是可读的时区名，也不能拿来解释
// 「上个月」到底怎么算的。时区必须由部署者显式指定。
const FALLBACK_TZ = 'UTC';

const validCache = new Map();
function isValidTz(tz) {
  if (validCache.has(tz)) return validCache.get(tz);
  let ok = true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { ok = false; }
  validCache.set(tz, ok);
  return ok;
}

export function tzName() {
  const v = String(process.env.TZ || '').trim();
  if (!v) return FALLBACK_TZ;
  if (isValidTz(v)) return v;
  // 写错了：不拦启动（容器起不来更像镜像坏了），但绝不静默——
  // 否则「上个月」算错却一切正常，比报错难查得多。
  if (warnedTz !== v) {
    warnedTz = v;
    console.warn(`[mailnest] TZ=${v} 不是合法时区名，改按 ${FALLBACK_TZ} 计算。${TZ_HINT}`);
  }
  return FALLBACK_TZ;
}
let warnedTz = null;


let cachedName = null;
let cachedFmt = null;
function fmt(tz) {
  if (cachedName === tz) return cachedFmt;
  // 非法时区名会在构造时抛 RangeError，早失败好过悄悄退回 UTC
  cachedFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  cachedName = tz;
  return cachedFmt;
}

function partsOf(ts, tz) {
  const d = ts instanceof Date ? ts : new Date(ts);
  const p = {};
  for (const x of fmt(tz).formatToParts(d)) p[x.type] = x.value;
  // Intl 在午夜可能给 24 时（hourCycle），归一到 0
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  return {
    y: Number(p.year), m: Number(p.month) - 1, d: Number(p.day),
    hh: hour, mm: Number(p.minute), ss: Number(p.second),
  };
}

// 某个 UTC 时刻在该时区的偏移（分钟，东八区 = 480）
export function offsetMinutes(ts = new Date(), tz = tzName()) {
  const d = ts instanceof Date ? ts : new Date(ts);
  const p = partsOf(d, tz);
  const asUTC = Date.UTC(p.y, p.m, p.d, p.hh, p.mm, p.ss);
  return Math.round((asUTC - d.getTime()) / 60000);
}

// 该时区下「某年某月某日 00:00」对应的 UTC 时刻。
// y/m/d 允许越界（m=-1 表示上一年 12 月），与 Date.UTC 的进位行为一致。
export function zonedMidnight(y, m, d = 1, tz = tzName()) {
  const guess = Date.UTC(y, m, d);
  const off = offsetMinutes(new Date(guess), tz);
  const t = guess - off * 60000;
  // 夏令时切换当天第一次估算可能差一小时，用第二遍校正
  const off2 = offsetMinutes(new Date(t), tz);
  return new Date(off2 === off ? t : guess - off2 * 60000);
}

// 当前时刻在该时区下的年月日（判断「今年」「上个月」用）
export function zonedNow(tz = tzName()) {
  return partsOf(new Date(), tz);
}

// 启动时调一次：让「TZ 写错」在日志第一行就露出来，而不是等用户问「上个月」
// 才发现差了半天。不抛错——容器起不来会被当成镜像坏了，反而没人去看原因。
export function assertTz() {
  return tzName();
}

// 给人看的区间说明：说的是本地时间
export function fmtZoned(iso, tz = tzName()) {
  if (!iso) return '';
  const p = partsOf(iso, tz);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}`;
}
