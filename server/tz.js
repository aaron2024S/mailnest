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
// 但只读 TZ 还不够。进程的本地时区（new Date(y, m, 1) 那套）依赖系统时区库，
// alpine 默认没装 tzdata，此时 musl 会悄悄按 UTC 处理；而 TZ 写成非法名时
// Node 也不报错，直接沿用系统默认。两种情况的共同点是「不报错、结果错」。
// 所以我们不用进程本地时区，一律走 Intl 显式指定时区（ICU 自带时区数据，
// 与系统库无关），并在启动时校验一次，写错就当场失败。
const DEFAULT_TZ = 'Asia/Shanghai';

export function tzName() {
  const v = String(process.env.TZ || '').trim();
  return v || DEFAULT_TZ;
}

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

// 启动时校验：TZ 写错不能等到用户问「上个月」才炸，也不能悄悄按 UTC 算
export function assertTz(tz = tzName()) {
  let valid = true;
  try { fmt(tz); } catch { valid = false; }
  if (!valid) {
    throw new Error(
      `TZ 时区名不合法：${JSON.stringify(tz)}。`
      + '要填 IANA 时区名，例如 Asia/Shanghai、Asia/Tokyo、Europe/London、America/New_York。',
    );
  }
  return tz;
}

// 给人看的区间说明：说的是本地时间
export function fmtZoned(iso, tz = tzName()) {
  if (!iso) return '';
  const p = partsOf(iso, tz);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}`;
}
