// 发送 / 回复 / 转发的回归测试。
//
// 之前这一整块只有「没权限时报错」「schema 收不收参数」这类断言 —— 真正把信发出去的
// 那条路（SMTP 会话、头部拼装、附件编码、回复目标）一次都没跑过。用户问
// 「发送邮件和回复邮件你有没有测试」，答案是没有。
//
// 这里起一个假的 SMTP 服务器，收下 nodemailer 真正发出的报文，再用 mailparser 解回来
// 逐项断言：收件人/抄送/密送、主题、正文、附件字节、In-Reply-To、References。
// 不往任何真实邮箱发信，但走的是和线上完全相同的 sendMail 路径。
//
// 用法：node tests/send.mjs
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { startFakeSmtp } from './fake-smtp.mjs';

let pass = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { failed++; console.error(`✗ ${name} ${extra}`); }
};

const DIR = path.resolve('.send-test');
fs.rmSync(DIR, { recursive: true, force: true });
process.env.MAILNEST_DATA = DIR;

const { sendMail } = await import('../server/mail.js');
const { replyTargets, replySubject, forwardSubject } = await import('../server/mcp-tools.js');

// ---------- 假 SMTP ----------
// 实现放在 fake-smtp.mjs，draft.mjs 也用同一份，避免两处各写一套。

const { server, received, port } = await startFakeSmtp();

const account = {
  id: 'acc-fake',
  email: 'me@example.com',
  displayName: '我自己',
  auth: { user: 'me@example.com', pass: 'secret' },
  smtp: { host: '127.0.0.1', port, tls: false },
};

