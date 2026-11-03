// ---------- SQLite 缓存层 ----------
// 每用户一个 cache.db（node:sqlite 内建模块，零依赖），缓存信封摘要 + 正文。
// 写入路径：IDLE 增量同步、列表/正文访问时的 write-through、写操作（旗标/移动/删除）回写。
// 一致性：folders.uidvalidity 变化或收不到增量时整夹重建；缓存只做加速，永远可被直拉数据覆盖。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { userDir } from './store.js';

const dbs = new Map(); // uid -> DatabaseSync

const SCHEMA = `
CREATE TABLE IF NOT EXISTS folders (
  account_id  TEXT    NOT NULL,
  path        TEXT    NOT NULL,
  uidvalidity INTEGER,
  total       INTEGER NOT NULL DEFAULT 0,
  unseen      INTEGER NOT NULL DEFAULT 0,
  synced_at   INTEGER,
  -- 1 = 这个夹的信封是完整索引（整夹快照跑完过）。
  -- 只有完整索引才允许做 UIDNEXT 增量：局部索引（直拉兜底只存了 50 封）中间有大段空洞，
  -- 光拉「最大 UID 之后」永远补不回来。
  full_index  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, path)
);
CREATE TABLE IF NOT EXISTS messages (
  account_id TEXT    NOT NULL,
  folder     TEXT    NOT NULL,
  uid        INTEGER NOT NULL,
  envelope   TEXT    NOT NULL, -- JSON：from/to/subject/date/size/hasAttachment（与 /api/messages 输出同构）
  flags      TEXT    NOT NULL, -- JSON 字符串数组
  body       TEXT,             -- JSON：正文 + 附件元数据，NULL = 尚未拉取
  fetched_at INTEGER,
  body_tries INTEGER NOT NULL DEFAULT 0, -- 正文拉取失败次数，达到上限就不再重试（坏邮件不堵队列）
  PRIMARY KEY (account_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS idx_msg_uid ON messages (account_id, folder, uid DESC);
CREATE TABLE IF NOT EXISTS folder_lists (
  account_id TEXT PRIMARY KEY,
  folders    TEXT NOT NULL, -- JSON：[{path,name,delim,special,subscribed}]
  synced_at  INTEGER
);
-- 全文检索：全量缓存正文后，LIKE 扫 JSON 是 O(全库文本)，几万封就不可用了。
-- fts_keys 用自增 rid 对齐 FTS5 的 rowid（messages 是复合主键、INSERT OR REPLACE 会换 rowid，不能直接用）。
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
  subject, sender, recipients, body, tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS fts_keys (
  rid        INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT    NOT NULL,
  folder     TEXT    NOT NULL,
  uid        INTEGER NOT NULL,
  UNIQUE (account_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS idx_ftsk_folder ON fts_keys (account_id, folder);
`;

// 老库升级：CREATE TABLE IF NOT EXISTS 不会给已有表补列
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!cols.includes('body_tries')) {
    db.exec('ALTER TABLE messages ADD COLUMN body_tries INTEGER NOT NULL DEFAULT 0');
  }
  const fcols = db.prepare('PRAGMA table_info(folders)').all().map((c) => c.name);
  if (!fcols.includes('full_index')) {
    // 老库里的夹都是跑的整夹快照（没有其他写入路径），一律按完整索引对待
    db.exec('ALTER TABLE folders ADD COLUMN full_index INTEGER NOT NULL DEFAULT 1');
  }
}

export function getDb(uid) {
  let db = dbs.get(uid);
  if (db) return db;
  const dir = userDir(uid);
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, 'cache.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  migrate(db);
  dbs.set(uid, db);
  return db;
}

export function closeDb(uid) {
  const db = dbs.get(uid);
  if (db) { try { db.close(); } catch { /* ignore */ } dbs.delete(uid); }
}

// 进程退出用：把打开的所有用户库都关掉（WAL 需要正常 close 才干净）
export function closeAll() {
  for (const uid of [...dbs.keys()]) closeDb(uid);
}

