// 前端行为的离线断言：不启浏览器，直接把 app.js 的方法挂到假 this 上跑。
// 覆盖：星标/已读的双副本同步、账号显示名称的行内编辑。
// 重点回归：阅读区 selected 与列表项是两份对象（flags 还可能共用同一个数组），
// 以前只改一份 ⇒ 列表星标一直亮着、再点又变回星标（用户反馈“点了不能取消”）。
import fs from 'node:fs';
import assert from 'node:assert/strict';

let captured = null;
const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const fakeVue = { createApp(opts) { captured = opts; return { mount() {} }; } };
new Function('Vue', src)(fakeVue);
assert.ok(captured && captured.methods, 'app.js 没交出 methods');

const M = captured.methods;
let pass = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `✗ ${name} ${extra}`);
  pass++; console.log(`✓ ${name}`);
};

const msg = (over = {}) => ({ uid: 7, accountId: 'a1', folder: 'INBOX', flags: ['\\Seen'], ...over });

function ctxWith(messages, selected = null) {
  const ctx = {
    messages,
    selected,
    calls: [],
    async api(url, opts) { ctx.calls.push({ url, body: opts?.body }); if (ctx.fail) throw new Error('boom'); return { ok: true }; },
    loadAllFoldersAndUnread() {},
    currentFolderOf() { return 'INBOX'; },
    toast(m) { ctx.toasts = (ctx.toasts || []).concat(m); },
  };
  for (const k of ['flagTargets', 'setFlag', 'toggleStar', 'markRead']) ctx[k] = M[k];
  return ctx;
}

// 1) 共用同一个 flags 数组（阅读区打开后 selected 与列表项共享）——取消星标必须两边一起灭
{
  const listItem = msg();
  const selected = { ...msg({ flags: ['\\Seen', '\\Flagged'] }), ...listItem };
  selected.flags = listItem.flags; // 复现 {...full, ...m} 的共享引用
  listItem.flags.push('\\Flagged');
  const ctx = ctxWith([listItem], selected);
  await M.toggleStar.call(ctx, selected);
  ok('共用数组：取消后 selected 无星标', !selected.flags.includes('\\Flagged'));
  ok('共用数组：取消后列表项也无星标', !listItem.flags.includes('\\Flagged'));
  ok('共用数组：发的是 unstar', ctx.calls[0].body.action === 'unstar');
  // 再点一次应该重新加星（而不是被卡住）
  await M.toggleStar.call(ctx, selected);
  ok('共用数组：可以再次加星', ctx.calls[1].body.action === 'star' && listItem.flags.includes('\\Flagged'));
}

// 2) 两份独立数组：任何一边操作都要同步到另一边
{
  const a = msg();
  const b = msg();
  const ctx = ctxWith([a], b);
  ok('独立数组：确实是两个数组', a.flags !== b.flags);
  await M.toggleStar.call(ctx, b);
  ok('独立数组：阅读区加星后列表同步', a.flags.includes('\\Flagged') && b.flags.includes('\\Flagged'));
  await M.toggleStar.call(ctx, a);
  ok('独立数组：从列表取消后阅读区同步', !a.flags.includes('\\Flagged') && !b.flags.includes('\\Flagged'));
}

// 3) 只影响同一封邮件，别的邮件（同 uid 不同账号）不能误改
{
  const target = msg();
  const other = msg({ accountId: 'a2' });
  const otherFlags = [...other.flags];
  const ctx = ctxWith([target, other], null);
  await M.toggleStar.call(ctx, target);
  ok('不会误改其他账号的同 uid 邮件', other.flags.length === otherFlags.length && !other.flags.includes('\\Flagged'));
}

// 4) 接口失败要回滚，并给出提示
{
  const m = msg();
  const ctx = ctxWith([m], null);
  ctx.fail = true;
  await M.toggleStar.call(ctx, m);
  ok('失败回滚：星标还原', !m.flags.includes('\\Flagged'));
  ok('失败回滚：有错误提示', Array.isArray(ctx.toasts) && ctx.toasts.length === 1);
}

// 5) 汇总视图里列表项没有 folder 字段 → 必须回退到 currentFolderOf，不能把 undefined 发给后端
{
  const m = msg({ folder: undefined });
  const ctx = ctxWith([m], null);
  await M.toggleStar.call(ctx, m);
  ok('folder 缺失时回退 INBOX', ctx.calls[0].body.folder === 'INBOX', JSON.stringify(ctx.calls[0].body));
}

