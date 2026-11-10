// MCP 接入端点：Streamable HTTP（2025 规范），无状态模式。
// 无状态的含义：不签发 Mcp-Session-Id，每个 POST 独立建一个 server 实例 ──
// 工具调用本身不需要跨请求状态，省掉会话表就没有「会话泄漏 / 重启后客户端全挂」这类问题。
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './mcp-tools.js';
import { verifyToken, touchToken } from './tokens.js';
import { audit } from './store.js';
import { tzName } from './tz.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const RATE_MAX = 60;          // 每个令牌每分钟
const RATE_WINDOW = 60000;
const hits = new Map();       // tokenId -> { n, reset }

function rateLimited(id) {
  const now = Date.now();
  const e = hits.get(id);
  if (!e || now > e.reset) { hits.set(id, { n: 1, reset: now + RATE_WINDOW }); return false; }
  e.n += 1;
  return e.n > RATE_MAX;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}

function bearer(req) {
  const h = String(req.get('authorization') || '');
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

// 浏览器发起的跨站请求要挡掉（DNS rebinding）；非浏览器客户端不带 Origin，放行
function originOk(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === req.get('host'); } catch { return false; }
}

function rpc(res, status, code, message) {
  res.status(status).json({ jsonrpc: '2.0', id: null, error: { code, message } });
}

export function mountMcp(app) {
  app.post('/mcp', async (req, res) => {
    if (!originOk(req)) return rpc(res, 403, -32000, '拒绝跨站请求');

    const auth = verifyToken(bearer(req));
    if (!auth) {
      return rpc(res, 401, -32001,
        '缺少或无效的接入令牌。请在请求头带上 Authorization: Bearer <令牌>，令牌可在 MailNest 的「设置 → Agent 接入」里生成');
    }
    if (rateLimited(auth.tokenId)) return rpc(res, 429, -32000, `请求过于频繁（每分钟上限 ${RATE_MAX} 次）`);

    touchToken(auth.tokenId, clientIp(req));

    // 审计只记真正的工具调用，initialize / tools/list 这些握手不落盘（否则日志全被刷满）
    const method = req.body?.method;
    if (method === 'tools/call') {
      const tool = String(req.body?.params?.name || '');
      audit(auth.uid, 'mcp', `${auth.name || 'MCP'} → ${tool}`, clientIp(req));
    }

    // 权限自述：以前只有「被拒之后」才知道令牌能干什么，调用方没法提前规划——
    // 想发信却要先试一次失败、再回头跟用户解释。这里在握手时就把能力边界说清楚。
    const SCOPE_ZH = { read: '读取邮件', write: '整理邮件（标记/移动/删除）', send: '发送邮件' };
    const have = (auth.scopes || []).map((x) => SCOPE_ZH[x] || x);
    const lack = Object.keys(SCOPE_ZH).filter((x) => !(auth.scopes || []).includes(x)).map((x) => SCOPE_ZH[x]);
    const scopeLine = `0. 本次令牌权限：${have.length ? have.join('、') : '无'}。`
      + (lack.length
        ? `${lack.join('、')}不可用，相关工具会直接拒绝；被拒时不要反复重试，告诉用户去网页端「设置 → Agent 接入」勾上即可。`
        : '读写发送都可用。');

    const server = new McpServer(
      { name: 'mailnest', version: pkg.version },
      {
        instructions: [
          scopeLine,
          '这是 MailNest 自托管邮箱（多账号聚合）。按下面的路由规则选工具，不要按工具名猜：',
          '1. 问「有几封未读 / 有没有新邮件」→ unread_count（不传 account 时返回全部账号汇总）。',
          '2. 问「未读/邮件有哪些、都是什么」→ list_messages 且 unreadOnly=true。',
          '3. 用户指名了某个邮箱（如「QQ邮箱的未读」「outlook 的邮件」）时，所有工具都必须传 account=那个邮箱；',
          '   account 可填显示名、邮箱地址或 id；只有用户完全没提邮箱时才省略（此时 list_messages 会合并全部账号，',
          '   结果里每条 message 带 account 字段标明来源）。',
          '4. 看正文 → read_message；看附件 → 先 read_message 拿附件清单和编号，再 read_attachment。',
          '5. 按关键词找信 → search_messages（可跨账号，首次调用会先建索引）。',
          '6. uid 是邮件标识：自己用 list_messages 查到再传，绝对不要向用户索要；跨账号结果里 uid 只在其',
          '   account 内唯一，后续操作必须把 account 一起带上。',
          '7. 整理用 set_flags / move_messages / delete_messages / mark_all_read / empty_folder / create_folder /',
          '   delete_folder；发信用 send_message / reply_message / forward_message，草稿用 save_draft / send_draft。',
          '8. 发送、删除、移动前先把将要执行的内容展示给用户确认；Agent 不能永久删除单封邮件。',
          '9. 工具返回里出现 hint / note 字段时，遵循其中的指引行动。',
          '10. 按时间找信：search_messages / list_messages 都支持 since / before，'
          + '可填 上个月、上月、本月、去年、今年、去年10月、2025年10月、2025-10、7d、30d、'
          + '或 2026-10-01。「去年某个月」「2025年10月」这类说法本身是一段区间，'
          + '只传 since 就行，工具会自动补上另一端；返回里的 total 就是这段时间的封数。'
          + `时间说法按 ${tzName()} 时区解释——「上个月」是本地 1 号零点起，`
          + '不是 UTC 零点，凌晨到的信不会被算进上个月。',
          '11. 问「有没有来自 X 的邮件」「X 最近发过什么」时，用 from=X 过滤（list_messages 和 '
          + 'search_messages 都支持），不要只把 X 当关键词搜——关键词会连正文里提到 X 的信都算进来'
          + '（账单正文里有「华为京东自营」，搜「华为」就会命中银行账单）。问「新的」再加 unreadOnly=true。',
          '11b. 搜不到时不要直接说「没有」：先换成平台名/发件人域再搜（火车票→12306、'
          + '游戏订单→Steam、航班→行程单），最多换两次；仍然没有再说没有，并说明换过哪些词。',
          '12. read_message 默认给纯文本；如果正文里数字和标签对不上（账单、发票这类表格），'
          + '加 format=html 取原文再看一遍，别照着错位的数字下结论。',
        ].join('\n'),
      },
    );
    registerTools(server, auth);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,   // 无状态
      enableJsonResponse: true,        // 工具调用直接回 JSON，不套 SSE 流
    });

    res.on('close', () => {
      // 每个请求一套 server/transport，必须成对释放，否则连接会一点点攒起来
      try { transport.close(); } catch { /* 已关闭 */ }
      try { server.close(); } catch { /* 已关闭 */ }
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp] 请求处理失败', e);
      if (!res.headersSent) rpc(res, 500, -32603, '服务器内部错误');
    }
  });

  // 有状态模式才需要 GET（SSE 长连接）和 DELETE（结束会话），无状态下明确拒绝
  const notAllowed = (req, res) => {
    res.set('Allow', 'POST');
    rpc(res, 405, -32000, '这个 MCP 端点只接受 POST');
  };
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
