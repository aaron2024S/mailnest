// ---------- 附件 / 内联图片磁盘缓存 ----------
// 邮件正文一旦下载（打开或后台预热），整封源码里的附件本来就已经在内存里了，
// 顺手落盘几乎不额外花时间；之后点附件、显示内嵌图片都不再走 IMAP。
// 布局：data/users/<uid>/attach/<sha1(account|folder|uid)>/{meta.json,0.bin,1.bin…}
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { userDir } from './store.js';

const pending = new Set(); // 正在写的目录，避免同一封被并发写

// 单附件落盘上限：超大附件（视频、安装包）不在后台预热时写盘，
// 否则一封 300MB 的邮件会把整个预热队列卡住、还把 NAS 塞满。
// 这类文件用户点开就是「下载」，本来也只需要一次网络往返。
const MAX_BYTES = (Number(process.env.MAILNEST_ATTACH_CACHE_MAX_MB) || 25) * 1024 * 1024;

function keyOf(accountId, folder, uid) {
  return crypto.createHash('sha1').update(`${accountId}\u0000${folder}\u0000${uid}`).digest('hex').slice(0, 24);
}

function dirOf(uid, key) {
  return path.join(userDir(uid), 'attach', key);
}

// CID 规范化：去尖括号、去 URL 编码、忽略大小写
// （simpleParser 给的 cid 有时是 <a@b>，HTML 里是 cid:a%40b，两边对不上就显示不出来）
export function normCid(cid) {
  let s = String(cid || '').trim();
  s = s.replace(/^</, '').replace(/>$/, '').trim();
  try { s = decodeURIComponent(s); } catch { /* 保持原样 */ }
  return s.toLowerCase();
}

export function attachUrl(accountId, folder, uid, idx, inline = false) {
  const q = `account=${encodeURIComponent(accountId)}&folder=${encodeURIComponent(folder)}&uid=${uid}&idx=${idx}`;
  return `/api/attachment?${q}${inline ? '&inline=1' : ''}`;
}

// 本体与元数据一起落盘；items 里带 content（Buffer）的才写 bin，否则只记元数据
export async function saveAll(uid, accountId, folder, messageUid, items) {
  if (!items?.length) return;
  const key = keyOf(accountId, folder, messageUid);
  if (pending.has(key)) return;
  pending.add(key);
  const dir = dirOf(uid, key);
  try {
    await fsp.mkdir(dir, { recursive: true });
    const meta = {
      account: accountId, folder, uid: Number(messageUid), savedAt: Date.now(), items: [],
    };
    for (const a of items) {
      const entry = {
        filename: a.filename, contentType: a.contentType, size: a.size || 0, cid: a.cid || null, saved: false,
      };
      if (a.content && a.content.length <= MAX_BYTES) {
        await fsp.writeFile(path.join(dir, `${a.id}.bin`), a.content);
        entry.saved = true;
      }
      meta.items.push(entry);
    }
    await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
  } catch { /* 缓存写失败不影响读信 */ } finally {
    pending.delete(key);
  }
}

export function readMeta(uid, accountId, folder, messageUid) {
  try {
    const f = path.join(dirOf(uid, keyOf(accountId, folder, messageUid)), 'meta.json');
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { return null; }
}

// 命中返回与 mail.getAttachment 同构的对象
export function get(uid, accountId, folder, messageUid, idx) {
  const meta = readMeta(uid, accountId, folder, messageUid);
  const item = meta?.items?.[idx];
  if (!item) return null;
  try {
    const buf = fs.readFileSync(path.join(dirOf(uid, keyOf(accountId, folder, messageUid)), `${idx}.bin`));
    return { filename: item.filename, contentType: item.contentType, content: buf };
  } catch { return null; }
}

export function dropMessage(uid, accountId, folder, messageUid) {
  const dir = dirOf(uid, keyOf(accountId, folder, messageUid));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// 删整个文件夹的附件：目录名是哈希，只能读 meta.json 反查（只在删除/清空时走一次）
export function dropFolder(uid, accountId, folder) {
  const root = path.join(userDir(uid), 'attach');
  let names;
  try { names = fs.readdirSync(root); } catch { return; }
  for (const name of names) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, name, 'meta.json'), 'utf8'));
      if (meta.account === accountId && meta.folder === folder) {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
      }
    } catch { /* 半写状态或无关目录 */ }
  }
}

export function dropAccount(uid, accountId) {
  const root = path.join(userDir(uid), 'attach');
  let names;
  try { names = fs.readdirSync(root); } catch { return; }
  for (const name of names) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, name, 'meta.json'), 'utf8'));
      if (meta.account === accountId) fs.rmSync(path.join(root, name), { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

export function clearAll(uid) {
  try { fs.rmSync(path.join(userDir(uid), 'attach'), { recursive: true, force: true }); } catch { /* ignore */ }
}

// 磁盘占用（同步遍历，只在设置页打开时调一次）
export function stats(uid) {
  const root = path.join(userDir(uid), 'attach');
  let bytes = 0;
  let files = 0;
  let mails = 0;
  const walk = (dir) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { mails += 1; walk(p); continue; }
      try { bytes += fs.statSync(p).size; files += 1; } catch { /* ignore */ }
    }
  };
  walk(root);
  return { bytes, files, mails };
}