// 6) 已读/未读同理
{
  const listItem = msg({ flags: [] });
  const selected = { ...msg({ flags: [] }) };
  const ctx = ctxWith([listItem], selected);
  await M.markRead.call(ctx, selected, true);
  ok('标记已读：两边都变成已读', listItem.flags.includes('\\Seen') && selected.flags.includes('\\Seen'));
  await M.markRead.call(ctx, listItem, false);
  ok('标记未读：两边都清掉已读', !listItem.flags.includes('\\Seen') && !selected.flags.includes('\\Seen'));
}

// 7) 账号显示名称的行内编辑（设置 → 已添加邮箱 → 铅笔按钮）
{
  const acc = { id: 'a1', email: 'me@qq.com', displayName: '我的QQ', color: '#2d6cf6' };
  const mkCtx = () => {
    const ctx = {
      accounts: [acc],
      editingId: null,
      editName: '',
      editSaving: false,
      calls: [],
      toasts: [],
      async api(url, opts) { ctx.calls.push({ url, body: opts?.body }); if (ctx.fail) throw new Error('保存失败'); return { accounts: [{ ...acc, displayName: ctx.editName.trim() }] }; },
      toast(m, kind) { ctx.toasts.push({ m, kind }); },
    };
    for (const k of ['startEditAccount', 'cancelEditAccount', 'saveAccountName']) ctx[k] = M[k];
    return ctx;
  };

  // 空名称：只提示，不发请求，且保持编辑态（不然用户白输一遍）
  {
    const ctx = mkCtx();
    ctx.editName = '   ';
    await M.saveAccountName.call(ctx, acc);
    ok('空名称：不发请求', ctx.calls.length === 0);
    ok('空名称：有提示', ctx.toasts[0]?.m.includes('不能为空'));
  }

  // 正常改名：去空格后提交，成功后替换 accounts 并退出编辑
  {
    const ctx = mkCtx();
    ctx.editName = '  工作邮箱 ';
    await M.saveAccountName.call(ctx, acc);
    ok('改名：请求体是 trim 过的名称', ctx.calls[0]?.body?.displayName === '工作邮箱');
    ok('改名：打的是 PATCH /api/accounts/:id', ctx.calls[0]?.url === '/api/accounts/a1');
    ok('改名：列表已更新', ctx.accounts[0].displayName === '工作邮箱');
    ok('改名：退出编辑态', ctx.editingId === null && ctx.editName === '');
  }

  // 没改动：不打扰后端
  {
    const ctx = mkCtx();
    ctx.editName = '我的QQ';
    await M.saveAccountName.call(ctx, acc);
    ok('没改动：不发请求', ctx.calls.length === 0);
    ok('没改动：直接退出编辑', ctx.editingId === null);
  }

  // 失败：提示错误，保留编辑内容
  {
    const ctx = mkCtx();
    ctx.fail = true;
    ctx.editName = '新名字';
    await M.saveAccountName.call(ctx, acc);
    ok('保存失败：给出错误提示', ctx.toasts[0]?.kind === 'error');
    ok('保存失败：保留用户输入', ctx.editName === '新名字');
    ok('保存失败：退出 saving 态', ctx.editSaving === false);
  }
}

