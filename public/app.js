/* MailNest 前端（无构建 Vue3） */
const { createApp } = Vue;

const PRESETS = {
  qq:     { label: 'QQ',       imap: ['imap.qq.com', 993],    smtp: ['smtp.qq.com', 465],    hint: 'QQ 邮箱需要在网页端「设置-账号」开启 IMAP/SMTP，并用 16 位授权码（不是 QQ 密码）。' },
  163:    { label: '163',      imap: ['imap.163.com', 993],   smtp: ['smtp.163.com', 465],   hint: '网易需要先在网页端开启 IMAP，并使用「客户端授权密码」；服务器要求客户端 ID，MailNest 已自动处理。' },
  126:    { label: '126',      imap: ['imap.126.com', 993],   smtp: ['smtp.126.com', 465],   hint: '同 163：网页端开启服务 + 客户端授权密码。' },
  sina:   { label: '新浪',     imap: ['imap.sina.com', 993],  smtp: ['smtp.sina.com', 465],  hint: '先在网页端开启 IMAP/SMTP 服务。' },
  gmail:  { label: 'Gmail',    imap: ['imap.gmail.com', 993], smtp: ['smtp.gmail.com', 465], hint: '需要开启两步验证并创建「应用专用密码」。' },
  outlook:{ label: 'Outlook',  imap: ['outlook.office365.com', 993], smtp: ['smtp.office365.com', 587], oauth: true, hint: '微软已停用密码登录，改走 OAuth 授权：先填一次应用 ID（下面的步骤），再点「连接 Outlook」按提示输验证码。' },
  qiye:   { label: '腾讯企业邮', imap: ['imap.exmail.qq.com', 993], smtp: ['smtp.exmail.qq.com', 465], hint: '腾讯企业邮箱，可用密码或安全登录授权码。' },
  aliyun: { label: '阿里企业邮', imap: ['imap.qiye.aliyun.com', 993], smtp: ['smtp.qiye.aliyun.com', 465], hint: '阿里企业邮箱。' },
};

function guessPreset(email) {
  if (/@(qq|foxmail)\.com$/i.test(email)) return 'qq';
  if (/@163\.com$/i.test(email)) return '163';
  if (/@126\.com$/i.test(email)) return '126';
  if (/@sina\.com$/i.test(email)) return 'sina';
  if (/@gmail\.com$/i.test(email)) return 'gmail';
  if (/@(outlook|hotmail|live)\./i.test(email)) return 'outlook';
  if (/@(.*?)exmail\.qq\.com$/i.test(email)) return 'qiye';
  if (/@qiye\.aliyun\.com$/i.test(email)) return 'aliyun';
  return null;
}

const PALETTE = ['#2d6cf6', '#7c3aed', '#0d9488', '#d97706', '#dc2626', '#059669', '#2563eb', '#c026d3', '#4f46e5', '#0284c7'];

