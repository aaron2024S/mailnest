// ---------- IMAP IDLE 监听器 ----------
// 每账号一条专用连接（独立于读写池），首连全量同步各文件夹到 SQLite，然后常驻 INBOX 监听：
//  - EXISTS / FLAGS / EXPUNGE → 增量同步 → SQLite → 回调通知（SSE 分发给前端）
//  - 服务器不支持 IDLE → 退化为 5 分钟一次 INBOX STATUS 轻轮询
//  - 断线退避重连（30s 起步封顶 10min），重连后整夹重建（UIDVALIDITY 可能变了）
// 一账号一条连接是邮件客户端的标准形态，不会触发服务商的风控（那是为了替代高频轮询而生的机制）。
import * as cache from './cache.js';
import { createListenerClient, listFolders } from './mail.js';
import { findAccount } from './store.js';

const watchers = new Map(); // `${uid}:${accountId}` -> { running: true, client }
let onEvent = null;         // (event) => void，index.js 注册

export function setEventHandler(fn) { onEvent = fn; }

export function isWatching(uid, accountId) {
  return watchers.has(`${uid}:${accountId}`);
}

export function watchingAccounts(uid) {
  return [...watchers.keys()].filter((k) => k.startsWith(`${uid}:`)).map((k) => k.split(':')[1]);
}

export async function ensureWatcher(uid, accountId) {
  const key = `${uid}:${accountId}`;
  if (watchers.has(key)) return;
  const w = { running: true, client: null };
  watchers.set(key, w);
  runWatcher(uid, accountId, w).catch(() => { /* runWatcher 内部已兜底 */ });
}

export async function stopWatcher(uid, accountId) {
  const key = `${uid}:${accountId}`;
  const w = watchers.get(key);
  if (!w) return;
  w.running = false;
  try { w.client?.close(); } catch { /* ignore */ }
  watchers.delete(key);
}

export async function stopUserWatchers(uid) {
  for (const accountId of watchingAccounts(uid)) await stopWatcher(uid, accountId);
}

// 进程退出用：把所有监听连接一次性关掉（不逐个 await，退出路径要快）
export function closeAll() {
  for (const [key, w] of watchers) {
    w.running = false;
    try { w.client?.close(); } catch { /* ignore */ }
    watchers.delete(key);
  }
}

// 按需整夹重同步（刷新按钮 / 缓存未命中兜底）。
// 刻意不复用 watcher 的连接：它被 INBOX 的选中状态占用，切走会破坏 IDLE 监听 —— 临时开一条最稳
export async function resyncFolder(uid, accountId, folderPath) {
  const { client } = await createListenerClient(uid, accountId);
  try {
    await syncFolderSnapshot(uid, accountId, client, folderPath);
  } finally {
    try { client.close(); } catch { /* ignore */ }
  }
}