// 8) 新建文件夹 + 拖放整理
{
  const base = [
    { path: 'INBOX', name: 'INBOX', delim: '/', special: '\\Inbox' },
    { path: 'Archive', name: 'Archive', delim: '/', special: '\\Archive' },
  ];
  const mk = () => {
    const ctx = {
      foldersByAccount: { a1: base.slice() },
      folders: [],
      activeAccount: 'a1',
      newFolder: { accountId: 'a1', name: '', busy: false },
      messages: [{ uid: 7, accountId: 'a1', folder: 'INBOX', flags: ['\\Seen'] }],
      selected: null,
      readerOpen: false,
      dragMsg: null,
      calls: [],
      toasts: [],
      async api(url, opts) {
        ctx.calls.push({ url, body: opts?.body });
        if (url === '/api/folders') return { folders: [...base, { path: ctx.newFolder.name, name: ctx.newFolder.name, delim: '/' }] };
        return { ok: true };
      },
      toast(m, k) { ctx.toasts.push({ m, k }); },
      loadAllFoldersAndUnread() {},
      currentFolderOf() { return 'INBOX'; },
    };
    for (const k of ['foldersOf', 'createFolder', 'cancelNewFolder', 'canDropOn', 'onDrop', 'moveMessageTo', 'folderLabel']) ctx[k] = M[k];
    return ctx;
  };

  // 校验：空 / 含分隔符 / 重名，都不该打到服务器
  {
    const ctx = mk();
    ctx.newFolder.name = '   ';
    await M.createFolder.call(ctx, 'a1');
    ok('建文件夹：空名不发请求', ctx.calls.length === 0 && ctx.toasts.at(-1).m.includes('不能为空'));

    ctx.newFolder.name = '客户/2026';
    await M.createFolder.call(ctx, 'a1');
    ok('建文件夹：含分隔符被拦下', ctx.calls.length === 0 && ctx.toasts.at(-1).m.includes('分隔符'));

    ctx.newFolder.name = 'Archive';
    await M.createFolder.call(ctx, 'a1');
    ok('建文件夹：重名被拦下', ctx.calls.length === 0 && ctx.toasts.at(-1).m.includes('已存在'));
  }

  // 成功：更新文件夹列表并退出输入态
  {
    const ctx = mk();
    ctx.newFolder.name = '客户';
    await M.createFolder.call(ctx, 'a1');
    ok('建文件夹：请求体正确', ctx.calls[0].body.account === 'a1' && ctx.calls[0].body.path === '客户');
    ok('建文件夹：列表已刷新', ctx.foldersByAccount.a1.some((f) => f.path === '客户'));
    ok('建文件夹：退出输入态', ctx.newFolder.accountId === null);
  }

  // 拖放可投放判定
  {
    const ctx = mk();
    ctx.dragMsg = ctx.messages[0];
    ok('拖放：拖回原文件夹不算可投放', ctx.canDropOn('a1', 'INBOX') === false);
    ok('拖放：拖到其它文件夹可投放', ctx.canDropOn('a1', 'Archive') === true);
    ok('拖放：跨账号不可投放', ctx.canDropOn('a2', 'Archive') === false);
    ctx.dragMsg = null;
    ok('拖放：没在拖东西时不可投放', ctx.canDropOn('a1', 'Archive') === false);
  }

  // 真正放下：调 /api/move 并把邮件从列表移除
  {
    const ctx = mk();
    ctx.dragMsg = ctx.messages[0];
    await M.onDrop.call(ctx, 'a1', 'Archive');
    ok('拖放：调用 /api/move', ctx.calls[0].url === '/api/move');
    ok('拖放：目标是 Archive', ctx.calls[0].body.dest === 'Archive' && ctx.calls[0].body.folder === 'INBOX');
    ok('拖放：邮件从列表消失', ctx.messages.length === 0);
    ok('拖放：提示里带文件夹中文名', ctx.toasts.at(-1).m.includes('归档'), ctx.toasts.at(-1).m);
    ok('拖放：清空拖动态', ctx.dragMsg === null);
  }

  // 跨账号放下：拒绝并提示，不发请求
  {
    const ctx = mk();
    ctx.dragMsg = ctx.messages[0];
    await M.onDrop.call(ctx, 'a2', 'Archive');
    ok('跨账号拖放：不发请求', ctx.calls.length === 0);
    ok('跨账号拖放：有提示', ctx.toasts.at(-1).k === 'error');
  }
}

// ============ 多选 / 批量操作 / 右键菜单 ============
console.log('\n--- 多选与批量操作 ---');
globalThis.confirm = () => true;
globalThis.window = globalThis.window || { innerWidth: 1280, innerHeight: 800, addEventListener() {} };