const app = createApp({
  data() {
    return {
      view: 'auth',
      token: Date.now(),
      version: '',           // 由 /api/setup-status 下发，来源是 package.json
      // 默认按「已初始化」处理显示登录页；只有 setup-status 确认零用户时才切到注册页，
      // 避免旧标签页/刷新瞬间误显示「创建管理员」入口
      authMode: 'login',
      authForm: { username: '', password: '', password2: '' },
      authError: '',
      authBusy: false,
      showPw: false,

      me: { user: { displayName: '?', username: '', role: 'member' }, profile: {} },
      accounts: [],
      activeAccount: 'all',
      foldersByAccount: {},   // aid -> [folder]
      unreadMap: {},          // `${aid}|${path}` -> count
      loadErrors: [],         // 本次列表加载失败的账号名；非空时空态区显示重试按钮
      listError: null,        // 单夹列表加载失败的原因；非空时列表顶部显示「下方仍是上次内容」
      indexing: null,         // {done,total} 首次全量建索引进度（SSE 推送）
      prefetch: null,         // {done,pending,folder} 后台把正文缓存到本地的进度（SSE 推送）
      prefetchErr: null,      // 预热中断原因（SSE prefetch-error），恢复后自动清掉
      cacheInfo: null,        // 设置页「本地缓存」概览
      cacheBodies: 0,
      es: null,               // EventSource（实时推送）
      folders: [],
      activeFolder: 'INBOX',
      allFolder: null,        // all 模式下选中的 `aid|path`
      messages: [],
      total: 0,
      page: 1,
      pageSize: 50,
      loadingMessages: false,
      loadingMore: false,
      unreadOnly: false,
      selected: null,
      // 正在打开的邮件 key：慢连接上点一封没缓存的邮件要等一个 IMAP 来回，
      // 期间必须给反馈（行上转圈 + 阅读区提示），否则用户以为没点上会连点几次
      openingKey: null,
      searchQ: '',
      // 全邮箱搜索：回车触发，结果直接铺在列表区（FTS5 索引，跨账号跨文件夹）
      searchMode: false,
      searchHits: [],
      searching: false,
      searchInfo: '',
      syncing: false,

      compose: { open: false, accountId: '', to: '', cc: '', subject: '', text: '', attachments: [], sending: false, showCc: false, mode: 'new', replyTo: null, draftId: null, error: '' },
      quickReplyText: '',
      sendingQuick: false,

      acctOpen: false,
      avatarOpen: false,
      railOpen: false,
      readerOpen: false,
      readerMoveOpen: false,
      modals: { settings: false, users: false },
      settingsTab: 'accounts',
      addForm: { open: false, email: '', displayName: '', password: '', preset: null, color: PALETTE[0], imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465, testing: false, saving: false, message: '', ok: false },
      // Agent 接入：只存令牌元信息，明文只在创建那一次响应里出现
      agent: { tokens: [], name: '', scopes: ['read'], days: 90, busy: false, created: '', limit: 20 },
      scopeOptions: [{ key: 'read', label: '读取' }, { key: 'write', label: '整理' }, { key: 'send', label: '发信' }],
      palette: PALETTE,
      colorPickFor: null,
      editingId: null,      // 正在改显示名称的账号 id
      editName: '',
      editSaving: false,
      dragMsg: null,        // 正在拖动的邮件
      dropTarget: '',       // 高亮的投放目标 `账号id|文件夹路径`
      composeAskClose: false, // 关闭写信前的三选确认
      listWidth: Math.min(640, Math.max(300, Number(localStorage.getItem('mn.listWidth')) || 384)),
      resizing: false,      // 正在拖拽调节列表宽度
      // 多选：存 key（`账号id|文件夹|uid`），跨刷新也能对上
      selection: [],
      selAnchor: -1,
      // 右键菜单
      ctx: { open: false, x: 0, y: 0, m: null, sub: false },
      navCtx: { open: false, x: 0, y: 0, account: '', node: null },
      newFolder: { accountId: null, name: '', busy: false },
      // Outlook OAuth：应用 ID 由用户在界面上填一次，存在实例设置里
      outlook: {
        configured: false, clientId: '', registerUrl: '', deviceLoginUrl: '',
        idInput: '', savingId: false, error: '',
        device: null, polling: false, showSteps: false,
      },
      pw: { current: '', next: '', busy: false },
      users: [],
      userForm: { open: false, username: '', displayName: '', password: '', busy: false },
      theme: 'light',
      accent: 'blue',
      toasts: [],
    };
  },

  computed: {
    presets() { return Object.entries(PRESETS).map(([key, v]) => ({ key, label: v.label })); },
    presetHint() { return this.addForm.preset ? PRESETS[this.addForm.preset]?.hint || '' : ''; },
    // 选中 Outlook（或邮箱域名是微软的）时走 OAuth，不再给密码框
    addIsOauth() {
      if (PRESETS[this.addForm.preset]?.oauth) return true;
      return /@(outlook|hotmail|live|msn)\./i.test(this.addForm.email || '');
    },
    currentAccountLabel() {
      if (this.activeAccount === 'all') return '全部收件箱';
      const a = this.accounts.find((x) => x.id === this.activeAccount);
      return a ? a.displayName : '';
    },
    currentSwatch() {
      if (this.activeAccount === 'all') return 'linear-gradient(145deg,#7c8cff,#4d5ef0)';
      return this.accounts.find((x) => x.id === this.activeAccount)?.color || '#2d6cf6';
    },
    allUnread() {
      let n = 0;
      for (const [k, v] of Object.entries(this.unreadMap)) if (k.endsWith('|INBOX')) n += v;
      return n;
    },
    // MCP 接入地址：跟着当前访问域名走，用户从 NAS 内网打开就是内网地址
    mcpUrl() { return location.origin + '/mcp'; },
    // 刚生成令牌时给的客户端配置片段，直接复制粘贴就能用
    agentConfig() {
      return JSON.stringify({
        mcpServers: {
          mailnest: {
            type: 'http',
            url: this.mcpUrl,
            headers: { Authorization: `Bearer ${this.agent.created}` },
          },
        },
      }, null, 2);
    },
    // 对话式客户端（Claude Code、WorkBuddy 等）不必手改 JSON，把这句话发过去它自己配
    agentBrief() {
      return `添加一个 MCP 服务器：名称 mailnest，类型 HTTP，地址 ${this.mcpUrl}，请求头 Authorization: Bearer ${this.agent.created}`;
    },
    // 当前列表里能被选中的行（搜索 + 只看未读过滤后的可见行）
    visibleRows() { return this.filteredMessages; },
    selCount() { return this.selection.length; },
    allSelected() {
      const rows = this.visibleRows;
      return rows.length > 0 && rows.every((m) => this.selection.includes(this.msgKey(m)));
    },
    selHasUnread() {
      return this.messages.some((m) => this.selection.includes(this.msgKey(m)) && !m.flags.includes('\\Seen'));
    },
    filteredMessages() {
      // 搜索结果已由服务端按关键词过滤（命中正文也算），不能再被本地主题/发件人过滤掉一遍
      if (this.searchMode) return this.searchHits;
      let rows = this.messages;
      if (this.searchQ) rows = rows.filter((m) => this.msgMatch(m));
      if (this.unreadOnly) rows = rows.filter((m) => !m.flags.includes('\\Seen'));
      return rows;
    },
    // 当前视图对应的账号+文件夹（滚动加载、全部已读、清空共用）
    curFolderRef() {
      if (this.activeAccount === 'all') {
        if (!this.allFolder) return null;
        const sep = this.allFolder.indexOf('|');
        return { account: this.allFolder.slice(0, sep), folder: this.allFolder.slice(sep + 1) };
      }
      return { account: this.activeAccount, folder: this.activeFolder };
    },
    curFolderNode() {
      const ref = this.curFolderRef;
      if (!ref) return null;
      return this.foldersOf(ref.account).find((f) => f.path === ref.folder) || null;
    },
    // 清空只对真删除的垃圾箱类文件夹开放（服务端同样校验）
    canEmpty() { return ['\\Trash', '\\Junk'].includes(this.curFolderNode?.special); },
    // 已删除/垃圾/已发送/草稿没有未读语义，「未读」筛选和「全部已读」不该出现（汇总视图 curFolderNode 为 null → 正常显示）
    showReadTools() { return !['\\Trash', '\\Junk', '\\Sent', '\\Drafts'].includes(this.curFolderNode?.special); },
    listTitle() {
      if (this.searchMode) return `搜索「${this.searchQ}」`;
      if (this.activeAccount === 'all') {
        // 汇总视图：没选具体文件夹时是跨账号的「全部收件箱」；点了某账号的某文件夹要如实显示
        if (!this.allFolder) return '全部收件箱';
        const sep = this.allFolder.indexOf('|');
        const aid = this.allFolder.slice(0, sep), path = this.allFolder.slice(sep + 1);
        const f = this.foldersOf(aid).find((x) => x.path === path);
        const acc = this.accounts.find((a) => a.id === aid);
        const name = f ? this.folderLabel(f) : path;
        return acc ? `${name} · ${acc.displayName}` : name;
      }
      const f = this.folders.find((x) => x.path === this.activeFolder);
      return f ? this.folderLabel(f) : this.activeFolder;
    },
    totalAttachSize() { return this.compose.attachments.reduce((s, a) => s + a.size, 0); },
    // 邮件正文包一层最小 HTML 再放进沙箱 iframe（srcdoc）。直接 v-html 会把邮件自带
    // 的 <style> 泄漏进主页面（TMDB/Steam 这类模板邮件能把整页染花）；iframe 内互不影响。
    emailDoc() {
      const h = this.selected?.html || '';
      if (!h) return '';
      return '<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank">'
        + '<style>html,body{margin:0;padding:0;background:#fff;color:#24292f;'
        + 'font:14px/1.75 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;word-break:break-word}'
        + 'img{max-width:100%;height:auto}'
        // 「裸表格补边框」只针对真·裸表（无 style 也无 width 属性）：模板布局表用
        // width="600" 属性定宽、无 style，若按选择器补 width:100% 会覆盖属性把布局打碎
        + 'table:not([style]):not([width]){border-collapse:collapse;margin:10px 0}'
        + 'table:not([style]):not([width]) td,table:not([style]):not([width]) th{border:1px solid #e3e6ea;padding:6px 10px;font-size:13px}'
        + 'table:not([style]):not([width]) th{background:#f5f6f8}'
        + 'blockquote{margin:10px 0;padding:2px 14px;border-left:3px solid #d0d7de;color:#57606a}'
        + '</style></head><body>' + h + '</body></html>';
    },
  },

  watch: {
    // 换邮件 / 关阅读区时，旧正文的尺寸观察器跟着作废，别挂在已卸载的文档上
    selected() {
      if (this._frameRO) { this._frameRO.disconnect(); this._frameRO = null; }
    },
  },

  methods: {
    // ---------- 基础 ----------
    async api(path, opts = {}) {
      const res = await fetch(path, {
        method: opts.method || 'GET',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MailNest' },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      if (res.status === 401 && this.view === 'app') {
        // 会话过期时直接跳回登录页会让人莫名其妙（正在写信的内容也看不见了），
        // 登录页上要说清原因，写信草稿留在内存里，重新登录还在
        this.view = 'auth'; this.authMode = 'login';
        this.authError = this.compose.open || this.compose.text
          ? '登录已过期，请重新登录（未发送的内容仍保留在写信窗口）'
          : '登录已过期，请重新登录';
        throw Object.assign(new Error('登录已过期'), { handled: true });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || `请求失败 (${res.status})`), { status: res.status });
      return data;
    },
    toast(text, type = '') {
      const id = Date.now() + Math.random();
      this.toasts.push({ id, text, type });
      setTimeout(() => { this.toasts = this.toasts.filter((t) => t.id !== id); }, 4200);
    },
    initials(s) {
      const c = (s || '?').trim();
      return /[a-zA-Z]/.test(c[0] || '') ? c[0].toUpperCase() : c.slice(0, 1) || '?';
    },
    shortDate(d) {
      if (!d) return '';
      const dt = new Date(d), now = new Date();
      const sameDay = dt.toDateString() === now.toDateString();
      return sameDay
        ? dt.toTimeString().slice(0, 5)
        : `${dt.getMonth() + 1}/${dt.getDate()}`;
    },
    fullDate(d) {
      if (!d) return '';
      const dt = new Date(d);
      const p = (n) => String(n).padStart(2, '0');
      return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日 ${p(dt.getHours())}:${p(dt.getMinutes())}`;
    },
    fmtSize(n) {
      if (n == null) return '';
      if (n < 1024) return `${n} B`;
      if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / 1048576).toFixed(1)} MB`;
    },
    roleLabel(r) { return r === 'owner' ? '所有者' : r === 'admin' ? '管理员' : '成员'; },
    accentColor(c) { return { blue: '#2d6cf6', indigo: '#5a5bd6', teal: '#0d8f83', amber: '#b8620d' }[c] || '#2d6cf6'; },

    // ---------- 主题 ----------
    applyTheme() {
      document.documentElement.dataset.theme = this.theme;
      document.documentElement.dataset.accent = this.accent;
      localStorage.setItem('mn-theme', this.theme);
      this.api('/api/me', { method: 'PATCH', body: { theme: this.theme, accent: this.accent } }).catch(() => {});
    },
    toggleTheme() { this.theme = this.theme === 'dark' ? 'light' : 'dark'; this.applyTheme(); },
    setAccent(c) { this.accent = c; this.applyTheme(); },

    // ---------- 认证 ----------
    async submitAuth() {
      this.authError = '';
      if (this.authMode === 'setup' && this.authForm.password !== this.authForm.password2) {
        this.authError = '两次输入的密码不一致'; return;
      }
      this.authBusy = true;
      try {
        if (this.authMode === 'setup') {
          await this.api('/api/setup', { method: 'POST', body: this.authForm });
        } else {
          await this.api('/api/login', { method: 'POST', body: { username: this.authForm.username, password: this.authForm.password } });
        }
        await this.enterApp();
      } catch (e) {
        this.authError = e.message;
        // 旧标签页还停在注册表单时，后端会以 403「已初始化」拒绝——自动切到登录页
        if (e.status === 403 && this.authMode === 'setup') {
          this.authMode = 'login';
          this.authForm.password = ''; this.authForm.password2 = '';
        }
      } finally {
        this.authBusy = false;
      }
    },
    async logout() {
      this.avatarOpen = false;
      this.disconnectEvents();
      try { await this.api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
      this.view = 'auth'; this.authMode = 'login'; this.authForm = { username: '', password: '', password2: '' };
    },
    async enterApp() {
      const me = await this.api('/api/me');
      this.me = me;
      this.theme = me.profile.theme || localStorage.getItem('mn-theme') || 'light';
      this.accent = me.profile.accent || 'blue';
      document.documentElement.dataset.theme = this.theme;
      document.documentElement.dataset.accent = this.accent;
      const data = await this.api('/api/accounts');
      this.accounts = data.accounts;
      this.view = 'app';
      await this.loadAllFoldersAndUnread();
      this.pickAccount('all');
      this.connectEvents();
    },

    // ---------- 实时推送（SSE，服务端 IMAP IDLE 驱动） ----------
    connectEvents() {
      if (this.es) return;
      const es = new EventSource('/api/events');
      this.es = es;
      es.onmessage = (e) => {
        let d;
        try { d = JSON.parse(e.data); } catch { return; }
        this.onServerEvent(d);
      };
      // 普通断网由 EventSource 原生重连；CLOSED 表示服务端明确拒绝（如会话过期），
      // 浏览器不会再试，此时必须告诉用户，否则实时收信静默失效、毫无感知
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          this.toast('实时推送已断开，刷新页面可恢复（邮件仍可正常加载）', 'warn');
        }
      };
    },
    // SSE 事件分发：独立成方法，便于不启浏览器直接喂事件做断言
    onServerEvent(d) {
      if (!d || typeof d !== 'object') return;
      if (d.type === 'indexing') {
        // 建索引进度：完成（或全部夹处理完）就收掉进度条
        this.indexing = d.done >= d.total ? null : { done: d.done, total: d.total };
        return;
      }
      if (d.type === 'prefetch') {
        // 后台正文缓存进度：一批批把新邮件存到本地，完成时收起
        this.prefetchErr = null;
        if (d.finished) { this.prefetch = null; return; }
        this.prefetch = { done: d.done, pending: d.pending, folder: d.folder };
        return;
      }
      if (d.type === 'prefetch-error') {
        // 缓存中断：进度条位置显示原因（连接失败/网络问题等），恢复后自动变回进度
        this.prefetchErr = d.message || '未知错误';
        return;
      }
      // 事件里的这个文件夹是否正显示在屏幕上（含「全部收件箱」汇总视图里的 INBOX）
      const ref = this.curFolderRef;
      const isCur = ref && ref.account === d.accountId && ref.folder === d.folder;
      const isSummaryInbox = this.activeAccount === 'all' && !this.allFolder && d.folder === 'INBOX';
      const onScreen = !!(isCur || isSummaryInbox);

      if (d.type === 'flags') {
        // 别的客户端（网页/手机）把信标成已读或加星：就地改行，不重载列表 ——
        // 一次已读变动就整表闪一下，比不同步还难受
        if (typeof d.unseen === 'number') this.unreadMap[`${d.accountId}|${d.folder}`] = d.unseen;
        if (Array.isArray(d.flags) && Array.isArray(d.uids)) {
          const set = new Set(d.uids);
          const hit = (m) => m && m.accountId === d.accountId && (m.folder || d.folder) === d.folder && set.has(m.uid);
          for (const m of this.messages) if (hit(m)) m.flags = d.flags.slice();
          if (hit(this.selected)) this.selected.flags = d.flags.slice();
        }
        return;
      }
      if (d.type === 'expunge') {
        // 别的客户端把信删了/移走了：本地缓存已 prune，列表那一行必须跟着消失，
        // 否则点开会报「邮件不存在」，用户以为丢信了
        if (typeof d.unseen === 'number') this.unreadMap[`${d.accountId}|${d.folder}`] = d.unseen;
        if (onScreen && !this.searchMode) this.loadMessages().catch(() => { /* loadMessages 内部已 toast */ });
        return;
      }
      if (d.type === 'folder-synced') {
        // 后台对账完成（手动刷新等不及先回了缓存，或打开文件夹时自动追平）
        if (!onScreen) return;
        if (this.page > 1) return; // 用户正翻到第 N 页，别被后台同步弹回第一页
        this.loadMessages().catch(() => { /* loadMessages 内部已 toast */ });
        return;
      }
      if (d.type === 'watch-error') {
        // 监听断了会自动重连，只提示一次，别每次重试都弹
        if (!this._watchErrAt || Date.now() - this._watchErrAt > 5 * 60_000) {
          this._watchErrAt = Date.now();
          this.toast('实时收信暂时中断，正在自动重连', 'warn');
        }
        return;
      }
      if (d.type === 'empty-done' || d.type === 'empty-error') {
        if (d.type === 'empty-done') {
          this.toast(d.count ? `已彻底删除 ${d.count} 封邮件` : '文件夹已清空', 'ok');
          // 成功也重拉一次：防「清空瞬间有个在跑的对账把旧行写回缓存」的竞态，
          // 让界面以服务端为准（有残留立刻能看见，而不是过几分钟邮件“复活”）
          if (onScreen) {
            this.page = 1;
            this.loadMessages().catch(() => { /* loadMessages 内部已 toast */ });
          }
        } else {
          this.toast(`清空失败：${d.message}`, 'error');
          if (onScreen) {
            this.page = 1;
            this.loadMessages().catch(() => { /* loadMessages 内部已 toast */ });
          }
        }
        return;
      }
      if (d.type !== 'new-mail') return;
      // 角标直接采用推送的该夹未读数（服务端缓存里算好的）
      if (typeof d.unseen === 'number') this.unreadMap[`${d.accountId}|${d.folder}`] = d.unseen;
      const acc = this.accounts.find((a) => a.id === d.accountId);
      const name = acc?.displayName || d.email || '邮箱';
      this.toast(`${name} 收到 ${d.count} 封新邮件`, 'ok');
      // 正开着这个文件夹就静默重载第一页（缓存已由监听器更新，这次拉取是纯本地库查询）
      if (onScreen) {
        this.page = 1;
        this.loadMessages().catch(() => { /* loadMessages 内部已 toast */ });
      }
    },
    disconnectEvents() {
      if (this.es) { this.es.close(); this.es = null; }
    },

    // ---------- 账号 / 文件夹 ----------
    async loadAllFoldersAndUnread() {
      const jobs = this.accounts.map(async (a) => {
        try {
          const [f, u] = await Promise.all([
            this.api(`/api/folders?account=${a.id}`),
            this.api(`/api/unread?account=${a.id}`),
          ]);
          this.foldersByAccount[a.id] = f.folders;
          for (const [path, count] of Object.entries(u.counts || {})) this.unreadMap[`${a.id}|${path}`] = count;
        } catch (e) {
          this.toast(`${a.displayName}：${e.message}`, 'error');
        }
      });
      await Promise.allSettled(jobs);
      // 单账号视图的 this.folders 持有的是旧数组引用，刷新后要重新指向（否则新建的文件夹不出现）
      if (this.activeAccount !== 'all') this.folders = this.foldersOf(this.activeAccount);
    },
    foldersOf(aid) { return this.foldersByAccount[aid] || []; },
    unseenOf(aid, path) { return this.unreadMap[`${aid}|${path}`] || 0; },
    unreadOf(aid) { return this.unreadMap[`${aid}|INBOX`] || 0; },
    folderLabel(f) {
      if (f.path === 'INBOX') return '收件箱';
      const map = { '\\Sent': '已发送', '\\Drafts': '草稿', '\\Trash': '已删除', '\\Junk': '垃圾邮件', '\\Archive': '归档', '\\Flagged': '星标' };
      if (f.special && map[f.special]) return map[f.special];
      return f.name;
    },

    // ---------- 新建文件夹 ----------
    startNewFolder(accountId) {
      this.newFolder = { accountId, name: '', busy: false };
      this.$nextTick(() => {
        const el = document.querySelector(`.new-folder-input[data-acc="${accountId}"]`);
        if (el) el.focus();
      });
    },
    cancelNewFolder() { this.newFolder = { accountId: null, name: '', busy: false }; },
    async createFolder(accountId) {
      const name = this.newFolder.name.trim();
      const delim = (this.foldersOf(accountId).find((f) => f.delim) || {}).delim || '/';
      if (!name) return this.toast('文件夹名称不能为空', 'error');
      if (name.includes(delim) || name.includes('/')) return this.toast(`名称里不要带分隔符「${delim}」`, 'error');
      if (this.foldersOf(accountId).some((f) => f.path === name)) return this.toast('同名文件夹已存在', 'error');
      this.newFolder.busy = true;
      try {
        const data = await this.api('/api/folders', { method: 'POST', body: { account: accountId, path: name } });
        this.foldersByAccount[accountId] = data.folders;
        if (this.activeAccount === accountId) this.folders = this.foldersOf(accountId);
        this.cancelNewFolder();
        this.toast(`已创建「${name}」`, 'ok');
      } catch (e) {
        this.newFolder.busy = false;   // 失败时保留输入，方便改名重试
        this.toast(e.message, 'error');
      }
    },

    // ---------- 拖放整理（列表行 → 左栏文件夹）----------
    onDragStart(e, m) {
      this.dragMsg = m;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', `${m.accountId}:${m.uid}`); } catch { /* 个别浏览器不允许 */ }
      }
    },
    onDragEnd() { this.dragMsg = null; this.dropTarget = ''; },

    // ---------- 列表宽度拖拽 ----------
    startListResize(e) {
      this.resizing = true;
      document.body.classList.add('col-resizing');
      const startX = e.clientX, startW = this.listWidth;
      const move = (ev) => {
        // 分割线在列表右缘：向右拖 = 列表变宽
        const w = Math.min(720, Math.max(300, startW + (ev.clientX - startX)));
        this.listWidth = w;
      };
      const up = () => {
        this.resizing = false;
        document.body.classList.remove('col-resizing');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        try { localStorage.setItem('mn.listWidth', String(this.listWidth)); } catch {}
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    },
    resetListWidth() { this.listWidth = 384; try { localStorage.setItem('mn.listWidth', '384'); } catch {} },

    canDropOn(accountId, path) {
      const m = this.dragMsg;
      if (!m) return false;
      if (m.accountId !== accountId) return false;             // 跨账号要 COPY+DELETE，暂不支持
      return (m.folder || this.currentFolderOf(m)) !== path;    // 拖回原文件夹没意义
    },
    onDragOver(accountId, path) {
      if (!this.canDropOn(accountId, path)) return;
      this.dropTarget = `${accountId}|${path}`;
    },
    onDragLeave(accountId, path) {
      if (this.dropTarget === `${accountId}|${path}`) this.dropTarget = '';
    },
    async onDrop(accountId, path) {
      const m = this.dragMsg;
      this.dragMsg = null; this.dropTarget = '';
      if (!m) return;
      if (m.accountId !== accountId) return this.toast('暂不支持在不同邮箱之间搬邮件', 'error');
      if ((m.folder || this.currentFolderOf(m)) === path) return;
      await this.moveMessageTo(m, path);
    },
    async moveMessageTo(m, dest) {
      try {
        await this.api('/api/move', { method: 'POST', body: { account: m.accountId, folder: m.folder || this.currentFolderOf(m), uids: [m.uid], dest } });
        this.messages = this.messages.filter((x) => !(x.uid === m.uid && x.accountId === m.accountId));
        if (this.selected && this.selected.uid === m.uid && this.selected.accountId === m.accountId) {
          this.selected = null; this.readerOpen = false;
        }
        this.loadAllFoldersAndUnread();
        const f = this.foldersOf(m.accountId).find((x) => x.path === dest);
        this.toast(`已移动到「${f ? this.folderLabel(f) : dest}」`, 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
    },

    pickAccount(id) {
      this.acctOpen = false;
      this.activeAccount = id;
      this.selected = null; this.readerOpen = false;
      this.page = 1; this.searchQ = '';
      this.clearSel();
      if (id === 'all') {
        this.allFolder = null;
      } else {
        this.folders = this.foldersOf(id);
        const inbox = this.folders.find((f) => f.path === 'INBOX') || this.folders[0];
        this.activeFolder = inbox ? inbox.path : 'INBOX';
      }
      this.loadMessages();
    },
    pickFolder(path) {
      this.activeFolder = path;
      this.selected = null; this.readerOpen = false;
      this.page = 1; this.searchQ = '';
      this.clearSel();
      this.loadMessages();
    },
    // 左栏「全部收件箱」：回到 activeAccount==='all' 且 allFolder===null 的跨账号归并视图
    pickAllInbox() {
      if (this.activeAccount === 'all' && !this.allFolder) { this.loadMessages(); return; }
      this.pickAccount('all');
    },
    pickAllFolder(aid, path) {
      this.allFolder = `${aid}|${path}`;
      this.selected = null; this.readerOpen = false;
      this.page = 1; this.searchQ = '';
      this.clearSel();
      this.loadMessages();
    },
    gotoPage(p) { this.page = p; this.clearSel(); this.loadMessages(); },

    // 滚动加载：接近底部时拉下一页并追加。切文件夹/账号时 page 已被重置为 1
    async loadMore() {
      if (this.searchMode) return; // 搜索结果是一次性全量返回，没有下一页
      if (this.loadingMessages || this.loadingMore) return;
      if (!this.total || this.messages.length >= this.total) return;
      this.page++;
      await this.loadMessages(true);
    },
    onRowsScroll(e) {
      const el = e.target;
      if (el.scrollTop + el.clientHeight < el.scrollHeight - 400) return;
      this.loadMore();
    },

    async loadMessages(append = false, sync = false) {
      if (append) this.loadingMore = true; else this.loadingMessages = true;
      // 代际号：快速切换文件夹/账号时，慢的旧响应不允许覆盖新请求的结果
      const gen = (this._loadGen = (this._loadGen || 0) + 1);
      if (!append) { this.loadErrors = []; this.listError = null; }
      let progressive = false; // 汇总视图自行管理 loading 收尾（分账号到达），跳过统一 finally
      try {
        if (this.activeAccount === 'all' && !this.allFolder) {
          progressive = true;
          // 汇总视图：各账号 INBOX 并行拉取，**谁先回来先渲染谁**——
          // outlook 冷连接十几秒，Promise.all 会把 QQ/163 已就绪的邮件一起拖住；
          // 单账号失败只记名字（列表头下方给重试按钮），不再假装「文件夹是空的」
          const parts = new Map(); // aid -> {total, messages}
          const failed = [];
          let syncNotified = false; // 多账号同时后台同步只提示一次，别刷屏
          let settled = 0;
          const apply = () => {
            if (gen !== this._loadGen) return; // 已被新请求取代
            const merged = [...parts.values()].flatMap((p) => p.messages)
              .sort((x, y) => new Date(y.date || 0) - new Date(x.date || 0));
            this.total = [...parts.values()].reduce((sum, p) => sum + p.total, 0);
            // 追加时不截断：跨账号归并翻页本来就有交错误差，再截断会把行永远弄丢
            this.messages = append ? this.messages.concat(merged) : merged;
            this.loadErrors = failed.slice();
            // 有账号失败时自动补试一次（网络抖动多半几秒内自愈）；成功后复位
            if (failed.length && !this._loadRetried) {
              this._loadRetried = true;
              setTimeout(() => {
                if (this.view === 'app' && this.loadErrors.length && gen === this._loadGen) this.loadMessages(false, sync);
              }, 4000);
            } else if (!failed.length) {
              this._loadRetried = false;
            }
          };
          for (const a of this.accounts) {
            this.api(`/api/messages?account=${a.id}&folder=INBOX&page=${this.page}&pageSize=${this.pageSize}${sync ? '&sync=1' : ''}`)
              .then((d) => {
                if (sync && !syncNotified && (d.backgroundSync || d.syncError)) {
                  syncNotified = true;
                  if (d.syncError) this.toast(`同步失败：${d.syncError}`, 'error');
                  else this.toast('邮件较多，正在后台同步，完成后会自动刷新', 'ok');
                }
                // folder 必须显式带上：汇总视图里的星标/删除/归档都靠它定位邮件
                parts.set(a.id, { total: d.total || 0,
                  messages: (d.messages || []).map((m) => ({ ...m, accountId: a.id, folder: 'INBOX', accountEmail: a.email, _color: a.color })) });
              })
              .catch((e) => { failed.push(a.displayName || a.email); this.toast(`${a.displayName}：${e.message}`, 'error'); })
              .finally(() => {
                settled++;
                if (gen !== this._loadGen) return;
                apply();
                if (settled === this.accounts.length) this.loadingMessages = false;
              });
          }
          return; // loadingMessages 由最后一个 finally 收掉
        } else {
          let aid, folder;
          if (this.activeAccount === 'all') {
            [aid, folder] = this.allFolder.split('|');
          } else {
            aid = this.activeAccount; folder = this.activeFolder;
          }
          const d = await this.api(`/api/messages?account=${aid}&folder=${encodeURIComponent(folder)}&page=${this.page}&pageSize=${this.pageSize}${sync ? '&sync=1' : ''}`);
          if (gen !== this._loadGen) return;
          // 服务端最多等 8 秒，大夹先回旧缓存、同步在后台继续 —— 必须告知，否则「点了刷新没变化」又是无头案
          if (sync && d.syncError) this.toast(`同步失败：${d.syncError}`, 'error');
          else if (sync && d.backgroundSync) this.toast('邮件较多，正在后台同步，完成后会自动刷新', 'ok');
          const acc = this.accounts.find((a) => a.id === aid);
          const rows = d.messages.map((m) => ({ ...m, accountId: aid, folder: m.folder || folder, accountEmail: acc?.email || '', _color: acc?.color || '#2d6cf6' }));
          this.messages = append ? this.messages.concat(rows) : rows;
          this.total = d.total;
          this.listError = null;
        }
        // 正文预取交给服务端的预热队列（按文件夹顺序填，只在空闲连接上跑）。
        // 前端再串行拉 15 封只会跟「用户真正点开的那一封」抢同一把连接锁，越帮越慢。
      } catch (e) {
        if (append) this.page--; // 追加失败回退页码，下次滚动还能重试
        // 非追加失败时旧列表会留在屏幕上 —— 必须明说「没换成」，否则用户只看到
        // 点了文件夹没反应（切夹卡住最直观的表现就是这个）
        if (!append && !e.handled) this.listError = e.message || '加载失败';
        if (!e.handled) this.toast(e.message, 'error');
      } finally {
        if (!progressive) this.loadingMessages = false; // 汇总视图在分账号 finally 里收
        this.loadingMore = false;
      }
    },

    // 列表加载失败后的手动重试（自动补试也会走这里）
    retryLoad() {
      this.loadErrors = [];
      this.listError = null;
      this.page = 1;
      this.loadMessages();
    },
    // ---------- 全邮箱搜索 ----------
    onSearchInput() {
      // 清空输入即退出搜索，回到原来的文件夹列表
      if (!this.searchQ && this.searchMode) this.exitSearch();
    },
    async searchAll() {
      const q = this.searchQ.trim();
      if (!q) { this.exitSearch(); return; }
      if (this.searching) return;
      this.searching = true;
      try {
        const d = await this.api(`/api/search?q=${encodeURIComponent(q)}&limit=50`);
        this.searchHits = (d.hits || []).map((h) => ({ ...h, _color: h.color || '#2d6cf6' }));
        this.searchMode = true;
        this.searchInfo = d.indexing ? '部分账号还没建完索引，稍后再搜可能有更多结果' : '';
        this.selected = null;
        this.readerOpen = false;
        this.clearSel();
      } catch (e) {
        this.toast(e.message, 'error');
      } finally {
        this.searching = false;
      }
    },
    exitSearch() {
      this.searchMode = false;
      this.searchHits = [];
      this.searchInfo = '';
      this.searchQ = '';
    },

    async refreshAll() {
      if (this.syncing) return;
      this.syncing = true;
      try {
        await this.loadAllFoldersAndUnread();
        // 手动刷新走 sync=1：服务端整夹快照重同步，保证与服务器强一致
        await this.loadMessages(false, true);
      } finally { this.syncing = false; }
    },

    // ---------- 整夹操作（服务端全集，不依赖已加载多少行） ----------
    // 全部标为已读：汇总视图 = 各账号 INBOX 一起；服务端 STORE 1:* 一次完成
    async readAllFolder() {
      const jobs = (this.activeAccount === 'all' && !this.allFolder)
        ? this.accounts.map((a) => ({ account: a.id, folder: 'INBOX' }))
        : [this.curFolderRef];
      try {
        await Promise.all(jobs.map((j) => this.api('/api/folders/read-all', { method: 'POST', body: j })));
        // 本地同步：已加载行原地补 \Seen（flags 是共享数组，阅读区同步变化），
        // 未读数清零，左栏角标立即归零
        const keys = new Set(jobs.map((j) => `${j.account}|${j.folder}`));
        for (const m of this.messages) {
          if (keys.has(`${m.accountId}|${m.folder}`) && !m.flags.includes('\\Seen')) m.flags.push('\\Seen');
        }
        for (const j of jobs) this.unreadMap[`${j.account}|${j.folder}`] = 0;
        this.toast('已全部标为已读', 'ok');
      } catch (e) {
        this.toast(e.message, 'error');
        this.loadAllFoldersAndUnread(); // 部分成功时以服务器状态为准刷新角标
      }
    },
    // 清空：只对已删除/垃圾邮件开放，服务端二次校验 special
    async emptyTrash() {
      const ref = this.curFolderRef;
      if (!ref) return;
      const n = this.total;
      if (!confirm(`清空「${this.listTitle}」？其中全部 ${n} 封邮件将被永久删除，无法恢复。`)) return;
      // 乐观清空：界面立刻变空，真正的 IMAP 删除由服务端后台跑（Outlook 上几千封 EXPUNGE 要几十秒，
      // 同步等会让按钮像卡死）。失败时回滚，并由 SSE 的 empty-error 提示 + 重新拉取。
      const backupRows = this.messages;
      const backupTotal = this.total;
      this.messages = [];
      this.total = 0;
      this.clearSel();
      this.page = 1;
      this.unreadMap[`${ref.account}|${ref.folder}`] = 0;
      if (n) this.toast(`已清空 ${n} 封，正在后台删除…`, 'ok');
      try {
        await this.api('/api/folders/empty', { method: 'POST', body: ref });
      } catch (e) {
        this.messages = backupRows;
        this.total = backupTotal;
        this.toast(e.message, 'error');
      }
    },

    // ---------- 阅读 ----------
    async openMessage(m) {
      const key = this.msgKey(m);
      // 代际号：连点几封时只认最后一次点击。慢连接上 A 的响应可能晚于 B 到达，
      // 没有这个守卫就会出现「点了 B，阅读区显示的是 A」
      const gen = (this._openGen = (this._openGen || 0) + 1);
      this.openingKey = key;
      // 移动端阅读区是整屏覆盖层，不先打开的话点了完全没反应
      this.readerOpen = true;
      try {
        const full = await this.api(`/api/message?account=${m.accountId}&folder=${encodeURIComponent(m.folder || this.currentFolderOf(m))}&uid=${m.uid}`);
        if (gen !== this._openGen) return;
        this.selected = { ...full, ...m, folder: m.folder || this.currentFolderOf(m) };
        this.quickReplyText = '';
        this.readerMoveOpen = false;
        // 以服务端 flags 为准，把列表里可能过期的星标/已读状态对齐（在别处标过星也能立刻反映）
        for (const f of ['\\Seen', '\\Flagged']) {
          const has = (full.flags || []).includes(f);
          if (m.flags.includes(f) !== has) this.setFlag(m, f, has);
        }
        if (!m.flags.includes('\\Seen')) {
          this.setFlag(m, '\\Seen', true);
          this.api('/api/flags', { method: 'POST', body: { account: m.accountId, folder: m.folder || this.currentFolderOf(m), uid: m.uid, action: 'read' } })
            .then(() => this.loadAllFoldersAndUnread()).catch(() => {});
        }
      } catch (e) {
        if (gen !== this._openGen) return;
        // 打不开就退回原状，别让阅读区停在一个空白骨架屏上
        this.readerOpen = !!this.selected;
        if (!e.handled) this.toast(e.message, 'error');
      } finally {
        if (gen === this._openGen) this.openingKey = null;
      }
    },
    // 沙箱 iframe 高度自适应：load 时量一次；图片懒加载、字体替换导致的后续变高
    // 由 ResizeObserver 补量。宽出容器的邮件（固定 600px 模板）留出横向滚动条高度。
    fitFrame(e) {
      const f = e && e.target;
      if (!f) return;
      try {
        const doc = f.contentDocument;
        if (!doc) return;
        const fit = () => {
          const de = doc.documentElement;
          const h = Math.max(de.scrollHeight, doc.body ? doc.body.scrollHeight : 0);
          if (h <= 0) return;
          const wide = de.scrollWidth > de.clientWidth;
          f.style.height = (h + (wide ? 18 : 2)) + 'px';
        };
        fit();
        if (this._frameRO) this._frameRO.disconnect();
        this._frameRO = new ResizeObserver(fit);
        this._frameRO.observe(doc.documentElement);
      } catch { /* 同源沙箱不会走到这里，兜个底而已 */ }
    },

    // 键盘上下切换当前邮件（j/k 或 ↑/↓）
    stepMessage(delta) {
      const rows = this.filteredMessages;
      if (!rows.length) return;
      const at = rows.findIndex((x) => this.selected && x.uid === this.selected.uid && x.accountId === this.selected.accountId);
      let i = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : at + delta;
      i = Math.max(0, Math.min(rows.length - 1, i));
      const m = rows[i];
      if (!m || (at === i && this.selected)) return;
      this.openMessage(m);
      // 键盘走到屏幕外的行要跟着滚，否则选中了也看不见
      this.$nextTick(() => {
        const el = document.querySelector('.row.is-active');
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      });
    },
    currentFolderOf(m) {
      if (m.folder) return m.folder;
      if (this.activeAccount === 'all') return this.allFolder ? this.allFolder.split('|')[1] : 'INBOX';
      return this.activeFolder;
    },
    // 同一封邮件在「列表项」和「阅读区 selected」里是两份对象（flags 还可能共用同一个数组）。
    // 只改其中一份 ⇒ 列表的星标一直亮着、再点又变回星标。所以统一在这里改，且原地增删。
    flagTargets(m) {
      const same = (x) => x && x.uid === m.uid && x.accountId === m.accountId;
      const list = this.messages.concat(this.searchHits).filter(same);
      if (same(this.selected)) list.push(this.selected);
      list.push(m);
      return [...new Set(list)];
    },
    setFlag(m, flag, on) {
      for (const t of this.flagTargets(m)) {
        if (!Array.isArray(t.flags)) continue;
        const i = t.flags.indexOf(flag);
        if (on && i < 0) t.flags.push(flag);
        else if (!on && i >= 0) t.flags.splice(i, 1);
      }
    },
    async markRead(m, read) {
      this.setFlag(m, '\\Seen', read);
      try {
        await this.api('/api/flags', { method: 'POST', body: { account: m.accountId, folder: m.folder || this.currentFolderOf(m), uid: m.uid, action: read ? 'read' : 'unread' } });
        this.loadAllFoldersAndUnread();
      } catch (e) {
        this.setFlag(m, '\\Seen', !read);
        this.toast(e.message, 'error');
      }
    },
    async toggleStar(m) {
      const on = m.flags.includes('\\Flagged');
      this.setFlag(m, '\\Flagged', !on); // 先动界面，失败再回滚
      try {
        await this.api('/api/flags', { method: 'POST', body: { account: m.accountId, folder: m.folder || this.currentFolderOf(m), uid: m.uid, action: on ? 'unstar' : 'star' } });
        this.loadAllFoldersAndUnread();
      } catch (e) {
        this.setFlag(m, '\\Flagged', on);
        this.toast(e.message, 'error');
      }
    },
    async remove(m) {
      const trash = (this.foldersByAccount[m.accountId] || []).find((f) => f.special === '\\Trash');
      // 少数服务器不给 \Trash 标记：与其抛一个 undefined 的技术错误，不如说人话
      if (!trash) { this.toast('这个邮箱没有「已删除」文件夹，无法删除邮件', 'error'); return; }
      const inTrash = m.folder === trash.path;
      // 「移到已删除」是可恢复操作（和桌面客户端一致，不打断用户）；只有垃圾箱里的真删除才确认
      if (inTrash && !confirm('永久删除这封邮件？此操作不可恢复！')) return;
      try {
        if (!inTrash) {
          await this.api('/api/move', { method: 'POST', body: { account: m.accountId, folder: m.folder, uids: [m.uid], dest: trash.path } });
        } else {
          await this.api('/api/delete', { method: 'POST', body: { account: m.accountId, folder: m.folder, uids: [m.uid] } });
        }
        this.dropRows([m]);
        this.loadAllFoldersAndUnread();
        this.toast(inTrash ? '已永久删除' : '已移到已删除', 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
    },
    async archive(m) {
      try {
        const dest = (this.foldersByAccount[m.accountId] || []).find((f) => f.special === '\\Archive' || /archive/i.test(f.path));
        if (!dest) { this.toast('该账号没有归档文件夹', 'error'); return; }
        await this.api('/api/move', { method: 'POST', body: { account: m.accountId, folder: m.folder, uids: [m.uid], dest: dest.path } });
        // 走统一的移除路径：总数要跟着减、选中态要清、搜索结果里也要消失
        this.dropRows([m]);
        this.toast('已归档', 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
    },

    // ---------- 多选与批量操作 ----------
    msgMatch(m) {
      if (!this.searchQ) return true;
      const q = this.searchQ.toLowerCase();
      return (m.subject || '').toLowerCase().includes(q)
        || (m.from?.name || '').toLowerCase().includes(q)
        || (m.from?.address || '').toLowerCase().includes(q);
    },
    msgKey(m) { return `${m.accountId}|${m.folder || this.currentFolderOf(m)}|${m.uid}`; },
    isSel(m) { return this.selection.includes(this.msgKey(m)); },
    toggleSel(e, m) {
      const rows = this.filteredMessages;
      const idx = rows.findIndex((x) => x.uid === m.uid && x.accountId === m.accountId);
      const key = this.msgKey(m);
      if (e && e.shiftKey && this.selAnchor >= 0 && this.selAnchor < rows.length) {
        const [a, b] = [this.selAnchor, idx].sort((x, y) => x - y);
        const keys = rows.slice(a, b + 1).map((x) => this.msgKey(x));
        if (this.selection.includes(key)) this.selection = this.selection.filter((k) => !keys.includes(k));
        else this.selection = [...new Set([...this.selection, ...keys])];
      } else {
        this.selection = this.selection.includes(key)
          ? this.selection.filter((k) => k !== key)
          : [...this.selection, key];
        this.selAnchor = idx;
      }
    },
    toggleSelectAll() {
      if (this.allSelected) { this.clearSel(); return; }
      this.selection = this.visibleRows.map((m) => this.msgKey(m));
      this.selAnchor = 0;
    },
    clearSel() { this.selection = []; this.selAnchor = -1; },
    selectedMessages() { return this.messages.filter((m) => this.selection.includes(this.msgKey(m))); },
    // IMAP 的 UID 只在单个邮箱内唯一：批量请求必须按「账号 + 文件夹」分组发
    groupSelection() {
      const groups = new Map();
      for (const m of this.selectedMessages()) {
        const folder = m.folder || this.currentFolderOf(m);
        const key = `${m.accountId}|${folder}`;
        if (!groups.has(key)) groups.set(key, { accountId: m.accountId, folder, uids: [] });
        groups.get(key).uids.push(m.uid);
      }
      return [...groups.values()];
    },
    trashOf(accountId) {
      return (this.foldersByAccount[accountId] || []).find((f) => f.special === '\\Trash');
    },
    archiveOf(accountId) {
      return (this.foldersByAccount[accountId] || []).find((f) => f.special === '\\Archive' || /archive/i.test(f.path));
    },
    dropRows(msgs) {
      const keys = new Set(msgs.map((m) => this.msgKey(m)));
      const before = this.messages.length;
      this.messages = this.messages.filter((m) => !keys.has(this.msgKey(m)));
      const removed = before - this.messages.length;
      // 搜索结果里同一封也要消失，否则删完还能在搜索列表里点开它（然后报「邮件不存在」）
      if (this.searchMode) {
        const beforeHits = this.searchHits.length;
        this.searchHits = this.searchHits.filter((m) => !keys.has(this.msgKey(m)));
        if (this.searchHits.length !== beforeHits) this.searchInfo = '';
      }
      // 列表头上的「xx 封」是服务端总数，删/移走几封就得同步减，否则数字不动
      if (removed > 0) this.total = Math.max(0, this.total - removed);
      this.selection = this.selection.filter((k) => !keys.has(k));
      if (this.selected && keys.has(this.msgKey(this.selected))) { this.selected = null; this.readerOpen = false; }
      if (this.selection.length) this.selAnchor = -1;
      // 已加载的行被删空但文件夹里还有邮件：回第一页重拉（滚动加载没有「上一页」概念）
      if (removed > 0 && !this.messages.length && this.total > 0) { this.page = 1; this.loadMessages(); }
    },
    // 批量已读 / 未读（乐观更新，失败整体回滚）
    async batchRead(read) {
      const msgs = this.selectedMessages();
      if (!msgs.length) return;
      for (const m of msgs) this.setFlag(m, '\\Seen', read);
      try {
        await Promise.all(this.groupSelection().map((g) => this.api('/api/flags', {
          method: 'POST', body: { account: g.accountId, folder: g.folder, uids: g.uids, action: read ? 'read' : 'unread' },
        })));
        this.toast(`已把 ${msgs.length} 封标为${read ? '已读' : '未读'}`, 'ok');
        this.loadAllFoldersAndUnread();
      } catch (e) {
        for (const m of msgs) this.setFlag(m, '\\Seen', !read);
        this.toast(e.message, 'error');
      }
    },
    async batchStar(on) {
      const msgs = this.selectedMessages();
      if (!msgs.length) return;
      for (const m of msgs) this.setFlag(m, '\\Flagged', on);
      try {
        await Promise.all(this.groupSelection().map((g) => this.api('/api/flags', {
          method: 'POST', body: { account: g.accountId, folder: g.folder, uids: g.uids, action: on ? 'star' : 'unstar' },
        })));
        this.toast(`已${on ? '加星' : '取消星标'} ${msgs.length} 封`, 'ok');
      } catch (e) {
        for (const m of msgs) this.setFlag(m, '\\Flagged', !on);
        this.toast(e.message, 'error');
      }
    },
    async batchRemove() {
      const msgs = this.selectedMessages();
      if (!msgs.length) return;
      // 混选时提示要按实际动作拆开：移进垃圾箱 vs 真删除（不可恢复）
      const inTrash = msgs.filter((m) => this.trashOf(m.accountId)?.path === m.folder).length;
      const outTrash = msgs.length - inTrash;
      let tip;
      if (!inTrash) tip = `把选中的 ${msgs.length} 封邮件移到已删除？`;
      else if (!outTrash) tip = `永久删除选中的 ${msgs.length} 封邮件？此操作不可恢复！`;
      else tip = `把选中的 ${outTrash} 封邮件移到已删除，另外 ${inTrash} 封已在已删除里、将被永久删除（不可恢复）。确定？`;
      if (!confirm(tip)) return;
      try {
        await Promise.all(this.groupSelection().map((g) => {
          const trash = this.trashOf(g.accountId);
          // 已在垃圾箱里就直接删掉（IMAP delete），否则移进垃圾箱
          if (trash && g.folder !== trash.path) {
            return this.api('/api/move', { method: 'POST', body: { account: g.accountId, folder: g.folder, uids: g.uids, dest: trash.path } });
          }
          return this.api('/api/delete', { method: 'POST', body: { account: g.accountId, folder: g.folder, uids: g.uids } });
        }));
        const n = msgs.length;
        this.dropRows(msgs);
        this.loadAllFoldersAndUnread();
        this.toast(inTrash ? `已永久删除 ${n} 封` : `已删除 ${n} 封`, 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
    },
    async batchArchive() {
      const msgs = this.selectedMessages();
      if (!msgs.length) return;
      const groups = this.groupSelection();
      const movable = groups.filter((g) => this.archiveOf(g.accountId));
      if (!movable.length) { this.toast('所选邮箱没有归档文件夹', 'error'); return; }
      try {
        await Promise.all(movable.map((g) => this.api('/api/move', {
          method: 'POST', body: { account: g.accountId, folder: g.folder, uids: g.uids, dest: this.archiveOf(g.accountId).path },
        })));
        const moved = msgs.filter((m) => this.archiveOf(m.accountId));
        this.dropRows(moved);
        this.toast(`已归档 ${moved.length} 封${movable.length < groups.length ? '（部分邮箱无归档文件夹，已跳过）' : ''}`, 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
    },
    async batchMove(dest) {
      const msgs = this.selectedMessages();
      if (!msgs.length) { this.closeCtx(); return; }
      const groups = this.groupSelection().filter((g) => g.folder !== dest);
      if (!groups.length) { this.toast('已经在这个文件夹里了'); this.closeCtx(); return; }
      try {
        await Promise.all(groups.map((g) => this.api('/api/move', {
          method: 'POST', body: { account: g.accountId, folder: g.folder, uids: g.uids, dest },
        })));
        this.dropRows(msgs);
        this.toast(`已移动 ${msgs.length} 封到「${this.folderLabel(this.folders.find((f) => f.path === dest) || { path: dest, name: dest })}」`, 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
      this.closeCtx();
    },

    // ---------- 右键菜单 ----------
    openCtx(e, m) {
      // 与 QQ 邮箱一致：右键点在未选中的行上时，只对这一封操作
      if (!this.isSel(m)) { this.selection = [this.msgKey(m)]; this.selAnchor = -1; }
      const w = 208, h = 316;
      this.ctx = {
        open: true,
        x: Math.max(8, Math.min(e.clientX, window.innerWidth - w - 8)),
        y: Math.max(8, Math.min(e.clientY, window.innerHeight - h - 8)),
        m, sub: false,
      };
    },
    closeCtx() { if (this.ctx.open) this.ctx = { open: false, x: 0, y: 0, m: null, sub: false }; },
    ctxAct(fn) {
      const m = this.ctx.m;
      this.closeCtx();
      if (m) fn(m);
    },

    // ---------- 左栏文件夹右键菜单 ----------
    openNavCtx(e, account, node) {
      const w = 190, h = 120;
      this.navCtx = {
        open: true,
        x: Math.max(8, Math.min(e.clientX, window.innerWidth - w - 8)),
        y: Math.max(8, Math.min(e.clientY, window.innerHeight - h - 8)),
        account, node,
      };
    },
    closeNavCtx() { if (this.navCtx.open) this.navCtx = { open: false, x: 0, y: 0, account: '', node: null }; },
    canDeleteFolder(node) { return node && node.path !== 'INBOX' && !node.special; },
    canEmptyNode(node) { return node && ['\\Trash', '\\Junk'].includes(node.special); },
    navAct(fn) {
      const { account, node } = this.navCtx;
      this.closeNavCtx();
      if (node) fn(account, node);
    },
    // 右键 → 全部标为已读：整夹在服务端一次完成，本地角标清零
    async navReadAll(account, node) {
      try {
        await this.api('/api/folders/read-all', { method: 'POST', body: { account, folder: node.path } });
        this.unreadMap[`${account}|${node.path}`] = 0;
        const key = `${account}|${node.path}`;
        for (const m of this.messages) {
          if (`${m.accountId}|${m.folder}` === key && !m.flags.includes('\\Seen')) m.flags.push('\\Seen');
        }
        this.toast('已全部标为已读', 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
    },
    async navEmpty(account, node) {
      if (!confirm(`清空「${this.folderLabel(node)}」？其中全部邮件将被永久删除，无法恢复。`)) return;
      try {
        await this.api('/api/folders/empty', { method: 'POST', body: { account, folder: node.path } });
        this.unreadMap[`${account}|${node.path}`] = 0;
        if (this.curFolderRef && this.curFolderRef.account === account && this.curFolderRef.folder === node.path) {
          this.page = 1;
          await this.loadMessages();
        }
        this.toast('已清空', 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
    },
    // 右键 → 删除文件夹：仅自建文件夹；IMAP DELETE 语义下邮件随文件夹一并消失
    async navDeleteFolder(account, node) {
      if (!confirm(`删除文件夹「${this.folderLabel(node)}」？其中的邮件将一并删除，且无法恢复。`)) return;
      try {
        await this.api('/api/folders', { method: 'DELETE', body: { account, folder: node.path } });
        // 正看着这个文件夹 → 回收件箱；否则原地刷新文件夹树
        if (this.activeAccount === account && this.activeFolder === node.path) {
          this.pickFolder('INBOX');
        } else if (this.allFolder === `${account}|${node.path}`) {
          this.pickAllInbox();
        }
        await this.loadAllFoldersAndUnread();
        this.toast('文件夹已删除', 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
    },

    // ---------- 写信 ----------
    openCompose(opts = {}) {
      this.compose.open = true;
      this.compose.mode = opts.mode || 'new';
      this.compose.replyTo = opts.replyTo || null;
      this.compose.accountId = opts.accountId || (this.accounts[0] ? this.accounts[0].id : '');
      this.compose.to = opts.to || '';
      this.compose.cc = opts.cc || ''; this.compose.showCc = !!opts.cc;
      this.compose.subject = opts.subject || '';
      this.compose.text = opts.text || '';
      this.compose.attachments = [];
      this.compose.draftId = opts.draftId || null;
      this.compose.error = '';
    },
    reply(m, mode) {
      const acc = this.accounts.find((a) => a.id === m.accountId);
      if (mode === 'reply') {
        this.openCompose({
          mode, accountId: m.accountId,
          to: m.from?.address || '',
          subject: m.subject.startsWith('Re:') ? m.subject : `Re: ${m.subject}`,
          text: `\n\n------------------\n在 ${this.fullDate(m.date)}，${m.from?.name || m.from?.address} 写道：\n\n${(m.text || '').split('\n').map((l) => '> ' + l).join('\n').slice(0, 4000)}`,
          replyTo: m,
        });
      } else {
        this.openCompose({
          mode, accountId: acc ? acc.id : this.accounts[0]?.id,
          subject: m.subject.startsWith('Fwd:') ? m.subject : `Fwd: ${m.subject}`,
          text: `\n\n------------------\n转发自 ${m.from?.address || ''}（${this.fullDate(m.date)}）：\n\n${(m.text || '').slice(0, 4000)}`,
        });
      }
      this.readerOpen = false;
      this.readerMoveOpen = false;
    },
    // 回复全部：收件人 = 原发件人 + 原收件人 + 抄送（去掉自己、去重）
    replyAll(m) {
      const acc = this.accounts.find((a) => a.id === m.accountId);
      const me = (acc?.email || '').toLowerCase();
      const norm = (x) => String(x || '').trim().toLowerCase();
      const all = [m.from?.address, ...(m.to || []).map((x) => x.address), ...(m.cc || []).map((x) => x.address)]
        .filter((a) => a && norm(a) !== me);
      const seen = new Set();
      const uniq = [];
      for (const a of all) { const k = norm(a); if (!seen.has(k)) { seen.add(k); uniq.push(a); } }
      if (!uniq.length) { this.toast('这封邮件没有其他收件人', 'error'); return; }
      this.openCompose({
        mode: 'reply', accountId: m.accountId,
        to: uniq[0],
        cc: uniq.slice(1).join(', '),
        subject: m.subject.startsWith('Re:') ? m.subject : `Re: ${m.subject}`,
        text: `\n\n------------------\n在 ${this.fullDate(m.date)}，${m.from?.name || m.from?.address} 写道：\n\n${(m.text || '').split('\n').map((l) => '> ' + l).join('\n').slice(0, 4000)}`,
        replyTo: m,
      });
      this.readerOpen = false;
    },
    async readerMoveTo(dest) {
      const m = this.selected;
      this.readerMoveOpen = false;
      if (!m) return;
      const folder = m.folder || this.currentFolderOf(m);
      if (folder === dest) return;
      try {
        await this.api('/api/move', { method: 'POST', body: { account: m.accountId, folder, uids: [m.uid], dest } });
        const f = (this.foldersByAccount[m.accountId] || []).find((x) => x.path === dest);
        this.messages = this.messages.filter((x) => !(x.uid === m.uid && x.accountId === m.accountId));
        this.selected = null; this.readerOpen = false;
        this.loadAllFoldersAndUnread();
        this.toast(`已移动到「${f ? this.folderLabel(f) : dest}」`, 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
    },
    pickFiles() { this.$refs.fileInput.click(); },
    onFiles(ev) {
      const files = [...ev.target.files];
      for (const f of files) {
        if (f.size > 25 * 1048576) { this.toast(`${f.name} 超过 25MB，暂不支持`, 'error'); continue; }
        const reader = new FileReader();
        reader.onload = () => {
          this.compose.attachments.push({ filename: f.name, contentType: f.type || 'application/octet-stream', size: f.size, content: String(reader.result).split(',')[1] });
        };
        reader.readAsDataURL(f);
      }
      ev.target.value = '';
    },
    async sendCompose() {
      this.compose.error = '';
      if (!this.compose.to.trim()) { this.compose.error = '请填写收件人'; return; }
      this.compose.sending = true;
      try {
        const body = {
          account: this.compose.accountId,
          to: this.compose.to.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean),
          cc: this.compose.showCc ? this.compose.cc.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean) : undefined,
          subject: this.compose.subject,
          text: this.compose.text,
          attachments: this.compose.attachments,
          draftId: this.compose.draftId,
        };
        if (this.compose.mode === 'reply' && this.compose.replyTo) {
          body.inReplyTo = this.compose.replyTo.messageId;
          body.references = this.compose.replyTo.references || this.compose.replyTo.messageId;
        }
        await this.api('/api/send', { method: 'POST', body });
        this.compose.open = false;
        this.toast('已发送', 'ok');
        this.refreshAll();
      } catch (e) {
        this.compose.error = e.message;
      } finally {
        this.compose.sending = false;
      }
    },
    async sendQuickReply() {
      if (!this.quickReplyText || !this.selected) return;
      this.sendingQuick = true;
      try {
        await this.api('/api/send', {
          method: 'POST',
          body: {
            account: this.selected.accountId,
            to: [this.selected.from?.address],
            subject: this.selected.subject.startsWith('Re:') ? this.selected.subject : `Re: ${this.selected.subject}`,
            text: this.quickReplyText,
            inReplyTo: this.selected.messageId,
            references: this.selected.references || this.selected.messageId,
          },
        });
        this.quickReplyText = '';
        this.toast('已回复', 'ok');
      } catch (e) {
        this.toast(e.message, 'error');
      } finally { this.sendingQuick = false; }
    },
    async saveComposeDraft() {
      try {
        const d = await this.api('/api/drafts', {
          method: 'POST',
          body: { id: this.compose.draftId, accountId: this.compose.accountId, to: this.compose.to, cc: this.compose.cc, subject: this.compose.subject, text: this.compose.text },
        });
        this.compose.draftId = d.draft.id;
        this.toast('草稿已保存（仅存本机）', 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
    },
    closeCompose() {
      // 有任何实质内容（正文/收件人/主题）就弹三选确认，而不是浏览器 confirm
      const c = this.compose;
      if (c.text || c.to || c.cc || c.subject) { this.composeAskClose = true; return; }
      this.compose.open = false;
    },
    async saveAndCloseCompose() {
      await this.saveComposeDraft();
      this.composeAskClose = false;
      this.compose.open = false;
    },
    discardCompose() {
      this.composeAskClose = false;
      this.compose.open = false;
    },

    // ---------- 设置 ----------
    openSettings() {
      this.avatarOpen = false;
      this.settingsTab = 'accounts';
      this.addForm = { open: false, email: '', displayName: '', password: '', preset: null, color: this.nextFreeColor(), imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465, testing: false, saving: false, message: '', ok: false };
      this.colorPickFor = null;
      this.outlook.device = null;
      this.outlook.polling = false;
      this.outlook.error = '';
      this.modals.settings = true;
      this.loadOutlookConfig();
    },
    // ---------- 本地缓存 ----------
    // 邮件正文/附件都落本地（SQLite + 附件目录），这里只是把占用情况摊开给用户看，
    // 并给一个「空间不够了就清掉」的出口 —— 清理不影响服务器上的邮件。
    async openCacheTab() {
      this.settingsTab = 'cache';
      await this.loadCacheInfo();
    },
    async loadCacheInfo() {
      try {
        const d = await this.api('/api/cache');
        this.cacheInfo = d;
        this.cacheBodies = (d.accounts || []).reduce((n, c) => n + c.bodies, 0);
      } catch (e) { this.toast(e.message, 'error'); }
    },
    accountLabel(accountId) {
      const a = this.accounts.find((x) => x.id === accountId);
      return a ? a.displayName || a.email : '已移除的账号';
    },
    async clearCache(scope) {
      const tip = scope === 'all'
        ? '清空本地缓存？服务器上的邮件不会被删除，只是下次打开要重新下载。'
        : '清理已缓存的正文？服务器上的邮件不会被删除，下次打开会重新下载。';
      if (!confirm(tip)) return;
      try {
        const r = await this.api(`/api/cache?scope=${scope}`, { method: 'DELETE' });
        this.toast(scope === 'all' ? '本地缓存已清空' : `已清理 ${r.cleared} 封正文`, 'ok');
        await this.loadCacheInfo();
      } catch (e) { this.toast(e.message, 'error'); }
    },

    // ---------- Agent 接入（MCP） ----------
    async openAgentTab() {
      this.settingsTab = 'agent';
      this.agent.created = '';
      await this.loadAgentTokens();
    },
    async loadAgentTokens() {
      try {
        const d = await this.api('/api/agent/tokens');
        this.agent.tokens = d.tokens || [];
        if (d.limit) this.agent.limit = d.limit;
      } catch (e) { this.toast(e.message, 'error'); }
    },
    toggleScope(key) {
      const i = this.agent.scopes.indexOf(key);
      if (i >= 0) this.agent.scopes.splice(i, 1);
      else this.agent.scopes.push(key);
    },
    async createAgentToken() {
      if (this.agent.busy) return;
      if (!this.agent.scopes.length) return this.toast('至少要选一个权限', 'error');
      this.agent.busy = true;
      try {
        const d = await this.api('/api/agent/tokens', {
          method: 'POST',
          body: { name: this.agent.name, scopes: this.agent.scopes, expiresInDays: this.agent.days },
        });
        this.agent.created = d.token;     // 明文只有这一次
        this.agent.tokens = [d.record, ...this.agent.tokens];
        this.agent.name = '';
      } catch (e) {
        this.toast(e.message, 'error');
      } finally {
        this.agent.busy = false;
      }
    },
    async revokeAgentToken(t) {
      if (!confirm(`撤销「${t.name}」？正在用它的客户端会立刻连不上。`)) return;
      try {
        await this.api(`/api/agent/tokens/${t.id}`, { method: 'DELETE' });
        this.agent.tokens = this.agent.tokens.filter((x) => x.id !== t.id);
        this.toast('已撤销', 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
    },
    scopeLabel(s) {
      return ({ read: '读取', write: '整理', send: '发信' })[s] || s;
    },
    fmtTs(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const now = new Date();
      const sameYear = d.getFullYear() === now.getFullYear();
      const p = (n) => String(n).padStart(2, '0');
      return `${sameYear ? '' : d.getFullYear() + '-'}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    },
    copyText(s) {
      const done = () => this.toast('已复制', 'ok');
      const fallback = () => {
        // 内网 http 不是安全上下文，navigator.clipboard 可能不存在，退回选中复制
        const ta = document.createElement('textarea');
        ta.value = s;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch { this.toast('复制失败，请手动选中', 'error'); }
        document.body.removeChild(ta);
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(s).then(done).catch(fallback);
      else fallback();
    },
    applyPreset(key) {
      this.addForm.preset = key;
      const p = PRESETS[key];
      if (p) { this.addForm.imapHost = p.imap[0]; this.addForm.imapPort = p.imap[1]; this.addForm.smtpHost = p.smtp[0]; this.addForm.smtpPort = p.smtp[1]; }
    },
    openAddForm() {
      this.addForm.open = true;
      this.addForm.color = this.nextFreeColor();
      this.addForm.message = '';
    },
    // 第一个未被现有账号占用的色板颜色；全占用则按账号数轮转
    nextFreeColor() {
      const used = new Set(this.accounts.map((a) => a.color));
      return PALETTE.find((c) => !used.has(c)) || PALETTE[this.accounts.length % PALETTE.length];
    },
    accountBody() {
      return {
        email: this.addForm.email,
        displayName: this.addForm.displayName || undefined,
        preset: this.addForm.preset || undefined,
        color: this.addForm.color,
        password: this.addForm.password,
        imap: { host: this.addForm.imapHost, port: this.addForm.imapPort, tls: this.addForm.imapPort === 993 },
        smtp: { host: this.addForm.smtpHost, port: this.addForm.smtpPort, tls: this.addForm.smtpPort !== 587 },
        auth: { user: this.addForm.email, pass: this.addForm.password },
      };
    },
    async testAdd() {
      this.addForm.message = ''; this.addForm.testing = true;
      try {
        await this.api('/api/accounts/test', { method: 'POST', body: this.accountBody() });
        this.addForm.message = '连接成功，可以保存了'; this.addForm.ok = true;
      } catch (e) {
        this.addForm.message = e.message; this.addForm.ok = false;
      } finally { this.addForm.testing = false; }
    },
    async addAccount() {
      this.addForm.message = ''; this.addForm.saving = true;
      try {
        const data = await this.api('/api/accounts', { method: 'POST', body: this.accountBody() });
        this.accounts = data.accounts;
        this.addForm.open = false;
        this.toast('账号已添加', 'ok');
        // 文件夹与未读数后台补全，不阻塞保存按钮
        this.loadAllFoldersAndUnread().catch(() => {});
      } catch (e) {
        this.addForm.message = e.message; this.addForm.ok = false;
      } finally { this.addForm.saving = false; }
    },
    // ---------- Outlook OAuth（设备码） ----------
    async loadOutlookConfig() {
      try {
        const d = await this.api('/api/oauth/outlook');
        this.outlook.configured = !!d.configured;
        this.outlook.clientId = d.clientId || '';
        this.outlook.registerUrl = d.registerUrl || '';
        this.outlook.deviceLoginUrl = d.deviceLoginUrl || '';
        if (d.clientId && !this.outlook.idInput) this.outlook.idInput = d.clientId;
      } catch { /* 拿不到配置不影响其他功能 */ }
    },
    async saveOutlookClientId() {
      this.outlook.error = ''; this.outlook.savingId = true;
      try {
        const d = await this.api('/api/oauth/outlook/client-id', { method: 'POST', body: { clientId: this.outlook.idInput } });
        this.outlook.configured = true;
        this.outlook.clientId = d.clientId;
        this.toast('应用 ID 已保存', 'ok');
      } catch (e) {
        this.outlook.error = e.message;
      } finally { this.outlook.savingId = false; }
    },
    async connectOutlook() {
      this.outlook.error = '';
      this.outlook.device = null;
      try {
        const d = await this.api('/api/oauth/outlook/start', { method: 'POST', body: {} });
        this.outlook.device = d;
        this.pollOutlook(d);
      } catch (e) {
        this.outlook.error = e.message;
      }
    },
    async pollOutlook(device) {
      this.outlook.polling = true;
      const deadline = Date.now() + (Number(device.expiresIn) || 900) * 1000;
      let wait = Number(device.interval) || 5;
      while (this.outlook.polling && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, wait * 1000));
        if (!this.outlook.polling) return;
        try {
          const r = await this.api('/api/oauth/outlook/poll', {
            method: 'POST',
            body: { deviceCode: device.deviceCode, email: this.addForm.email, displayName: this.addForm.displayName },
          });
          if (r.pending) { if (r.slowDown) wait += 5; continue; }
          this.outlook.polling = false;
          this.outlook.device = null;
          this.accounts = r.accounts;
          this.addForm.open = false;
          this.toast(`已连接 ${r.email}`, 'ok');
          this.loadAllFoldersAndUnread().catch(() => {});
          return;
        } catch (e) {
          this.outlook.polling = false;
          this.outlook.device = null;
          this.outlook.error = e.message;
          return;
        }
      }
      if (this.outlook.polling) {
        this.outlook.polling = false;
        this.outlook.device = null;
        this.outlook.error = '验证码已超时，请重新点「连接 Outlook」';
      }
    },
    cancelOutlook() {
      this.outlook.polling = false;
      this.outlook.device = null;
    },

    async removeAccount(a) {
      if (!confirm(`删除账号 ${a.email}？仅删除本机凭据，不影响邮箱本身。`)) return;
      try {
        const data = await this.api(`/api/accounts/${a.id}`, { method: 'DELETE' });
        this.accounts = data.accounts;
        if (this.activeAccount === a.id) this.pickAccount(this.accounts.length ? 'all' : 'all');
        this.toast('已删除', 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
    },
    toggleColorPick(a) {
      this.colorPickFor = this.colorPickFor === a.id ? null : a.id;
    },
    startEditAccount(a) {
      this.colorPickFor = null;
      this.editingId = a.id;
      this.editName = a.displayName || '';
      this.$nextTick(() => {
        const el = document.querySelector('.acct-name-input');
        if (el) { el.focus(); el.select(); }
      });
    },
    cancelEditAccount() {
      this.editingId = null; this.editName = ''; this.editSaving = false;
    },
    async saveAccountName(a) {
      const name = this.editName.trim();
      if (!name) return this.toast('显示名称不能为空', 'error');
      if (name === a.displayName) return this.cancelEditAccount();
      this.editSaving = true;
      try {
        const data = await this.api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { displayName: name } });
        this.accounts = data.accounts;
        this.editingId = null; this.editName = '';
        this.toast('已更新显示名称', 'ok');
      } catch (e) {
        this.toast(e.message, 'error');
      } finally { this.editSaving = false; }
    },
    async setAccountColor(a, c) {
      this.colorPickFor = null;
      if (a.color === c) return;
      try {
        const data = await this.api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { color: c } });
        this.accounts = data.accounts;
      } catch (e) { this.toast(e.message, 'error'); }
    },
    async changePw() {
      this.pw.busy = true;
      try {
        await this.api('/api/me/password', { method: 'POST', body: { current: this.pw.current, next: this.pw.next } });
        this.pw = { current: '', next: '', busy: false };
        this.toast('密码已更新', 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
      finally { this.pw.busy = false; }
    },

    // ---------- 用户管理 ----------
    async openUsers() {
      this.avatarOpen = false;
      try {
        const data = await this.api('/api/users');
        this.users = data.users;
        this.userForm = { open: false, username: '', displayName: '', password: '', busy: false };
        this.modals.users = true;
      } catch (e) { this.toast(e.message, 'error'); }
    },
    async createUser() {
      this.userForm.busy = true;
      try {
        const data = await this.api('/api/users', { method: 'POST', body: this.userForm });
        this.users.push(data.user);
        this.userForm = { open: false, username: '', displayName: '', password: '', busy: false };
        this.toast(`用户 ${data.user.displayName} 已创建，请把初始密码线下交给对方`, 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
      finally { this.userForm.busy = false; }
    },
    async toggleUser(u) {
      try {
        const data = await this.api(`/api/users/${u.id}/disable`, { method: 'POST', body: { disabled: !u.disabled } });
        const i = this.users.findIndex((x) => x.id === u.id);
        if (i >= 0) this.users[i] = data.user;
      } catch (e) { this.toast(e.message, 'error'); }
    },
    async resetUser(u) {
      if (!confirm(`重置 ${u.displayName} 的密码？对方当前所有登录会话会立即失效。`)) return;
      try {
        const data = await this.api(`/api/users/${u.id}/reset`, { method: 'POST' });
        this.toast(`临时密码：${data.tempPassword}（只显示这一次，请立即线下转交）`, '');
      } catch (e) { this.toast(e.message, 'error'); }
    },
    async removeUser(u) {
      if (!confirm(`彻底删除用户 ${u.displayName} 及其全部本机数据？此操作不可恢复。`)) return;
      try {
        await this.api(`/api/users/${u.id}`, { method: 'DELETE' });
        this.users = this.users.filter((x) => x.id !== u.id);
        this.toast('已删除', 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
    },
  },

  async mounted() {
    document.addEventListener('click', () => { this.acctOpen = false; this.avatarOpen = false; this.closeCtx(); this.closeNavCtx(); });
    document.addEventListener('keydown', (e) => {
      const t = e.target || {};
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') || t.isContentEditable;
      // Esc 按「最上面一层」逐层关：右键菜单 → 关窗确认 → 写信 → 设置 → 搜索 → 阅读区
      if (e.key === 'Escape') {
        if (this.ctx.open || this.navCtx.open) { this.closeCtx(); this.closeNavCtx(); return; }
        if (this.composeAskClose) { this.composeAskClose = false; return; }
        if (this.compose.open) { this.closeCompose(); return; }
        if (this.modals.settings || this.modals.users) { this.modals.settings = false; this.modals.users = false; return; }
        if (this.searchMode) { this.exitSearch(); return; }
        if (this.readerOpen) { this.readerOpen = false; }
        return;
      }
      if (typing || this.view !== 'app') return;
      // 列表页 Delete/Backspace 删除选中
      if (this.selection.length && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        this.batchRemove();
        return;
      }
      // Ctrl+A 只在该全选邮件时全选 —— 阅读区里按 Ctrl+A 是「选中正文」，不能变成批量操作
      const inReader = !!(t.closest && t.closest('.reader'));
      if (!inReader && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && this.messages.length) {
        e.preventDefault();
        this.toggleSelectAll();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 有了浮层/写信窗就不抢单键快捷键
      if (this.compose.open || this.modals.settings || this.modals.users) return;
      const k = e.key;
      // 只绑 j/k，不碰 ↑/↓：阅读区长邮件要能正常用方向键滚动正文
      if (k === 'j' || k === 'k') { e.preventDefault(); this.stepMessage(k === 'j' ? 1 : -1); return; }
      // 只在单封阅读时可用，避免误以为在给整个列表回信
      if (k === 'r' && this.selected && this.readerOpen) { e.preventDefault(); this.reply(this.selected, 'reply'); return; }
      if (k === '/') { e.preventDefault(); document.querySelector('.search input, .list-search input')?.focus(); }
    });
    window.addEventListener('scroll', () => this.closeCtx(), true);
    window.addEventListener('resize', () => this.closeCtx());
    try {
      const st = await this.api('/api/setup-status');
      this.version = st.version || '';
      if (!st.setupDone) { this.authMode = 'setup'; this.view = 'auth'; return; }
      await this.enterApp();
    } catch {
      this.authMode = 'login'; this.view = 'auth';
    }
  },
});

app.mount('#app');