async function runWatcher(uid, accountId, w) {
  let backoff = 30_000;
  while (w.running) {
    try {
      await watchOnce(uid, accountId, w);
      backoff = 30_000; // 正常退出（stop）才算成功复位
    } catch (e) {
      if (!w.running) return;
      emit(uid, accountId, { type: 'watch-error', message: String(e?.message || e).slice(0, 120) });
      await sleep(Math.min(backoff, 10 * 60_000));
      backoff = Math.min(backoff * 2, 10 * 60_000);
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function emit(uid, accountId, event) {
  try { onEvent?.({ uid, accountId, ...event }); } catch { /* 通知失败不影响监听 */ }
}

async function watchOnce(uid, accountId, w) {
  const acc = findAccount(uid, accountId);
  if (!acc) return; // 账号已删
  const { client } = await createListenerClient(uid, accountId);
  w.client = client;

  // 全量同步所有文件夹的信封（首次/重连）。
  // 逐夹容错：某个夹（尤其 outlook 的大归档）超时/出错，只跳过它，不能让整个快照循环作废——
  // 否则重连后从头再拉，排在后面的夹永远建不上索引，前端点一次夹就直拉一次服务器
  const folders = await listFolders(uid, accountId);
  const failed = [];
  let done = 0;
  for (const f of folders) {
    if (!w.running) { try { client.close(); } catch { /* ignore */ } return; }
    try {
      await syncFolderSnapshot(uid, accountId, client, f.path);
      emit(uid, accountId, { type: 'indexing', folder: f.path, ok: true, done: ++done, total: folders.length });
    } catch (e) {
      failed.push(f.path);
      emit(uid, accountId, { type: 'indexing', folder: f.path, ok: false, done: ++done, total: folders.length });
    }
  }
  // IDLE 起来之后用独立临时连接补刚才失败的夹，不阻塞监听、不打断 INBOX 选中状态
  if (failed.length && w.running) {
    (async () => {
      for (const p of failed) {
        if (!w.running) return;
        try {
          await resyncFolder(uid, accountId, p);
          emit(uid, accountId, { type: 'indexing', folder: p, ok: true, done: folders.length, total: folders.length });
        } catch { /* 下次重连快照再试 */ }
      }
    })();
  }

  const inbox = folders.find((f) => f.path === 'INBOX' || f.special === '\\Inbox') || folders[0];
  if (!inbox) { try { client.close(); } catch { /* ignore */ } return; }

  const lock = await client.getMailboxLock(inbox.path);
  try {
    const supportsIdle = client.capabilities.has('IDLE');
    let lastUid = await maxUid(uid, accountId, inbox.path);

    if (supportsIdle) {
      // 事件驱动的增量同步：imapflow 在命令间隙自动进入/续期 IDLE，这里只挂监听
      client.on('exists', async (data) => {
        try {
          // 拉取新出现的部分：按 UID 区间，过滤掉服务器通配带来的重复
          const fresh = [];
          for await (const msg of client.fetch({ uid: `${lastUid + 1}:*` }, fetchQuery, { uid: true })) {
            if (msg.uid > lastUid) fresh.push(toEnvelope(msg));
          }
          if (fresh.length) {
            lastUid = Math.max(lastUid, ...fresh.map((m) => m.uid));
            cache.upsertEnvelopes(uid, accountId, inbox.path, fresh);
            emit(uid, accountId, {
              type: 'new-mail', folder: inbox.path, count: fresh.length,
              unseen: unseenCount(uid, accountId, inbox.path),
            });
          }
        } catch (e) { emit(uid, accountId, { type: 'sync-error', message: String(e?.message || e).slice(0, 120) }); }
      });

      client.on('flags', async (data) => {
        try {
          if (data?.uid) {
            cache.updateFlags(uid, accountId, inbox.path, [data.uid], { set: [...(data.flags || [])] });
            emit(uid, accountId, { type: 'flags', folder: inbox.path, uids: [data.uid] });
          }
        } catch { /* ignore */ }
      });

      client.on('expunge', async (data) => {
        try {
          // EXPUNGE 只给序号不给 UID，缓存里按信封数量对不上时靠下次全量校准；
          // 简单可靠的近似：INBOX 整夹快照重拉（一条命令范围查询，代价可接受）
          await syncFolderSnapshot(uid, accountId, client, inbox.path);
          emit(uid, accountId, { type: 'expunge', folder: inbox.path });
        } catch { /* ignore */ }
      });

      // idle() 在 IDLE 结束时 resolve，循环续期直到 stop；连续失败时退避，避免紧循环
      let fails = 0;
      while (w.running) {
        try {
          await client.idle();
          fails = 0;
        } catch {
          if (!w.running) break;
          await sleep(Math.min(1000 * 2 ** fails++, 60_000));
        }
      }
    } else {
      // 服务器不支持 IDLE：轻轮询 STATUS（不打断当前会话，也不占带宽）
      while (w.running) {
        await sleep(5 * 60_000);
        if (!w.running) break;
        const st = await client.status(inbox.path, { messages: true, unseen: true });
        const meta = cache.getDb(uid).prepare(
          'SELECT total, unseen FROM folders WHERE account_id = ? AND path = ?'
        ).get(accountId, inbox.path);
        if (meta && (st.messages !== meta.total || st.unseen !== meta.unseen)) {
          await syncFolderSnapshot(uid, accountId, client, inbox.path);
          const now = cache.getDb(uid).prepare(
            'SELECT unseen FROM folders WHERE account_id = ? AND path = ?'
          ).get(accountId, inbox.path);
          emit(uid, accountId, { type: 'new-mail', folder: inbox.path, count: Math.max(0, st.messages - meta.total), unseen: now?.unseen ?? st.unseen });
        }
      }
    }
  } finally {
    lock.release();
    try { client.close(); } catch { /* ignore */ }
  }
}

const fetchQuery = {
  uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true,
};

function toEnvelope(msg) {
  const env = msg.envelope || {};
  return {
    uid: msg.uid,
    from: env.from?.[0] ? { name: env.from[0].name || '', address: env.from[0].address || '' } : { name: '', address: '' },
    to: (env.to || []).map((t) => ({ name: t.name || '', address: t.address || '' })),
    subject: env.subject || '(无主题)',
    date: msg.internalDate ? msg.internalDate.toISOString() : null,
    flags: [...msg.flags],
    size: msg.size || 0,
    hasAttachment: hasAttachment(msg.bodyStructure),
  };
}

function hasAttachment(node) {
  if (!node) return false;
  if ((node.disposition || '').toLowerCase() === 'attachment') return true;
  return (node.childNodes || []).some(hasAttachment);
}

// 整夹快照：status 拿 uidvalidity/uidNext/messages → 决定「跳过 / 只拉新增 / 全量校准」。
// 每 500 封 flush 一次：大夹子（outlook 归档几万封）同步到一半就有部分索引可用，内存也不积压
const SNAPSHOT_BATCH = 500;

// 同步策略：本地完整索引 + UIDVALIDITY 未变时，用 UIDNEXT/MESSAGES 判断能不能少干活。
// 纯函数，便于把「跳过 / 增量 / 全量」的边界单独测掉（这是最容易出错的一段）。
export function decideSync(meta, st) {
  if (!meta || !st) return { mode: 'full' };
  if (!meta.fullIndex) return { mode: 'full' }; // 局部索引中间有洞，只能全量补
  const uv = st.uidValidity != null ? Number(st.uidValidity) : null;
  if (meta.uidvalidity == null || uv == null || Number(meta.uidvalidity) !== uv) return { mode: 'full' };
  const serverMax = (st.uidNext || 0) - 1;
  if (st.messages === meta.total && serverMax <= meta.maxUid) return { mode: 'skip' };
  if (st.messages > meta.total && serverMax > meta.maxUid) {
    return { mode: 'incremental', range: `${meta.maxUid + 1}:*`, minUid: meta.maxUid };
  }
  // 数量对不上（有删除/移动，或新增与删除同时发生）→ 全量校准，顺带 prune
  return { mode: 'full' };
}

export async function syncFolderSnapshot(uid, accountId, client, folderPath, { force = false } = {}) {
  const lock = await client.getMailboxLock(folderPath);
  try {
    // SELECT 已经带回 uidValidity/uidNext，但 IDLE 期间服务器推的 EXISTS 不一定同步 uidNext，
    // 所以显式 STATUS 一次 —— 一条命令换掉后面几万条 envelope 的重传，很划算
    let st = null;
    if (!force) {
      try {
        st = await client.status(folderPath, { messages: true, uidNext: true, uidValidity: true });
      } catch { /* 少数服务器对已选中的夹 STATUS 报错，退回全量 */ }
    }
    const plan = decideSync(cache.getFolderSync(uid, accountId, folderPath), st);
    const uidvalidity = st?.uidValidity != null ? Number(st.uidValidity) : null;

    if (plan.mode === 'skip') {
      cache.touchFolder(uid, accountId, folderPath);
      return { mode: 'skip', fetched: 0 };
    }
    if (plan.mode === 'incremental') {
      const { count } = await fetchIntoCache(uid, accountId, client, folderPath, {
        range: plan.range, uidvalidity, minUid: plan.minUid,
      });
      // 拉完数量仍对不上 ⇒ 这期间还有删除/移动，全量校准一次
      if (cache.folderTotal(uid, accountId, folderPath) === st.messages) {
        cache.markFullIndex(uid, accountId, folderPath, true);
        return { mode: 'incremental', fetched: count };
      }
    }
    const out = await fullSync(uid, accountId, client, folderPath, uidvalidity
      ?? (client.mailbox?.uidValidity != null ? Number(client.mailbox.uidValidity) : null));
    return { mode: 'full', ...out };
  } finally {
    lock.release();
  }
}

// 全量校准：清空（仅 uidvalidity 变了时）→ 分批拉全部信封 → 删掉服务器已不存在的 uid。
// 中途失败时 full_index 保持 0，下次连接会重跑全量，不会留下「以为是完整的局部索引」。
async function fullSync(uid, accountId, client, folderPath, uidvalidity) {
  const replaceAll = cache.getUidvalidity(uid, accountId, folderPath) !== uidvalidity;
  cache.markFullIndex(uid, accountId, folderPath, false);
  if (replaceAll) {
    cache.clearFolder(uid, accountId, folderPath); // uid 全部重排，旧行没意义
    cache.markFolderStale(uid, accountId, folderPath); // 让列表回退直拉，而不是显示空
  }
  const { count, seen } = await fetchIntoCache(uid, accountId, client, folderPath, { range: '1:*', uidvalidity });
  // 同一 uidvalidity 下 upsert 不会删掉「别的客户端删掉的信」，这里补齐
  const pruned = replaceAll ? 0 : cache.pruneFolder(uid, accountId, folderPath, seen);
  cache.setUidvalidity(uid, accountId, folderPath, uidvalidity);
  cache.markFullIndex(uid, accountId, folderPath, true);
  return { fetched: count, pruned };
}

async function fetchIntoCache(uid, accountId, client, folderPath, { range, uidvalidity, minUid = 0 }) {
  const seen = [];
  let count = 0;
  let batch = [];
  const flush = () => {
    if (!batch.length) return;
    cache.upsertEnvelopes(uid, accountId, folderPath, batch, uidvalidity);
    count += batch.length;
    batch = [];
  };
  for await (const msg of client.fetch(range, fetchQuery)) {
    if (msg.uid <= minUid) continue;
    const env = toEnvelope(msg);
    seen.push(env.uid);
    batch.push(env);
    if (batch.length >= SNAPSHOT_BATCH) flush();
  }
  flush();
  return { count, seen };
}

function maxUid(uid, accountId, folderPath) {
  const row = cache.getDb(uid).prepare(
    'SELECT MAX(uid) AS m FROM messages WHERE account_id = ? AND folder = ?'
  ).get(accountId, folderPath);
  return row?.m || 0;
}

function unseenCount(uid, accountId, folderPath) {
  const row = cache.getDb(uid).prepare(
    'SELECT unseen FROM folders WHERE account_id = ? AND path = ?'
  ).get(accountId, folderPath);
  return row?.unseen || 0;
}