const C = captured.computed;
function bulkCtx(messages, opts = {}) {
  const ctx = {
    messages,
    selection: opts.selection || [],
    selAnchor: -1,
    searchQ: opts.searchQ || '',
    foldersByAccount: opts.foldersByAccount || {},
    calls: [],
    async api(url, o) { ctx.calls.push({ url, body: o?.body }); if (ctx.fail) throw new Error('boom'); return { ok: true }; },
    loadAllFoldersAndUnread() {},
    currentFolderOf(m) { return m.folder || 'INBOX'; },
    toast(m, k) { (ctx.toasts = ctx.toasts || []).push({ m, k }); },
    readerOpen: true,
  };
  for (const k of ['msgMatch', 'msgKey', 'isSel', 'toggleSel', 'toggleSelectAll', 'clearSel',
    'selectedMessages', 'groupSelection', 'trashOf', 'archiveOf', 'dropRows',
    'batchRead', 'batchStar', 'batchRemove', 'batchArchive', 'batchMove',
    'setFlag', 'flagTargets', 'openCtx', 'closeCtx', 'ctxAct', 'folderLabel']) ctx[k] = M[k];
  for (const k of ['visibleRows', 'filteredMessages', 'allSelected', 'selCount']) {
    Object.defineProperty(ctx, k, { get() { return C[k].call(ctx); } });
  }
  return ctx;
}

// 1) 全选 / 取消全选
{
  const rows = [msg({ uid: 1 }), msg({ uid: 2 }), msg({ uid: 3 })];
  const ctx = bulkCtx(rows);
  ok('全选：初始不是全选状态', C.allSelected.call(ctx) === false);
  M.toggleSelectAll.call(ctx);
  ok('全选：三封都进 selection', ctx.selection.length === 3);
  ok('全选：判定为全选', C.allSelected.call(ctx) === true);
  M.toggleSelectAll.call(ctx);
  ok('全选：再点一次清空', ctx.selection.length === 0);
}

// 2) 搜索过滤后只选可见行
{
  const rows = [msg({ uid: 1, subject: '发票' }), msg({ uid: 2, subject: '会议' })];
  const ctx = bulkCtx(rows, { searchQ: '发票' });
  M.toggleSelectAll.call(ctx);
  ok('全选：只选搜索命中的行', ctx.selection.length === 1 && ctx.selection[0].endsWith('|1'));
}

// 3) Shift 连选
{
  const rows = [msg({ uid: 1 }), msg({ uid: 2 }), msg({ uid: 3 }), msg({ uid: 4 })];
  const ctx = bulkCtx(rows);
  M.toggleSel.call(ctx, null, rows[0]);
  ok('单选：(0) 已选', ctx.selection.length === 1);
  M.toggleSel.call(ctx, { shiftKey: true }, rows[2]);
  ok('Shift 连选：0→2 共三封', ctx.selection.length === 3);
  M.toggleSel.call(ctx, null, rows[3]);
  ok('普通点击：追加而不是替换', ctx.selection.length === 4);
}

// 4) 批量已读：同账号同文件夹合并成一个请求，uids 是数组
{
  const rows = [msg({ uid: 1, flags: [] }), msg({ uid: 2, flags: [] })];
  const ctx = bulkCtx(rows, { selection: ['a1|INBOX|1', 'a1|INBOX|2'] });
  await M.batchRead.call(ctx, true);
  ok('批量已读：只发一个请求', ctx.calls.length === 1, JSON.stringify(ctx.calls));
  ok('批量已读：uids 是数组', JSON.stringify(ctx.calls[0].body.uids) === '[1,2]');
  ok('批量已读：action=read', ctx.calls[0].body.action === 'read');
  ok('批量已读：本地 flags 同步', rows.every((r) => r.flags.includes('\\Seen')));
  ok('批量已读：有成功提示', /2 封/.test(ctx.toasts.at(-1).m));
}

// 5) 跨账号 / 跨文件夹必须分组发
{
  const rows = [msg({ uid: 1, accountId: 'a1' }), msg({ uid: 1, accountId: 'a2' }), msg({ uid: 5, folder: 'Archive' })];
  const ctx = bulkCtx(rows, { selection: rows.map((r) => r.accountId + '|' + r.folder + '|' + r.uid) });
  await M.batchRead.call(ctx, false);
  ok('分组：三个不同邮箱/文件夹发三个请求', ctx.calls.length === 3, String(ctx.calls.length));
  ok('分组：每个请求只带自己的 uid', ctx.calls.every((c) => c.body.uids.length === 1));
}