const send = async (opts) => {
  const before = received.length;
  await sendMail('u-test', account, opts);
  for (let i = 0; i < 100 && received.length === before; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return received[received.length - 1] || '';
};

// ---------- 基本发送 ----------
{
  const raw = await send({
    to: ['a@example.com', 'b@example.com'],
    cc: ['c@example.com'],
    bcc: ['secret@example.com'],
    subject: '测试主题：中文与符号 🎉',
    text: '正文第一行\n第二行',
  });
  const p = await simpleParser(raw);
  const to = String(p.to?.text || '');
  const cc = String(p.cc?.text || '');

  ok('信发得出去（假服务器收到了完整报文）', raw.length > 100, `${raw.length} 字节`);
  ok('To 头包含全部收件人', to.includes('a@example.com') && to.includes('b@example.com'), to);
  ok('Cc 头只放抄送人', cc.includes('c@example.com') && !cc.includes('a@example.com'), cc);
  // 密送泄漏是很严重的事故：收件人能从头部看到「还密送了谁」
  ok('Bcc 不出现在报文任何位置（密送不泄漏）', !raw.includes('secret@example.com'));
  ok('中文主题原样送达（MIME 编码后能正确解回）', p.subject === '测试主题：中文与符号 🎉', String(p.subject));
  ok('正文原样送达', String(p.text || '').trim() === '正文第一行\n第二行', String(p.text || ''));
  // 中文显示名会被 MIME 编码成 =?UTF-8?B?...?=，所以要解回来比，不能在原始报文里 grep
  ok('From 用账号显示名 + 地址',
    p.from?.value?.[0]?.address === 'me@example.com' && p.from?.value?.[0]?.name === '我自己',
    JSON.stringify(p.from?.value));
  // 没有 Message-ID 的话，对方客户端串不起会话，我们回复时带的 In-Reply-To 也无处可指
  ok('报文自带 Message-ID（对方才能归到同一会话）',
    /^<[^@>]+@[^>]+>$/.test(String(p.messageId || '')), String(p.messageId));
}

// ---------- 附件 ----------
{
  const body = '这是附件内容 hello 123';
  const raw = await send({
    to: ['a@example.com'],
    subject: '带附件',
    text: '见附件',
    attachments: [
      { filename: '报告.txt', content: Buffer.from(body).toString('base64'), contentType: 'text/plain' },
      { filename: '数据.bin', content: Buffer.from([0, 1, 2, 250, 251]).toString('base64'), contentType: 'application/octet-stream' },
    ],
  });
  const p = await simpleParser(raw);
  ok('两个附件都在', p.attachments.length === 2, String(p.attachments.length));
  ok('中文附件名保留', p.attachments[0].filename === '报告.txt', String(p.attachments[0].filename));
  ok('附件内容字节一致（base64 解码没错位）',
    p.attachments[0].content.toString('utf8') === body,
    JSON.stringify(p.attachments[0].content.toString('utf8')));
  ok('二进制附件不被当文本破坏',
    Buffer.compare(p.attachments[1].content, Buffer.from([0, 1, 2, 250, 251])) === 0,
    String([...p.attachments[1].content]));
}

// ---------- 回复用的头部 ----------
{
  const raw = await send({
    to: ['a@example.com'],
    subject: 'Re: 原主题',
    text: '收到，谢谢',
    inReplyTo: '<orig@example.com>',
    references: '<older@example.com> <orig@example.com>',
  });
  const p = await simpleParser(raw);
  ok('In-Reply-To 送达（客户端才能归到同一会话）',
    String(p.inReplyTo || '') === '<orig@example.com>', String(p.inReplyTo));
  ok('References 保留整条链，不是只剩最后一封',
    String(p.references || '').includes('older@example.com')
    && String(p.references || '').includes('orig@example.com'), String(p.references));
}

// ---------- 空主题兜底 ----------
{
  const raw = await send({ to: ['a@example.com'], subject: '', text: 'x' });
  const p = await simpleParser(raw);
  ok('空主题兜底为 (无主题)，不会发出无主题的空信头', p.subject === '(无主题)', String(p.subject));
}

// ---------- 回复发给谁（这一层最容易错，单独钉死）----------
{
  const t = replyTargets({ from: { address: 'noreply@shop.example' }, replyTo: { address: 'support@shop.example' } });
  // 只回 From 等于寄给不收信的机器人，用户看不出没送达
  ok('有 Reply-To 时回给 Reply-To，不是那个 noreply', t.to[0] === 'support@shop.example', JSON.stringify(t));
}
{
  const t = replyTargets({ from: { address: 'friend@example.com' }, replyTo: null });
  ok('没有 Reply-To 时回给发件人', t.to[0] === 'friend@example.com', JSON.stringify(t));
}
{
  let msg = '';
  try { replyTargets({ from: null, replyTo: null }); } catch (e) { msg = String(e.message); }
  ok('既没有 Reply-To 也没有发件人时明确报错', /没有可回复/.test(msg), msg);
}
{
  const orig = {
    from: { address: 'boss@example.com' },
    to: [{ address: 'me@example.com' }, { address: 'team@example.com' }],
    cc: [{ address: 'cc1@example.com' }, { address: 'me@example.com' }, { address: 'boss@example.com' }],
  };
  const t = replyTargets(orig, { replyAll: true, self: ['me@example.com'] });
  ok('回复全部带上原收件人（之前只取抄送，团队里的其他人会漏掉）',
    t.cc.includes('team@example.com'), JSON.stringify(t.cc));
  ok('回复全部带上原抄送', t.cc.includes('cc1@example.com'), JSON.stringify(t.cc));
  ok('回复全部不把自己抄进去', !t.cc.includes('me@example.com'), JSON.stringify(t.cc));
  ok('回复全部不把主收件人重复放进抄送', !t.cc.includes('boss@example.com'), JSON.stringify(t.cc));
}
{
  const t = replyTargets({
    from: { address: 'boss@example.com' },
    to: [{ address: 'me@example.com' }, { address: 'team@example.com' }],
  });
  ok('不是回复全部时只发给一个人、不抄送', t.to.length === 1 && t.cc.length === 0, JSON.stringify(t));
}

// ---------- 主题前缀 ----------
{
  ok('Re: 前缀不重复叠加', replySubject('Re: 你好') === 'Re: 你好', replySubject('Re: 你好'));
  ok('中文「回复：」也认，不再套一层 Re:', replySubject('回复：你好') === '回复：你好', replySubject('回复：你好'));
  ok('普通主题补 Re:', replySubject('项目进度') === 'Re: 项目进度', replySubject('项目进度'));
  ok('Fwd: 不重复', forwardSubject('Fwd: 报告') === 'Fwd: 报告', forwardSubject('Fwd: 报告'));
  ok('中文「转发：」也认', forwardSubject('转发：报告') === '转发：报告', forwardSubject('转发：报告'));
}

// ---------- 引用正文里的内嵌图：发送前重新内嵌成 cid ----------
// 阅读原邮件时 cid:logo 被换成本机的 /api/attachment?…&inline=1；这段 HTML 作为
// 回复正文发出去，收件人那边相对路径必然 404（还泄露账号/夹/uid）。发送前必须重新内嵌。
{
  const att = await import('../server/attachments.js');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
  await att.saveAll('u-test', 'acc-fake', 'INBOX', 7, [
    { id: 0, filename: 'logo.png', contentType: 'image/png', size: png.length, content: png, cid: 'logo@x' },
  ]);
  const url = '/api/attachment?account=acc-fake&folder=INBOX&uid=7&idx=0&inline=1';
  const raw = await send({
    to: ['a@example.com'],
    subject: '回复：报价单',
    text: '收到',
    // src 里的 & 走 HTML 转义（&amp;），服务端要认这种写法
    html: `<div>收到</div><div class="mnq"><img src="${url.replace(/&/g, '&amp;')}" alt="logo"></div>`,
  });
  const parsed = await simpleParser(raw);
  const all = parsed.attachments || [];
  const inline = all.filter((a) => a.cid);
  ok('引用内嵌图：重新挂成 cid 附件', inline.length === 1, JSON.stringify(all.map((a) => a.filename)));
  // mailparser 会把已 resolve 的 cid 直接展开成 data: URI，所以两种形态都算正确
  const htmlOut = String(parsed.html || '');
  ok('引用内嵌图：HTML 的 src 指向内嵌图（cid: / mailparser 展成 data:）',
    htmlOut.includes('cid:') || htmlOut.includes('data:image/png;base64,'), htmlOut.slice(0, 240));
  ok('引用内嵌图：字节与原件一致', Buffer.compare(inline[0]?.content || Buffer.alloc(0), png) === 0);
  ok('引用内嵌图：外发源码不再出现本机接口地址', !String(parsed.html || '').includes('/api/attachment'));
  ok('引用内嵌图：仍带原始文件名 / 类型', /png/i.test(inline[0]?.contentType || ''), inline[0]?.contentType);
}

// 普通正文（没有本机图片地址）不受影响：不加多余附件
{
  const raw = await send({ to: ['a@example.com'], subject: '普通信', text: 'hi', html: '<p>hi</p>' });
  const parsed = await simpleParser(raw);
  ok('普通 HTML 正文不产生多余内嵌附件', (parsed.attachments || []).length === 0, String((parsed.attachments || []).length));
}

// ---------- 外发正文的 CSS 内联（经典 Outlook 用 Word 引擎，只认内联样式） ----------
{
  const raw = await send({
    to: ['a@example.com'],
    subject: '回复：报价单',
    text: '收到',
    html: '<div style="color:#24292f">我新写的正文</div>'
      + '<div class="mnq"><style>.mnq{background:#000;color:#fff} .b td{border:1px solid #444;padding:8px}'
      + '@media (max-width:600px){.b td{display:block!important}}</style>'
      + '<table class="b" width="600"><tr><td>促销码</td><td>CLUB-W6VX</td></tr></table>'
      // Outlook 专属的 VML 只写在条件注释里，内联时绝不能把它吃掉
      + '<!--[if mso]><v:roundrect arcsize="8%">按钮</v:roundrect><![endif]--></div>',
  });
  const parsed = await simpleParser(raw);
  const html = String(parsed.html || '');
  ok('外发正文：<style> 规则算进元素的内联 style（Outlook 才认）',
    /<td style="[^"]*border:\s*1px solid #444/.test(html), html.slice(0, 320));
  ok('外发正文：原文 body 级配色只落在引用块容器上',
    /class="mnq"[^>]*style="[^"]*background:\s*#000/.test(html), html.slice(0, 320));
  ok('外发正文：用户新写的正文没被原文配色染掉',
    /<div style="color:\s*#24292f">我新写的正文<\/div>/.test(html), html.slice(0, 240));
  ok('外发正文：媒体查询保留（现代客户端仍响应式）', /@media[^{]*600px/.test(html), html.slice(-360));
  ok('外发正文：已被内联的普通规则不再留在 <style> 里', !/\.b td\{/.test(html), html.slice(0, 360));
  ok('外发正文：Outlook 条件注释（VML）原样保留', /\[if mso\]/.test(html) && /v:roundrect/.test(html), html.slice(-300));
}

// ---------- 写信里插入的表格：发出去对方得能看出这是个表格 ----------
// 经典 Outlook 是 Word 引擎，只认元素自身的 style/border。表格边框一旦丢，
// 收件人看到的就是一堆挤在一起的文字，比不带表格还糟。
{
  const body = '<style>.mnq-body table{border-collapse:collapse;margin:10px 0;font-size:13.5px}'
    + '.mnq-body td,.mnq-body th{border:1px solid #c9d1d9;padding:6px 10px;vertical-align:top}</style>'
    + '<div class="mnq-body" style="font:14px/1.7 system-ui,sans-serif;color:#24292f">'
    + '<p>报价如下：</p>'
    + '<table><tbody><tr><td>Q3 报价单</td><td>数量</td></tr>'
    + '<tr><td>12,800</td><td>3</td></tr></tbody></table>'
    + '<p>合计见附件。</p></div>';
  const raw = await send({ to: ['a@example.com'], subject: '报价', text: '报价如下', html: body });
  const parsed = await simpleParser(raw);
  const html = String(parsed.html || '');
  ok('表格：单元格带内联边框（Outlook 靠这个画格子）',
    /<td style="[^"]*border:\s*1px solid #c9d1d9/.test(html), html.slice(0, 420));
  ok('表格：结构完整（2 行 4 格）', (html.match(/<td/g) || []).length === 4, html.slice(0, 420));
  ok('表格：内联后不再留 .mnq-body 规则', !/\.mnq-body td/.test(html));
  ok('表格：文字没被压成制表符/一行', /Q3 报价单/.test(html) && /12,800/.test(html));
  ok('表格：表格前后的正文段落都还在', /报价如下/.test(html) && /合计见附件/.test(html));
}

server.close();
console.log(`\n${failed ? '失败' : '全部通过'}：${pass} 项断言${failed ? `，失败 ${failed} 项` : ''}`);
if (failed) process.exit(1);
