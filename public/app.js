/* MailNest 前端（无构建 Vue3） */
const { createApp } = Vue;

// Windows 的中文字体是微软雅黑，字形在 em 框里偏上，需要 CSS 光学补偿；
// 只在真正会用雅黑的平台上打标，macOS（苹方）/Linux（Noto）保持原样。
if (/Windows/i.test(navigator.userAgent)) document.documentElement.dataset.fontfix = 'yahei';

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
      searchQ: '',
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
    listTitle() {
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
        this.view = 'auth'; this.authMode = 'login';
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

    async loadMessages(append = false) {
      if (append) this.loadingMore = true; else this.loadingMessages = true;
      try {
        if (this.activeAccount === 'all' && !this.allFolder) {
          // 汇总视图：各账号 INBOX 各取当前页，按时间归并；总数 = 各账号真实总数之和
          // （此前把「本页条数」当总数，outlook 68 封 + QQ 几十封时头上却显示 50）
          const jobs = this.accounts.map(async (a) => {
            try {
              const d = await this.api(`/api/messages?account=${a.id}&folder=INBOX&page=${this.page}&pageSize=${this.pageSize}`);
              // folder 必须显式带上：汇总视图里的星标/删除/归档都靠它定位邮件
              return { total: d.total || 0,
                       messages: d.messages.map((m) => ({ ...m, accountId: a.id, folder: 'INBOX', accountEmail: a.email, _color: a.color })) };
            } catch (e) {
              this.toast(`${a.displayName}：${e.message}`, 'error');
              return { total: 0, messages: [] };
            }
          });
          const parts = await Promise.all(jobs);
          this.total = parts.reduce((sum, p) => sum + p.total, 0);
          const merged = parts.flatMap((p) => p.messages)
            .sort((x, y) => new Date(y.date || 0) - new Date(x.date || 0));
          // 追加时不截断：跨账号归并翻页本来就有交错误差，再截断会把行永远弄丢
          this.messages = append ? this.messages.concat(merged) : merged;
        } else {
          let aid, folder;
          if (this.activeAccount === 'all') {
            [aid, folder] = this.allFolder.split('|');
          } else {
            aid = this.activeAccount; folder = this.activeFolder;
          }
          const d = await this.api(`/api/messages?account=${aid}&folder=${encodeURIComponent(folder)}&page=${this.page}&pageSize=${this.pageSize}`);
          const acc = this.accounts.find((a) => a.id === aid);
          const rows = d.messages.map((m) => ({ ...m, accountId: aid, folder: m.folder || folder, accountEmail: acc?.email || '', _color: acc?.color || '#2d6cf6' }));
          this.messages = append ? this.messages.concat(rows) : rows;
          this.total = d.total;
        }
      } catch (e) {
        if (append) this.page--; // 追加失败回退页码，下次滚动还能重试
        if (!e.handled) this.toast(e.message, 'error');
      } finally {
        this.loadingMessages = false;
        this.loadingMore = false;
      }
    },
    async refreshAll() {
      if (this.syncing) return;
      this.syncing = true;
      try {
        await this.loadAllFoldersAndUnread();
        await this.loadMessages();
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
      try {
        await this.api('/api/folders/empty', { method: 'POST', body: ref });
        this.unreadMap[`${ref.account}|${ref.folder}`] = 0;
        this.page = 1;
        await this.loadMessages();
        this.toast('已清空', 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
    },

    // ---------- 阅读 ----------
    async openMessage(m) {
      try {
        const full = await this.api(`/api/message?account=${m.accountId}&folder=${encodeURIComponent(m.folder || this.currentFolderOf(m))}&uid=${m.uid}`);
        this.selected = { ...full, ...m, folder: m.folder || this.currentFolderOf(m) };
        this.quickReplyText = '';
        this.readerOpen = true;
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
        if (!e.handled) this.toast(e.message, 'error');
      }
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
      const list = this.messages.filter(same);
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
      if (!confirm('把这封邮件移到已删除？')) return;
      try {
        const acc = this.accounts.find((a) => a.id === m.accountId);
        const trash = (this.foldersByAccount[m.accountId] || []).find((f) => f.special === '\\Trash');
        if (trash && m.folder !== trash.path) {
          await this.api('/api/move', { method: 'POST', body: { account: m.accountId, folder: m.folder, uids: [m.uid], dest: trash.path } });
        } else {
          await this.api('/api/delete', { method: 'POST', body: { account: m.accountId, folder: m.folder, uids: [m.uid] } });
        }
        this.dropRows([m]);
        this.loadAllFoldersAndUnread();
        this.toast(acc ? `已删除（${acc.displayName}）` : '已删除', 'ok');
      } catch (e) { this.toast(e.message, 'error'); }
    },
    async archive(m) {
      try {
        const dest = (this.foldersByAccount[m.accountId] || []).find((f) => f.special === '\\Archive' || /archive/i.test(f.path));
        if (!dest) { this.toast('该账号没有归档文件夹', 'error'); return; }
        await this.api('/api/move', { method: 'POST', body: { account: m.accountId, folder: m.folder, uids: [m.uid], dest: dest.path } });
        this.messages = this.messages.filter((x) => x.uid !== m.uid || x.accountId !== m.accountId);
        this.selected = null; this.readerOpen = false;
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
      if (!confirm(`把选中的 ${msgs.length} 封邮件移到已删除？`)) return;
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
        this.toast(`已删除 ${n} 封`, 'ok');
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
    document.addEventListener('click', () => { this.acctOpen = false; this.avatarOpen = false; this.closeCtx(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.closeCtx(); }
      // 列表页 Delete 键删除选中（输入框里不抢）
      const t = e.target || {};
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') || t.isContentEditable;
      if (!typing && this.view === 'app' && this.selection.length && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        this.batchRemove();
      }
      if (!typing && this.view === 'app' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && this.messages.length) {
        e.preventDefault();
        this.toggleSelectAll();
      }
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
