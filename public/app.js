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
      modals: { settings: false, users: false },
      settingsTab: 'accounts',
      addForm: { open: false, email: '', displayName: '', password: '', preset: null, imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465, testing: false, saving: false, message: '', ok: false },
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
      if (this.activeAccount === 'all') return '所有收件箱';
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
    filteredMessages() {
      if (!this.searchQ) return this.messages;
      const q = this.searchQ.toLowerCase();
      return this.messages.filter((m) => (m.subject || '').toLowerCase().includes(q)
        || (m.from?.name || '').toLowerCase().includes(q) || (m.from?.address || '').toLowerCase().includes(q));
    },
    listTitle() {
      if (this.activeAccount === 'all') return '收件箱 · 所有账号';
      const f = this.folders.find((x) => x.path === this.activeFolder);
      return f ? this.folderLabel(f) : this.activeFolder;
    },
    totalAttachSize() { return this.compose.attachments.reduce((s, a) => s + a.size, 0); },
    storagePct() { return Math.min(100, this.accounts.length * 12 + 8); },
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

    pickAccount(id) {
      this.acctOpen = false;
      this.activeAccount = id;
      this.selected = null; this.readerOpen = false;
      this.page = 1; this.searchQ = '';
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
      this.loadMessages();
    },
    pickAllFolder(aid, path) {
      this.allFolder = `${aid}|${path}`;
      this.selected = null; this.readerOpen = false;
      this.page = 1; this.searchQ = '';
      this.loadMessages();
    },
    gotoPage(p) { this.page = p; this.loadMessages(); },

    async loadMessages() {
      this.loadingMessages = true;
      try {
        if (this.activeAccount === 'all' && !this.allFolder) {
          // 汇总视图：各账号 INBOX 各取一页，按时间归并
          const jobs = this.accounts.map(async (a) => {
            try {
              const d = await this.api(`/api/messages?account=${a.id}&folder=INBOX&page=1&pageSize=${this.pageSize}`);
              return d.messages.map((m) => ({ ...m, accountId: a.id, accountEmail: a.email, _color: a.color }));
            } catch (e) {
              this.toast(`${a.displayName}：${e.message}`, 'error');
              return [];
            }
          });
          const parts = await Promise.all(jobs);
          this.messages = parts.flat().sort((x, y) => new Date(y.date || 0) - new Date(x.date || 0)).slice(0, this.pageSize);
          this.total = this.messages.length;
        } else {
          let aid, folder;
          if (this.activeAccount === 'all') {
            [aid, folder] = this.allFolder.split('|');
          } else {
            aid = this.activeAccount; folder = this.activeFolder;
          }
          const d = await this.api(`/api/messages?account=${aid}&folder=${encodeURIComponent(folder)}&page=${this.page}&pageSize=${this.pageSize}`);
          const acc = this.accounts.find((a) => a.id === aid);
          this.messages = d.messages.map((m) => ({ ...m, accountId: aid, accountEmail: acc?.email || '', _color: acc?.color || '#2d6cf6' }));
          this.total = d.total;
        }
      } catch (e) {
        if (!e.handled) this.toast(e.message, 'error');
      } finally {
        this.loadingMessages = false;
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

    // ---------- 阅读 ----------
    async openMessage(m) {
      try {
        const full = await this.api(`/api/message?account=${m.accountId}&folder=${encodeURIComponent(m.folder || this.currentFolderOf(m))}&uid=${m.uid}`);
        this.selected = { ...full, ...m, folder: m.folder || this.currentFolderOf(m) };
        this.quickReplyText = '';
        this.readerOpen = true;
        if (!m.flags.includes('\\Seen')) {
          m.flags.push('\\Seen');
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
    async markRead(m, read) {
      try {
        await this.api('/api/flags', { method: 'POST', body: { account: m.accountId, folder: m.folder, uid: m.uid, action: read ? 'read' : 'unread' } });
        if (read) { if (!m.flags.includes('\\Seen')) m.flags.push('\\Seen'); }
        else { m.flags = m.flags.filter((f) => f !== '\\Seen'); }
        this.loadAllFoldersAndUnread();
      } catch (e) { this.toast(e.message, 'error'); }
    },
    async toggleStar(m) {
      const on = m.flags.includes('\\Flagged');
      try {
        await this.api('/api/flags', { method: 'POST', body: { account: m.accountId, folder: m.folder, uid: m.uid, action: on ? 'unstar' : 'star' } });
        if (on) m.flags = m.flags.filter((f) => f !== '\\Flagged'); else m.flags.push('\\Flagged');
      } catch (e) { this.toast(e.message, 'error'); }
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
        this.messages = this.messages.filter((x) => x.uid !== m.uid || x.accountId !== m.accountId);
        this.selected = null; this.readerOpen = false;
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

    // ---------- 写信 ----------
    openCompose(opts = {}) {
      this.compose.open = true;
      this.compose.mode = opts.mode || 'new';
      this.compose.replyTo = opts.replyTo || null;
      this.compose.accountId = opts.accountId || (this.accounts[0] ? this.accounts[0].id : '');
      this.compose.to = opts.to || '';
      this.compose.cc = ''; this.compose.showCc = false;
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
        });
      } else {
        this.openCompose({
          mode, accountId: acc ? acc.id : this.accounts[0]?.id,
          subject: m.subject.startsWith('Fwd:') ? m.subject : `Fwd: ${m.subject}`,
          text: `\n\n------------------\n转发自 ${m.from?.address || ''}（${this.fullDate(m.date)}）：\n\n${(m.text || '').slice(0, 4000)}`,
        });
      }
      this.readerOpen = false;
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
      if (this.compose.text && !confirm('关闭后未保存的内容会丢失，先存草稿吗？（确定=直接关闭）')) return;
      this.compose.open = false;
    },

    // ---------- 设置 ----------
    openSettings() {
      this.avatarOpen = false;
      this.settingsTab = 'accounts';
      this.addForm = { open: false, email: '', displayName: '', password: '', preset: null, imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465, testing: false, saving: false, message: '', ok: false };
      this.outlook.device = null;
      this.outlook.polling = false;
      this.outlook.error = '';
      this.modals.settings = true;
      this.loadOutlookConfig();
    },
    applyPreset(key) {
      this.addForm.preset = key;
      const p = PRESETS[key];
      if (p) { this.addForm.imapHost = p.imap[0]; this.addForm.imapPort = p.imap[1]; this.addForm.smtpHost = p.smtp[0]; this.addForm.smtpPort = p.smtp[1]; }
    },
    accountBody() {
      return {
        email: this.addForm.email,
        displayName: this.addForm.displayName || undefined,
        preset: this.addForm.preset || undefined,
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
    document.addEventListener('click', () => { this.acctOpen = false; this.avatarOpen = false; });
    try {
      const st = await this.api('/api/setup-status');
      if (!st.setupDone) { this.authMode = 'setup'; this.view = 'auth'; return; }
      await this.enterApp();
    } catch {
      this.authMode = 'login'; this.view = 'auth';
    }
  },
});

app.mount('#app');