// 6) 批量已读失败要整体回滚
{
  const rows = [msg({ uid: 1, flags: [] })];
  const ctx = bulkCtx(rows, { selection: ['a1|INBOX|1'] });
  ctx.fail = true;
  await M.batchRead.call(ctx, true);
  ok('批量已读失败：flags 回滚', !rows[0].flags.includes('\\Seen'));
  ok('批量已读失败：提示错误', ctx.toasts.at(-1).k === 'error');
}

// 7) 批量删除：有垃圾箱就移动过去
{
  const rows = [msg({ uid: 1 }), msg({ uid: 2 })];
  const ctx = bulkCtx(rows, {
    selection: ['a1|INBOX|1', 'a1|INBOX|2'],
    foldersByAccount: { a1: [{ path: 'INBOX' }, { path: 'Trash', special: '\\Trash' }] },
  });
  await M.batchRemove.call(ctx);
  ok('批量删除：用 move 进垃圾箱', ctx.calls[0].url === '/api/move' && ctx.calls[0].body.dest === 'Trash');
  ok('批量删除：列表里剔除', ctx.messages.length === 0 && ctx.selection.length === 0);
  ok('批量删除：提示条数', /2 封/.test(ctx.toasts.at(-1).m));
}

// 8) 已在垃圾箱里：直接 delete（不再 move 到同一个文件夹）
{
  const rows = [msg({ uid: 9, folder: 'Trash' })];
  const ctx = bulkCtx(rows, {
    selection: ['a1|Trash|9'],
    foldersByAccount: { a1: [{ path: 'Trash', special: '\\Trash' }] },
  });
  await M.batchRemove.call(ctx);
  ok('垃圾箱内删除：走 /api/delete', ctx.calls[0].url === '/api/delete');
}

// 9) 批量归档：没有归档文件夹的账号被跳过
{
  const rows = [msg({ uid: 1, accountId: 'a1' }), msg({ uid: 2, accountId: 'a2' })];
  const ctx = bulkCtx(rows, {
    selection: rows.map((r) => r.accountId + '|INBOX|' + r.uid),
    foldersByAccount: { a1: [{ path: 'Archive', special: '\\Archive' }], a2: [] },
  });
  await M.batchArchive.call(ctx);
  ok('批量归档：只给有 Archive 的账号发请求', ctx.calls.length === 1 && ctx.calls[0].body.account === 'a1');
  ok('批量归档：移走的从列表剔除、没归档的留下', ctx.messages.length === 1 && ctx.messages[0].accountId === 'a2');
}

// 10) 右键：点在未选中的行上只对这一封操作
{
  const rows = [msg({ uid: 1 }), msg({ uid: 2 })];
  const ctx = bulkCtx(rows, { selection: ['a1|INBOX|1'] });
  M.openCtx.call(ctx, { clientX: 100, clientY: 100 }, rows[1]);
  ok('右键未选中行：selection 换成这一封', ctx.selection.length === 1 && ctx.selection[0].endsWith('|2'));
  ok('右键：菜单打开并记住邮件', ctx.ctx.open === true && ctx.ctx.m.uid === 2);
  M.openCtx.call(ctx, { clientX: 100, clientY: 100 }, rows[0]);
  ok('右键已选中行：保留多选', ctx.selection.length === 1);
  M.closeCtx.call(ctx);
  ok('右键：closeCtx 关闭', ctx.ctx.open === false && ctx.ctx.m === null);
}

// 11) 右键菜单动作：先关菜单再执行，且拿到的是右键那一封
{
  const rows = [msg({ uid: 4 })];
  const ctx = bulkCtx(rows, { selection: ['a1|INBOX|4'] });
  M.openCtx.call(ctx, { clientX: 10, clientY: 10 }, rows[0]);
  let got = null;
  M.ctxAct.call(ctx, (m) => { got = m.uid; });
  ok('ctxAct：把邮件传给回调', got === 4);
  ok('ctxAct：执行后菜单关闭', ctx.ctx.open === false);
}

// 12) msgKey 区分账号与文件夹
{
  const ctx = bulkCtx([]);
  ok('msgKey：账号+文件夹+uid 组成唯一键',
    M.msgKey.call(ctx, { uid: 3, accountId: 'a1', folder: 'INBOX' }) === 'a1|INBOX|3');
  ok('msgKey：不同文件夹不同键',
    M.msgKey.call(ctx, { uid: 3, accountId: 'a1', folder: 'Trash' }) !== M.msgKey.call(ctx, { uid: 3, accountId: 'a1', folder: 'INBOX' }));
}

