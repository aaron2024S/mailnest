// ---------- 正文预热（本地全量） ----------
// 目标体验：像 Outlook 客户端那样，点任何一封都是本地的速度，而不是等一次 IMAP 往返。
// 信封由 IDLE 同步建好，正文（body 列）一开始全是 NULL —— 这就是天然的待办队列：
// 按 uid 由新到旧逐夹填满，随时可中断、重启自动续上，不需要额外的任务表。
// 独立连接 + 批间小睡，不占用户操作的读写池（否则点开会排在预热后面）。
import { simpleParser } from 'mailparser';
import * as cache from './cache.js';
import { createListenerClient, extractMessage, cacheAttachments } from './mail.js';

const workers = new Map(); // `${uid}:${accountId}` -> { running, client, folder, done, pending }
let onEvent = null;

function envInt(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

// 一次拉几封：太大占内存（大附件邮件），太小往返多
const BATCH = envInt('MAILNEST_PREFETCH_BATCH', 6) || 6;
// 批间停顿：给同账号的用户操作让出带宽（Outlook 一条连接几千封灌满会明显拖慢点信）
const GAP_MS = envInt('MAILNEST_PREFETCH_GAP_MS', 800);

export function setEventHandler(fn) { onEvent = fn; }

function emit(uid, accountId, ev) {
  try { onEvent?.({ uid, accountId, ...ev }); } catch { /* 通知失败不影响预热 */ }
}

export function isPrefetching(uid, accountId) {
  return workers.has(`${uid}:${accountId}`);
}

export function status(uid) {
  return [...workers.entries()]
    .filter(([k]) => k.startsWith(`${uid}:`))
    .map(([k, w]) => ({ accountId: k.slice(uid.length + 1), folder: w.folder, done: w.done, pending: w.pending }));
}

export function ensurePrefetch(uid, accountId) {
  const key = `${uid}:${accountId}`;
  if (workers.has(key)) return;
  const w = { running: true, client: null, folder: null, done: 0, pending: 0 };
  workers.set(key, w);
  run(uid, accountId, w).catch(() => { /* run 内部已兜底 */ });
}

// 新邮件到达 / 缓存被清空后立刻叫醒（否则要等下一轮空闲轮询）
export function kick(uid, accountId) {
  const w = workers.get(`${uid}:${accountId}`);
  if (w?._wake) w._wake();
}

export function stopPrefetch(uid, accountId) {
  const key = `${uid}:${accountId}`;
  const w = workers.get(key);
  if (!w) return;
  w.running = false;
  w._wake?.();
  try { w.client?.close(); } catch { /* ignore */ }
  workers.delete(key);
}

export function stopUser(uid) {
  for (const accountId of [...workers.keys()].filter((k) => k.startsWith(`${uid}:`)).map((k) => k.split(':')[1])) {
    stopPrefetch(uid, accountId);
  }
}

export function closeAll() {
  for (const [key, w] of workers) {
    w.running = false;
    w._wake?.();
    try { w.client?.close(); } catch { /* ignore */ }
    workers.delete(key);
  }
}

function sleep(ms, w) {
  return new Promise((resolve) => {
    const t = setTimeout(finish, ms);
    function finish() { clearTimeout(t); if (w) w._wake = null; resolve(); }
    if (w) w._wake = finish;
  });
}

async function run(uid, accountId, w) {
  let backoff = 10_000;
  while (w.running) {
    const job = cache.nextPendingFolder(uid, accountId);
    if (!job) {
      // 没有待办：睡一会儿再看（新邮件由 kick 提前叫醒）
      await sleep(10 * 60_000, w);
      continue;
    }
    let client = null;
    try {
      ({ client } = await createListenerClient(uid, accountId));
      w.client = client;
      await fillFolder(uid, accountId, client, job.folder, job.pending, w);
      backoff = 10_000;
      await sleep(GAP_MS, w); // 夹与夹之间也歇一下：别让换夹的连接操作连成串
    } catch (e) {
      if (!w.running) break;
      console.error(`[prefetch] ${accountId} 预热中断（${Math.round(backoff / 1000)}s 后重试）: ${e?.message || e}`);
      emit(uid, accountId, { type: 'prefetch-error', message: String(e?.message || e).slice(0, 120) });
      await sleep(backoff, w);
      backoff = Math.min(backoff * 2, 5 * 60_000);
    } finally {
      w.folder = null;
      try { client?.close(); } catch { /* ignore */ }
      w.client = null;
    }
  }
}

export async function fillFolder(uid, accountId, client, folder, pending, w) {
  w.folder = folder;
  w.pending = pending;
  w.done = 0;
  emit(uid, accountId, { type: 'prefetch', folder, done: 0, pending });

  const lock = await client.getMailboxLock(folder);
  try {
    for (;;) {
      if (!w.running) return;
      const uids = cache.pendingBodies(uid, accountId, folder, BATCH);
      if (!uids.length) break;
      let progressed = 0;
      for await (const msg of client.fetch(uids.join(','), { uid: true, source: true }, { uid: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          cache.putBody(uid, accountId, folder, msg.uid, extractMessage(parsed, { accountId, folder, uid: msg.uid }));
          cacheAttachments(uid, accountId, folder, msg.uid, parsed);
          progressed += 1;
          w.done += 1;
          // 每封完成就推：一批 6 封里有大邮件时，整批可能几十秒，按批推会让进度条看起来"卡死"
          emit(uid, accountId, { type: 'prefetch', folder, done: w.done, pending: w.pending });
        } catch (e) {
          // 单封解析失败：记一次尝试次数，别让一封坏邮件永远堵住队列
          console.error(`[prefetch] ${accountId}/${folder} uid=${msg.uid} 处理失败: ${e?.message || e}`);
          cache.failBody(uid, accountId, folder, msg.uid);
        }
      }
      // 服务器漏发了整批（uid 已被删/移动）：全部记失败，否则死循环
      if (!progressed) {
        for (const u of uids) cache.failBody(uid, accountId, folder, u);
        // 整批无进展必须踩一脚刹车：否则任何系统性失败（解析 bug、服务器抽风）
        // 都会让 worker 毫无间隔地连环换批换夹重建连接，把邮件服务器轰炸到限流，
        // 连累用户自己的正常操作（0.2.0 切文件夹卡住就是这个）
        await sleep(Math.max(GAP_MS, 2000), w);
      }
      emit(uid, accountId, { type: 'prefetch', folder, done: w.done, pending: w.pending });
      if (progressed) await sleep(GAP_MS, w);
    }
    emit(uid, accountId, { type: 'prefetch', folder, done: w.done, pending: 0, finished: true });
  } finally {
    lock.release();
  }
}
