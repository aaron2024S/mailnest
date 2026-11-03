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
  PRIMARY KEY (account_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS idx_msg_uid ON messages (account_id, folder, uid DESC);
`;

export function getDb(uid) {
  let db = dbs.get(uid);
  if (db) return db;
  const dir = userDir(uid);
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, 'cache.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  dbs.set(uid, db);
  return db;
}

export function closeDb(uid) {
  const db = dbs.get(uid);
  if (db) { try { db.close(); } catch { /* ignore */ } dbs.delete(uid); }
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

// ---------- 整夹同步 ----------
// 全量替换一个文件夹的信封（首次同步 / uidvalidity 变化 / 手动强制刷新）
export function syncFolderFull(uid, accountId, folderPath, uidvalidity, messages) {
  const db = getDb(uid);
  const tx = db;
  tx.exec('BEGIN');
  try {
    tx.prepare('DELETE FROM messages WHERE account_id = ? AND folder = ?').run(accountId, folderPath);
    const ins = tx.prepare(`
      INSERT OR REPLACE INTO messages (account_id, folder, uid, envelope, flags, body, fetched_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `);
    for (const m of messages) {
      ins.run(accountId, folderPath, m.uid, JSON.stringify(envelopeOf(m)), JSON.stringify(m.flags || []), Date.now());
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
    for (const m of messages) {
      ins.run(accountId, folderPath, m.uid, JSON.stringify(envelopeOf(m)), JSON.stringify(m.flags || []), Date.now());
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
    for (const u of uids) del.run(accountId, folderPath, u);
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
  getDb(uid).prepare(`
    UPDATE messages SET body = ?, fetched_at = ? WHERE account_id = ? AND folder = ? AND uid = ?
  `).run(JSON.stringify(body), Date.now(), accountId, folderPath, messageUid);
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
  db.prepare('DELETE FROM messages WHERE account_id = ? AND folder = ?').run(accountId, folderPath);
  recountInTx(db, accountId, folderPath);
}

export function moveUids(uid, accountId, folderPath, uids) {
  // MOVE 后目的夹的 UID 由服务器重新分配，无法本地推算 —— 源夹删除，目的夹留待下次同步/访问时重建
  removeUids(uid, accountId, folderPath, uids);
}

export function dropFolder(uid, accountId, folderPath) {
  const db = getDb(uid);
  db.prepare('DELETE FROM messages WHERE account_id = ? AND folder = ?').run(accountId, folderPath);
  db.prepare('DELETE FROM folders WHERE account_id = ? AND path = ?').run(accountId, folderPath);
}

export function dropAccount(uid, accountId) {
  const db = getDb(uid);
  db.prepare('DELETE FROM messages WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM folders WHERE account_id = ?').run(accountId);
}