// 13) 列表标题跟随实际选中的文件夹（回归：汇总视图里切到「已发送」还显示「收件箱 · 所有账号」）
{
  const ctx = {
    activeAccount: 'all', allFolder: 'a1|Sent Messages',
    accounts: [{ id: 'a1', displayName: 'QQ邮箱' }],
    foldersOf: (aid) => [{ path: 'INBOX' }, { path: 'Sent Messages', special: '\\Sent' }],
  };
  ctx.folderLabel = M.folderLabel;
  const t = C.listTitle.call(ctx);
  ok('标题：汇总视图选中已发送 → 显示「已发送 · QQ邮箱」', t === '已发送 · QQ邮箱', t);
  ctx.allFolder = null;
  ok('标题：汇总视图默认 → 收件箱 · 所有账号', C.listTitle.call(ctx) === '收件箱 · 所有账号');
  ctx.activeAccount = 'a1'; ctx.folders = [{ path: 'Sent Messages', special: '\\Sent' }]; ctx.activeFolder = 'Sent Messages';
  ok('标题：单账号选中已发送 → 已发送', C.listTitle.call(ctx) === '已发送');
}

// 14) 删除后列表头顶的「xx 封」要跟着减少（回归：删了邮件数字不动）
{
  const rows = [msg({ uid: 1 }), msg({ uid: 2 }), msg({ uid: 3 })];
  const ctx = bulkCtx(rows, { selection: ['a1|INBOX|1', 'a1|INBOX|2'] });
  ctx.total = 3; ctx.page = 1;
  M.dropRows.call(ctx, rows.slice(0, 2));
  ok('删除后总数减 2', ctx.total === 1, String(ctx.total));
  ok('删除后列表只剩 1 封', ctx.messages.length === 1);
  M.dropRows.call(ctx, ctx.messages);
  ok('全删光后总数为 0 且不出现负数', ctx.total === 0, String(ctx.total));
}
{
  const rows = [msg({ uid: 1 })];
  const ctx = bulkCtx(rows, { selection: ['a1|INBOX|1'] });
  ctx.total = 1; ctx.page = 1;
  M.dropRows.call(ctx, rows);
  ok('只剩 1 封时删掉 → 总数归零', ctx.total === 0);
}

// 15) 当前页被删空时退回上一页（否则停在空白页）
{
  const rows = [msg({ uid: 5, folder: 'INBOX' })];
  const ctx = bulkCtx(rows, { selection: ['a1|INBOX|5'] });
  ctx.total = 21; ctx.page = 2;
  let wentTo = null;
  ctx.gotoPage = (p) => { wentTo = p; };
  M.dropRows.call(ctx, rows);
  ok('删空当前页 → 退回上一页', wentTo === 1, String(wentTo));
  ok('删空当前页 → 总数也减了', ctx.total === 20, String(ctx.total));
}
{
  const rows = [msg({ uid: 5 })];
  const ctx = bulkCtx(rows, { selection: ['a1|INBOX|5'] });
  ctx.total = 3; ctx.page = 1;
  let called = false;
  ctx.gotoPage = () => { called = true; };
  M.dropRows.call(ctx, rows);
  ok('第一页删空不往回跳（没上一页）', called === false);
}

// 16) 单封删除走同一条路径：总数也要减
{
  const rows = [msg({ uid: 9 }), msg({ uid: 10 })];
  const ctx = bulkCtx(rows, { selection: [] });
  Object.assign(ctx, {
    total: 2, page: 1, accounts: [{ id: 'a1', displayName: 'QQ' }],
    foldersByAccount: { a1: [{ path: 'Trash', special: '\\Trash' }] },
    loadAllFoldersAndUnread() {}, readerOpen: true,
  });
  ctx.dropRows = M.dropRows;
  globalThis.confirm = () => true;
  await M.remove.call(ctx, rows[0]);
  ok('单封删除后总数减 1', ctx.total === 1, String(ctx.total));
  ok('单封删除后列表剩 1 封', ctx.messages.length === 1);
}

console.log(`\n全部通过：${pass} 项断言`);
