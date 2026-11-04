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

// 整夹同步是重活（几万封要几十秒到几分钟），必须防两件事：
// ① 用户连点刷新 / 多标签页同时请求 → 同一夹只允许一条连接在跑，否则重复拉全量把服务器打满；
// ② 服务器半死不回 → 没有上限就会永远挂着一条连接和一次同步。
// 注意：调用方超时返回后同步仍在后台跑完，这里刻意保留 map 里的登记，避免「超时 → 又开一条」。
const RESYNC_TIMEOUT = Number(process.env.MAILNEST_RESYNC_TIMEOUT_MS) || 5 * 60_000;
const resyncing = new Map(); // `${uid}\0${accountId}\0${folder}` -> Promise

function resyncKey(uid, accountId, folderPath) {
  return `${uid}\u0000${accountId}\u0000${folderPath}`;
}

// 进行中的同步连接：删账号 / 退出时要把它们掐掉，
// 否则同步会在数据删完之后继续往 SQLite 里写回已经删掉的账号
const resyncClients = new Map(); // key -> client

async function runResync(uid, accountId, folderPath) {
  const key = resyncKey(uid, accountId, folderPath);
  const { client } = await createListenerClient(uid, accountId);
  resyncClients.set(key, client);
  let timer;
  try {
    const op = syncFolderSnapshot(uid, accountId, client, folderPath);
    op.catch(() => { /* 超时后成为孤儿，别冒成 unhandledRejection */ });
    await Promise.race([
      op,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(
          new Error('同步超时，稍后会自动重试'), { code: 'SYNC_TIMEOUT' },
        )), RESYNC_TIMEOUT);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    resyncClients.delete(key);
    try { client.close(); } catch { /* ignore */ }
  }
  // 成功才通知：请求可能早就超时返回旧缓存了，前端要靠这条事件补上真正的结果
  emit(uid, accountId, { type: 'folder-synced', folder: folderPath });
}

// 掐掉某账号（或某账号某夹）正在跑的同步：关闭连接即可，run 的 finally 会清理登记
export function cancelResync(uid, accountId = null) {
  const prefix = accountId ? `${uid}\u0000${accountId}\u0000` : `${uid}\u0000`;
  for (const [key, client] of resyncClients) {
    if (!key.startsWith(prefix)) continue;
    try { client.close(); } catch { /* ignore */ }
    resyncClients.delete(key);
  }
}