// ---------- 文件夹登记 ----------
export function setUidvalidity(uid, accountId, folderPath, uidvalidity) {
  getDb(uid).prepare(`
    INSERT INTO folders (account_id, path, uidvalidity) VALUES (?, ?, ?)
    ON CONFLICT(account_id, path) DO UPDATE SET uidvalidity = excluded.uidvalidity
  `).run(accountId, folderPath, uidvalidity ?? null);
}

export function getUidvalidity(uid, accountId, folderPath) {
  const row = getDb(uid).prepare('SELECT uidvalidity FROM folders WHERE account_id = ? AND path = ?')
    .get(accountId, folderPath);
  return row?.uidvalidity ?? null;
}

// 增量同步的判定依据：本地这个夹到底完整不完整、同步到哪个 UID 了
export function getFolderSync(uid, accountId, folderPath) {
  const row = getDb(uid).prepare(`
    SELECT uidvalidity, total, full_index, synced_at FROM folders WHERE account_id = ? AND path = ?
  `).get(accountId, folderPath);
  if (!row) return null;
  const maxUid = getDb(uid).prepare(
    'SELECT MAX(uid) AS m FROM messages WHERE account_id = ? AND folder = ?'
  ).get(accountId, folderPath)?.m || 0;
  return { uidvalidity: row.uidvalidity, total: row.total, fullIndex: !!row.full_index, maxUid, syncedAt: row.synced_at };
}

export function markFullIndex(uid, accountId, folderPath, on = true) {
  getDb(uid).prepare(`
    INSERT INTO folders (account_id, path, full_index) VALUES (?, ?, ?)
    ON CONFLICT(account_id, path) DO UPDATE SET full_index = excluded.full_index
  `).run(accountId, folderPath, on ? 1 : 0);
}

// 校验过但没有任何变化：只刷新时间戳（下次判断仍按内容比，不靠时间）
export function touchFolder(uid, accountId, folderPath) {
  getDb(uid).prepare('UPDATE folders SET synced_at = ? WHERE account_id = ? AND path = ?')
    .run(Date.now(), accountId, folderPath);
}

// 整夹重建期间把 synced_at 清掉：别让列表以为「这个夹真的空了」而返回空页，
// 让调用方回退直拉，用户看到的始终是服务器上的真实状态
export function markFolderStale(uid, accountId, folderPath) {
  getDb(uid).prepare('UPDATE folders SET synced_at = NULL WHERE account_id = ? AND path = ?')
    .run(accountId, folderPath);
}

export function folderTotal(uid, accountId, folderPath) {
  return getDb(uid).prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND folder = ?'
  ).get(accountId, folderPath).n;
}

// 全量校准的最后一步：服务器上已经没有的 uid，本地必须跟着删。
// 之前这里只做 upsert，导致「在手机/网页上删掉的邮件」在本地永远是幽灵行 ——
// 只有 uidvalidity 变化（几乎不会）才会重建。
export function pruneFolder(uid, accountId, folderPath, keepUids) {
  const keep = new Set(keepUids.map(Number));
  const rows = getDb(uid).prepare('SELECT uid FROM messages WHERE account_id = ? AND folder = ?')
    .all(accountId, folderPath);
  const gone = rows.map((r) => r.uid).filter((u) => !keep.has(u));
  if (gone.length) removeUids(uid, accountId, folderPath, gone);
  return gone.length;
}

