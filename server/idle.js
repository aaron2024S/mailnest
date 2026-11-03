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

// 整夹快照：status 拿 uidvalidity → fetch 全部信封 → 全量替换缓存。
// 每 500 封 flush 一次：大夹子（outlook 归档几万封）同步到一半就有部分索引可用，内存也不积压
const SNAPSHOT_BATCH = 500;

async function syncFolderSnapshot(uid, accountId, client, folderPath) {
  const lock = await client.getMailboxLock(folderPath);
  try {
    const uidvalidity = client.mailbox?.uidValidity != null ? Number(client.mailbox.uidValidity) : null;
    const replaceAll = cache.getUidvalidity(uid, accountId, folderPath) !== uidvalidity;
    let flushed = false;
    let batch = [];
    const flush = (rows) => {
      // uidvalidity 变了（或首次）→ 整夹重建；之后的部分批次直接追加
      if (replaceAll && !flushed) {
        cache.syncFolderFull(uid, accountId, folderPath, uidvalidity, rows);
        flushed = true;
      } else if (rows.length) {
        cache.upsertEnvelopes(uid, accountId, folderPath, rows, uidvalidity);
      }
    };
    for await (const msg of client.fetch('1:*', fetchQuery)) {
      batch.push(toEnvelope(msg));
      if (batch.length >= SNAPSHOT_BATCH) { flush(batch); batch = []; }
    }
    flush(batch);
    if (!flushed) flush([]); // 空夹也要落一行 folders 记录，标记「已同步过」
  } finally {
    lock.release();
  }
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