// waitMs > 0：调用方最多等这么久；超时抛出 code=SYNC_PENDING，但同步在后台继续
export function resyncFolder(uid, accountId, folderPath, { waitMs = 0 } = {}) {
  const key = resyncKey(uid, accountId, folderPath);
  let op = resyncing.get(key);
  if (!op) {
    op = runResync(uid, accountId, folderPath);
    op.then(
      () => resyncing.delete(key),
      () => resyncing.delete(key),
    );
    op.catch(() => { /* 无人 await 时不冒未处理拒绝 */ });
    resyncing.set(key, op);
  }
  if (!waitMs) return op;
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(
      new Error('正在后台同步'), { code: 'SYNC_PENDING' },
    )), waitMs);
  });
  return Promise.race([op, guard]).finally(() => clearTimeout(timer));
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
            cache.upsertEnvelopes(uid, accountId, inbox.path, fresh,
              client.mailbox?.uidValidity != null ? Number(client.mailbox.uidValidity) : null);
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
            const flags = [...(data.flags || [])];
            cache.updateFlags(uid, accountId, inbox.path, [data.uid], { set: flags });
            // 带上新的旗标集合与未读数：前端据此就地改行，不必为一条已读变动重载整个列表
            emit(uid, accountId, {
              type: 'flags', folder: inbox.path, uids: [data.uid], flags,
              unseen: unseenCount(uid, accountId, inbox.path),
            });
          }
        } catch { /* ignore */ }
      });

      client.on('expunge', async (data) => {
        try {
          // EXPUNGE 只给序号不给 UID：对账一次（decideSync 发现数量对不上会全量校准 + prune）。
          // ⚠ 必须走不取锁的 pollInboxInline —— 本连接的 INBOX 锁正被 watcher 持着，
          //   syncFolderSnapshot 再去 getMailboxLock 会排在锁队列里永远等不到（死锁）
          const r = await pollInboxInline(uid, accountId, client, inbox.path);
          // 带上未读数：别的客户端删信/标已读后，左栏角标要跟着动，否则一直停在旧数字
          emit(uid, accountId, {
            type: 'expunge', folder: inbox.path,
            unseen: unseenCount(uid, accountId, inbox.path),
          });
          if (r && r.fetched > 0) {
            emit(uid, accountId, { type: 'new-mail', folder: inbox.path, count: r.fetched, unseen: unseenCount(uid, accountId, inbox.path) });
          }
        } catch { /* ignore */ }
      });

      // 主循环：等 IDLE 推送，但最多等 POLL_MS 就主动对账一次。
      // QQ / 163 等国内服务器会常驻 IDLE 却不推 EXISTS —— 只信推送的话永远收不到新邮件。
      // 对账走 decideSync：没变化只花一条 STATUS，有变化增量拉取，正常服务器几乎零成本。
      const POLL_MS = Number(process.env.MAILNEST_IDLE_POLL_MS) || 60_000;
      let fails = 0;      // idle() 连续失败
      let pollFails = 0;  // 对账连续失败（连接半死的信号）
      let idleP = null;   // 未 resolve 的 idle()，跨轮复用避免重复进入 IDLE
      while (w.running) {
        if (!idleP) idleP = client.idle().then(() => 'idle', () => 'idle-failed');
        const why = await Promise.race([idleP, sleep(POLL_MS).then(() => 'poll')]);
        if (!w.running) break;
        if (why === 'poll') {
          try {
            const r = await pollInboxInline(uid, accountId, client, inbox.path);
            pollFails = 0;
            if (r && r.fetched > 0) {
              console.log(`[mailnest] IDLE 静默（QQ/163 等常见），轮询对账补上 ${accountId} ${inbox.path} 新增 ${r.fetched} 封`);
              emit(uid, accountId, { type: 'new-mail', folder: inbox.path, count: r.fetched, unseen: unseenCount(uid, accountId, inbox.path) });
            } else if (r && r.pruned > 0) {
              // 别的客户端删了信：缓存已经 prune 掉，得让前端把行也收掉
              emit(uid, accountId, {
                type: 'expunge', folder: inbox.path,
                unseen: unseenCount(uid, accountId, inbox.path),
              });
            }
          } catch (e) {
            if (++pollFails >= 3) throw new Error('轮询对账连续失败，重开连接'); // runWatcher 退避重连
            console.log(`[mailnest] 轮询对账失败(${accountId})：${String(e?.message || e).slice(0, 120)}`);
          }
          continue; // 对账命令把 IDLE 打断后 idleP 会自行 resolve，下轮直接复用
        }
        if (why === 'idle-failed') {
          // 服务器拒绝 IDLE（或连接已死）：退避重试，连续失败就整体重连换条命
          if (++fails >= 5) throw new Error('IDLE 持续失败，重开连接');
          await sleep(Math.min(1000 * 2 ** fails, 60_000));
        } else {
          fails = 0;
        }
        idleP = null;
      }
    } else {
      // 服务器不支持 IDLE：轻轮询对账（不打断当前会话，也不占带宽）
      while (w.running) {
        await sleep(5 * 60_000);
        if (!w.running) break;
        const r = await pollInboxInline(uid, accountId, client, inbox.path);
        if (r && r.fetched > 0) {
          emit(uid, accountId, { type: 'new-mail', folder: inbox.path, count: r.fetched, unseen: unseenCount(uid, accountId, inbox.path) });
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

// 不取锁的 INBOX 对账：watcher 自己持有本连接的 INBOX 锁，再调 syncFolderSnapshot 会让
// 新的 getMailboxLock 排进锁队列、永远等不到释放（imapflow 的锁不重入）→ 死锁。
// 这里直接用当前连接 STATUS + decideSync，需要拉取就直接 fetch（命令会自动打断 IDLE）。
// 返回结构与 syncFolderSnapshot 一致：{ mode, fetched }
export async function pollInboxInline(uid, accountId, client, folderPath) {
  let st = null;
  try {
    st = await client.status(folderPath, { messages: true, uidNext: true, uidValidity: true });
  } catch { return null; /* 少数服务器对已选中的夹 STATUS 报错，下一轮再试 */ }
  const plan = decideSync(cache.getFolderSync(uid, accountId, folderPath), st);
  if (plan.mode === 'skip') return { mode: 'skip', fetched: 0 };
  const uidvalidity = st?.uidValidity != null ? Number(st.uidValidity) : null;
  if (plan.mode === 'incremental') {
    const { count } = await fetchIntoCache(uid, accountId, client, folderPath, {
      range: plan.range, uidvalidity, minUid: plan.minUid,
    });
    if (cache.folderTotal(uid, accountId, folderPath) === st.messages) {
      cache.markFullIndex(uid, accountId, folderPath, true);
      return { mode: 'incremental', fetched: count };
    }
  }
  const out = await fullSync(uid, accountId, client, folderPath,
    uidvalidity ?? (client.mailbox?.uidValidity != null ? Number(client.mailbox.uidValidity) : null));
  return { mode: 'full', ...out };
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
