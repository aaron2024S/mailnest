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

console.log(`\n全部通过：${pass} 项断言`);