// ---------- 整夹同步 ----------
// 全量替换一个文件夹的信封（首次同步 / uidvalidity 变化 / 手动强制刷新）
export function syncFolderFull(uid, accountId, folderPath, uidvalidity, messages) {
  const db = getDb(uid);
  const tx = db;
  tx.exec('BEGIN');
  try {
    ftsDropFolder(tx, accountId, folderPath);
    tx.prepare('DELETE FROM messages WHERE account_id = ? AND folder = ?').run(accountId, folderPath);
    const ins = tx.prepare(`
      INSERT OR REPLACE INTO messages (account_id, folder, uid, envelope, flags, body, fetched_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `);
    for (const m of messages) {
      const env = envelopeOf(m);
      ins.run(accountId, folderPath, m.uid, JSON.stringify(env), JSON.stringify(m.flags || []), Date.now());
      ftsUpsert(tx, accountId, folderPath, m.uid, { subject: env.subject, sender: senderText(env.from), recipients: recipientsText(env.to), body: '' });
    }
    recountInTx(tx, accountId, folderPath, uidvalidity);
    tx.exec('COMMIT');
  } catch (e) {
    try { tx.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

// 增量 upsert（IDLE 推来的新邮件 / 按需拉取一页后的 write-through）
export function upsertEnvelopes(uid, accountId, folderPath, messages, uidvalidity = null) {
  const db = getDb(uid);
  db.exec('BEGIN');
  try {
    const ins = db.prepare(`
      INSERT INTO messages (account_id, folder, uid, envelope, flags, body, fetched_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(account_id, folder, uid) DO UPDATE SET
        envelope = excluded.envelope, flags = excluded.flags, fetched_at = excluded.fetched_at
    `);
    const seen = db.prepare('SELECT 1 AS x FROM messages WHERE account_id = ? AND folder = ? AND uid = ?');
    for (const m of messages) {
      // 已存在的行：正文不能因为信封刷新被重建，FTS 也不重复写（否则会把正文索引冲掉）
      const known = seen.get(accountId, folderPath, m.uid);
      const env = envelopeOf(m);
      ins.run(accountId, folderPath, m.uid, JSON.stringify(env), JSON.stringify(m.flags || []), Date.now());
      if (!known) {
        ftsUpsert(db, accountId, folderPath, m.uid, { subject: env.subject, sender: senderText(env.from), recipients: recipientsText(env.to), body: '' });
      }
    }
    recountInTx(db, accountId, folderPath, uidvalidity);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

function envelopeOf(m) {
  return {
    uid: m.uid,
    from: m.from || { name: '', address: '' },
    to: m.to || [],
    subject: m.subject || '(无主题)',
    date: m.date || null,
    size: m.size || 0,
    hasAttachment: !!m.hasAttachment,
  };
}

// ---------- 全文索引维护 ----------
// unicode61 把连续中文当成一个 token（「今天天气不错」整块），直接搜「天气」匹配不到。
// 入库前把 CJK 逐字隔开、查询侧同样处理，就能按任意中文子串检索。
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g;

function ftsText(s) {
  return String(s || '').replace(CJK, (c) => ` ${c} `).replace(/\s+/g, ' ').trim();
}

function senderText(from) {
  return from ? `${from.name || ''} ${from.address || ''}`.trim() : '';
}

function recipientsText(to) {
  return (to || []).map((t) => `${t.name || ''} ${t.address || ''}`).join(' ').trim();
}

function ftsUpsert(db, accountId, folder, uid, { subject, sender, recipients, body }) {
  const ins = db.prepare('INSERT OR IGNORE INTO fts_keys (account_id, folder, uid) VALUES (?, ?, ?)')
    .run(accountId, folder, uid);
  const rid = ins.changes
    ? Number(ins.lastInsertRowid)
    : db.prepare('SELECT rid FROM fts_keys WHERE account_id = ? AND folder = ? AND uid = ?')
      .get(accountId, folder, uid)?.rid;
  if (!rid) return;
  db.prepare('INSERT OR REPLACE INTO msg_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)')
    .run(rid, ftsText(subject), ftsText(sender), ftsText(recipients), ftsText(body));
}

function ftsDropRows(db, rows) {
  const del = db.prepare('DELETE FROM msg_fts WHERE rowid = ?');
  for (const r of rows) del.run(r.rid);
}

function ftsDropFolder(db, accountId, folder) {
  const rows = db.prepare('SELECT rid FROM fts_keys WHERE account_id = ? AND folder = ?').all(accountId, folder);
  ftsDropRows(db, rows);
  db.prepare('DELETE FROM fts_keys WHERE account_id = ? AND folder = ?').run(accountId, folder);
}

function ftsDropMessage(db, accountId, folder, uid) {
  const rows = db.prepare('SELECT rid FROM fts_keys WHERE account_id = ? AND folder = ? AND uid = ?').all(accountId, folder, uid);
  ftsDropRows(db, rows);
  db.prepare('DELETE FROM fts_keys WHERE account_id = ? AND folder = ? AND uid = ?').run(accountId, folder, uid);
}

// 老库升级：messages 里已有几千封、fts_keys 还是空的 → 一次性回填（后台跑，不阻塞请求）
export function rebuildFts(uid) {
  const db = getDb(uid);
  const total = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const indexed = db.prepare('SELECT COUNT(*) AS n FROM fts_keys').get().n;
  if (!total || indexed) return 0;
  const rows = db.prepare('SELECT account_id, folder, uid, envelope, body FROM messages').all();
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      let env = {};
      let text = '';
      try { env = JSON.parse(r.envelope) || {}; } catch { /* 损坏的信封跳过正文部分 */ }
      if (r.body) { try { text = JSON.parse(r.body)?.text || ''; } catch { /* ignore */ } }
      ftsUpsert(db, r.account_id, r.folder, r.uid, {
        subject: env.subject, sender: senderText(env.from), recipients: recipientsText(env.to), body: text,
      });
      n += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  return n;
}

function ftsReady(db) {
  return (db.prepare('SELECT 1 AS x FROM fts_keys LIMIT 1').get()?.x || 0) === 1;
}

function ftsQuery(q) {
  const terms = ftsText(q).split(' ').filter(Boolean);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}

function recountInTx(db, accountId, folderPath, uidvalidity = null) {
  // 用 json_each 精确匹配旗标（LIKE 会被 JSON 转义的反斜杠坑掉）；未读 = 没有 \Seen 旗标
  const c = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM json_each(flags) WHERE value = ?) THEN 1 ELSE 0 END) AS unseen
    FROM messages WHERE account_id = ? AND folder = ?
  `).get('\\Seen', accountId, folderPath);
  db.prepare(`
    INSERT INTO folders (account_id, path, uidvalidity, total, unseen, synced_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, path) DO UPDATE SET
      uidvalidity = COALESCE(excluded.uidvalidity, folders.uidvalidity),
      total = excluded.total, unseen = excluded.unseen, synced_at = excluded.synced_at
  `).run(accountId, folderPath, uidvalidity, c.total, c.unseen || 0, Date.now());
}

// 删除若干 uid（服务器 EXPUNGE / 本地删除回写）
export function removeUids(uid, accountId, folderPath, uids) {
  if (!uids.length) return;
  const db = getDb(uid);
  const del = db.prepare('DELETE FROM messages WHERE account_id = ? AND folder = ? AND uid = ?');
  db.exec('BEGIN');
  try {
    for (const u of uids) { del.run(accountId, folderPath, u); ftsDropMessage(db, accountId, folderPath, u); }
    recountInTx(db, accountId, folderPath);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

// ---------- 读取 ----------
export function getPage(uid, accountId, folderPath, { page = 1, pageSize = 50 } = {}) {
  const db = getDb(uid);
  const meta = db.prepare('SELECT uidvalidity, total, synced_at FROM folders WHERE account_id = ? AND path = ?')
    .get(accountId, folderPath);
  if (!meta || meta.synced_at == null) return null; // 该文件夹从未同步过 → 调用方回退直拉
  const total = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND folder = ?')
    .get(accountId, folderPath).n;
  const rows = db.prepare(`
    SELECT uid, envelope, flags FROM messages
    WHERE account_id = ? AND folder = ?
    ORDER BY COALESCE(json_extract(envelope, '$.date'), '') DESC, uid DESC
    LIMIT ? OFFSET ?
  `).all(accountId, folderPath, pageSize, (page - 1) * pageSize);
  return {
    total,
    page,
    pageSize,
    uidvalidity: meta.uidvalidity,
    messages: rows.map((r) => ({ ...JSON.parse(r.envelope), flags: JSON.parse(r.flags) })),
  };
}

export function folderCounts(uid) {
  return getDb(uid).prepare('SELECT account_id, path, total, unseen FROM folders').all();
}

// ---------- 文件夹清单缓存 ----------
// 左栏的文件夹列表以前每次都现场 IMAP LIST——outlook 冷连接慢（国内经常 10s+），
// 一超时左栏这个账号就是空的。现在落库：命中直接回，后台静默刷新，失败也不影响显示。
export function getFolders(uid, accountId) {
  const row = getDb(uid).prepare('SELECT folders FROM folder_lists WHERE account_id = ?').get(accountId);
  if (!row) return null;
  try { return JSON.parse(row.folders); } catch { return null; }
}

export function putFolders(uid, accountId, folders) {
  getDb(uid).prepare(`
    INSERT INTO folder_lists (account_id, folders, synced_at) VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET folders = excluded.folders, synced_at = excluded.synced_at
  `).run(accountId, JSON.stringify(folders || []), Date.now());
}

// ---------- 搜索（Agent 用） ----------
// 只在本地缓存里找：信封（主题/发件人/收件人）+ 已缓存过的正文。
// 缓存空的时候调用方应先同步，这里只负责检索，不做网络动作。
function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function searchMessages(uid, accountId, query, { folder = null, limit = 20 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  limit = Math.min(Math.max(1, limit | 0), 50);
  const db = getDb(uid);
  // 有全文索引就走 FTS（几万封也是毫秒级）；索引还没建好时退回 LIKE，保证功能不断
  if (ftsReady(db)) {
    const match = ftsQuery(q);
    if (match) {
      try { return searchFts(db, accountId, folder, q, match, limit); } catch { /* 回退 LIKE */ }
    }
  }
  return searchLike(db, accountId, folder, q, limit);
}

function withSnippet(q, row) {
  const matched = [];
  let text = '';
  if (row.body) { try { text = JSON.parse(row.body)?.text || ''; } catch { /* ignore */ } }
  const env = JSON.parse(row.envelope);
  const low = q.toLowerCase();
  if (String(env.subject || '').toLowerCase().includes(low)) matched.push('subject');
  if (`${env.from?.name || ''} ${env.from?.address || ''}`.toLowerCase().includes(low)) matched.push('from');
  if (JSON.stringify(env.to || []).toLowerCase().includes(low)) matched.push('to');
  if (text.toLowerCase().includes(low)) matched.push('body');
  const out = { folder: row.folder, uid: row.uid, ...env, flags: JSON.parse(row.flags), matched };
  if (matched.includes('body')) {
    const i = text.toLowerCase().indexOf(low);
    const from = Math.max(0, i - 40);
    out.snippet = `${from > 0 ? '…' : ''}${text.slice(from, i + q.length + 60).replace(/\s+/g, ' ').trim()}`;
  }
  return out;
}

function searchFts(db, accountId, folder, q, match, limit) {
  const rows = db.prepare(`
    SELECT m.folder, m.uid, m.envelope, m.flags, m.body
    FROM msg_fts f
    JOIN fts_keys k ON k.rid = f.rowid
    JOIN messages m ON m.account_id = k.account_id AND m.folder = k.folder AND m.uid = k.uid
    WHERE f MATCH ? AND k.account_id = ? AND (? IS NULL OR k.folder = ?)
    ORDER BY COALESCE(json_extract(m.envelope, '$.date'), '') DESC, m.uid DESC
    LIMIT ?
  `).all(match, accountId, folder, folder, limit);
  return rows.map((r) => withSnippet(q, r));
}

function searchLike(db, accountId, folder, q, limit) {
  const pat = `%${likeEscape(q.toLowerCase())}%`;
  const rows = db.prepare(`
    SELECT folder, uid, envelope, flags, body,
           lower(json_extract(envelope, '$.subject'))                                   AS s,
           lower(json_extract(envelope, '$.from.name'))                                 AS fn,
           lower(json_extract(envelope, '$.from.address'))                              AS fa,
           lower(json_extract(envelope, '$.to'))                                        AS t,
           lower(coalesce(json_extract(body, '$.text'), ''))                             AS b
    FROM messages
    WHERE account_id = ?
      AND (? IS NULL OR folder = ?)
      AND ( lower(json_extract(envelope, '$.subject')) LIKE ? ESCAPE '\\'
         OR lower(json_extract(envelope, '$.from.name')) LIKE ? ESCAPE '\\'
         OR lower(json_extract(envelope, '$.from.address')) LIKE ? ESCAPE '\\'
         OR lower(json_extract(envelope, '$.to')) LIKE ? ESCAPE '\\'
         OR lower(coalesce(json_extract(body, '$.text'), '')) LIKE ? ESCAPE '\\' )
    ORDER BY COALESCE(json_extract(envelope, '$.date'), '') DESC, uid DESC
    LIMIT ?
  `).all(accountId, folder, folder, pat, pat, pat, pat, pat, limit);
  return rows.map((r) => withSnippet(q, r));
}

// 该账号是否已经建过索引（没建过就别告诉用户「没搜到」）
export function hasAccountData(uid, accountId) {
  const row = getDb(uid).prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ?').get(accountId);
  return (row?.n || 0) > 0;
}

// ---------- 正文 ----------
export function getBody(uid, accountId, folderPath, messageUid) {
  const row = getDb(uid).prepare(
    'SELECT body, flags FROM messages WHERE account_id = ? AND folder = ? AND uid = ?'
  ).get(accountId, folderPath, messageUid);
  if (!row || row.body == null) return null;
  return { ...JSON.parse(row.body), flags: JSON.parse(row.flags) };
}

// write-through：正文首次拉取后落库（body 对象不含 flags，flags 单独维护）
export function putBody(uid, accountId, folderPath, messageUid, body) {
  const db = getDb(uid);
  db.prepare(`
    UPDATE messages SET body = ?, fetched_at = ?, body_tries = 0
    WHERE account_id = ? AND folder = ? AND uid = ?
  `).run(JSON.stringify(body), Date.now(), accountId, folderPath, messageUid);
  // 正文进库同时进全文索引（主题/收发人沿用信封里已有的）
  try {
    const row = db.prepare('SELECT envelope FROM messages WHERE account_id = ? AND folder = ? AND uid = ?')
      .get(accountId, folderPath, messageUid);
    if (row) {
      const env = JSON.parse(row.envelope);
      ftsUpsert(db, accountId, folderPath, messageUid, {
        subject: env.subject, sender: senderText(env.from), recipients: recipientsText(env.to), body: body?.text || '',
      });
    }
  } catch { /* 索引失败不影响读信，rebuildFts 可重建 */ }
}

// ---------- 正文预热队列（body 为 NULL 即待办） ----------
// 按 uid 倒序 = 由新到旧，正好走 (account_id, folder, uid) 主键索引，不做 JSON 排序
export function pendingBodies(uid, accountId, folderPath, limit = 8) {
  return getDb(uid).prepare(`
    SELECT uid FROM messages
    WHERE account_id = ? AND folder = ? AND body IS NULL AND body_tries < 3
    ORDER BY uid DESC LIMIT ?
  `).all(accountId, folderPath, limit).map((r) => r.uid);
}

// 待办最多的夹优先；MAX(uid) 让近期有来信的夹排在前面
export function nextPendingFolder(uid, accountId) {
  const row = getDb(uid).prepare(`
    SELECT folder, COUNT(*) AS pending FROM messages
    WHERE account_id = ? AND body IS NULL AND body_tries < 3
    GROUP BY folder ORDER BY MAX(uid) DESC LIMIT 1
  `).get(accountId);
  return row?.pending ? { folder: row.folder, pending: row.pending } : null;
}

export function failBody(uid, accountId, folderPath, messageUid) {
  try {
    getDb(uid).prepare(
      'UPDATE messages SET body_tries = body_tries + 1 WHERE account_id = ? AND folder = ? AND uid = ?'
    ).run(accountId, folderPath, messageUid);
  } catch { /* ignore */ }
}

// 清空缓存后允许重新尝试（把失败计数归零）
export function resetBodyTries(uid, accountId = null) {
  const db = getDb(uid);
  if (accountId) db.prepare('UPDATE messages SET body_tries = 0 WHERE account_id = ?').run(accountId);
  else db.exec('UPDATE messages SET body_tries = 0');
}

// 缓存概览（设置页展示 + 空间焦虑的解药）
export function stats(uid) {
  const db = getDb(uid);
  const rows = db.prepare(`
    SELECT account_id,
           COUNT(*) AS total,
           SUM(CASE WHEN body IS NOT NULL THEN 1 ELSE 0 END) AS bodies,
           SUM(CASE WHEN body IS NOT NULL THEN LENGTH(body) ELSE 0 END) AS body_bytes
    FROM messages GROUP BY account_id
  `).all();
  return rows.map((r) => ({
    accountId: r.account_id,
    total: r.total || 0,
    bodies: r.bodies || 0,
    bodyBytes: r.body_bytes || 0,
  }));
}

// ---------- 旗标 / 结构变更回写 ----------
export function updateFlags(uid, accountId, folderPath, uids, patch) {
  // patch: { add: [...], remove: [...], set: [...] } —— 只对已缓存的邮件生效
  const db = getDb(uid);
  const sel = db.prepare('SELECT flags FROM messages WHERE account_id = ? AND folder = ? AND uid = ?');
  const upd = db.prepare('UPDATE messages SET flags = ? WHERE account_id = ? AND folder = ? AND uid = ?');
  db.exec('BEGIN');
  try {
    for (const u of uids) {
      const row = sel.get(accountId, folderPath, u);
      if (!row) continue;
      let flags = JSON.parse(row.flags);
      if (patch.set) flags = [...patch.set];
      else {
        for (const f of patch.add || []) if (!flags.includes(f)) flags.push(f);
        flags = flags.filter((f) => !(patch.remove || []).includes(f));
      }
      upd.run(JSON.stringify(flags), accountId, folderPath, u);
    }
    recountInTx(db, accountId, folderPath);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

export function addFlagToAll(uid, accountId, folderPath, flag) {
  const db = getDb(uid);
  db.exec('BEGIN');
  try {
    const rows = db.prepare('SELECT uid, flags FROM messages WHERE account_id = ? AND folder = ?')
      .all(accountId, folderPath);
    const upd = db.prepare('UPDATE messages SET flags = ? WHERE account_id = ? AND folder = ? AND uid = ?');
    for (const r of rows) {
      const flags = JSON.parse(r.flags);
      if (!flags.includes(flag)) upd.run(JSON.stringify([...flags, flag]), accountId, folderPath, r.uid);
    }
    recountInTx(db, accountId, folderPath);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

export function clearFolder(uid, accountId, folderPath) {
  const db = getDb(uid);
  ftsDropFolder(db, accountId, folderPath);
  db.prepare('DELETE FROM messages WHERE account_id = ? AND folder = ?').run(accountId, folderPath);
  recountInTx(db, accountId, folderPath);
}

export function moveUids(uid, accountId, folderPath, uids) {
  // MOVE 后目的夹的 UID 由服务器重新分配，无法本地推算 —— 源夹删除，目的夹留待下次同步/访问时重建
  removeUids(uid, accountId, folderPath, uids);
}

export function dropFolder(uid, accountId, folderPath) {
  const db = getDb(uid);
  ftsDropFolder(db, accountId, folderPath);
  db.prepare('DELETE FROM messages WHERE account_id = ? AND folder = ?').run(accountId, folderPath);
  db.prepare('DELETE FROM folders WHERE account_id = ? AND path = ?').run(accountId, folderPath);
}

export function dropAccount(uid, accountId) {
  const db = getDb(uid);
  const rows = db.prepare('SELECT rid FROM fts_keys WHERE account_id = ?').all(accountId);
  ftsDropRows(db, rows);
  db.prepare('DELETE FROM fts_keys WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM messages WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM folders WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM folder_lists WHERE account_id = ?').run(accountId);
}

// 清空全部正文（保留信封/旗标，下次打开或预热时再拉）—— 空间不够时的逃生口
export function clearBodies(uid, accountId = null) {
  const db = getDb(uid);
  const cond = accountId ? 'account_id = ? AND body IS NOT NULL' : 'body IS NOT NULL';
  const args = accountId ? [accountId] : [];
  const rows = db.prepare(`SELECT account_id, folder, uid, envelope FROM messages WHERE ${cond}`).all(...args);
  if (!rows.length) return 0;
  db.prepare(`UPDATE messages SET body = NULL, body_tries = 0${accountId ? ' WHERE account_id = ?' : ''}`).run(...args);
  // 索引里只保留主题/收发人
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      let env = {};
      try { env = JSON.parse(r.envelope) || {}; } catch { /* ignore */ }
      ftsUpsert(db, r.account_id, r.folder, r.uid, {
        subject: env.subject, sender: senderText(env.from), recipients: recipientsText(env.to), body: '',
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
  }
  return rows.length;
}
