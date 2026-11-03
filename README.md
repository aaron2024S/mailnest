# MailNest

自托管的**多邮箱聚合收发** Web 客户端：把 QQ、163、Gmail、企业邮等账号收进同一个界面，支持多用户、凭据加密落盘。单容器、无数据库。

![screenshot](docs/screenshot-main.png)

## 特性

- **多账号汇总**：「所有邮箱」把每个账号的收件箱合并成一列，未读总数一目了然，也可随时切到单个账号
- **多用户**：首次启动注册管理员；管理员可创建成员账户。每个用户的数据（凭据、草稿、缓存）存放在**独立目录**并用独立密钥 AES-256-GCM 加密——管理员也是运维角色，**看不到其他用户的邮件**
- **收发齐全**：IMAP 收信（文件夹 / 分页 / 附件下载）+ SMTP 发信（附件、回复 / 回复全部引用、自动归档到「已发送」）
- **批量与右键**：列表多选（全选 / Shift 连选）、批量已读 / 未读 / 标星 / 归档 / 删除 / 移动；邮件行右键菜单（回复、转发、标记、移动到…、删除）；新建文件夹 + 邮件拖放整理
- **国内邮箱友好**：客户端握手自动发送 IMAP `ID` 命令（网易系必需）；GBK 等编码正确解码；服务器报错映射为中文提示
- **安全**：scrypt 密码哈希、HttpOnly + SameSite 会话 Cookie、登录失败限速、写操作 CSRF 头校验、HTML 正文净化
- **轻量**：Node 单进程，无数据库，`data/` 一个目录就是全部状态，备份即拷贝

## 快速开始

```bash
mkdir mailnest && cd mailnest
mkdir -p data
curl -O https://raw.githubusercontent.com/aaron2024S/mailnest/main/docker-compose.yml
docker compose up -d
```

浏览器打开 `http://NAS_IP:8006`：

1. 首次启动会要求**创建管理员账户**（注册入口只在这个时候开放，之后自动关闭）
2. 右上角头像 → **设置 → 邮箱账号 → 添加**，选择服务商预设或直接填 IMAP/SMTP 参数
3. 密码一栏填**授权码**（QQ/163 在网页端开启 IMAP/SMTP 后生成，不是网页登录密码）

常用服务器参数（应用内会按邮箱域名自动填充）：

| 邮箱 | IMAP | SMTP | 密码说明 |
|---|---|---|---|
| QQ | imap.qq.com:993 | smtp.qq.com:465 | 16 位授权码 |
| 163 / 126 | imap.163.com:993 | smtp.163.com:465 | 客户端授权密码 |
| Gmail | imap.gmail.com:993 | smtp.gmail.com:465 | 两步验证 + 应用专用密码 |
| 腾讯企业邮 | imap.exmail.qq.com:993 | smtp.exmail.qq.com:465 | 密码或授权码 |
| 阿里企业邮 | imap.qiye.aliyun.com:993 | smtp.qiye.aliyun.com:465 | 密码 |

> **Outlook / Microsoft 365**：微软已停用密码登录（IMAP/SMTP 仅接受 OAuth2）。支持 **设备码授权**：
> 添加账号时选 Outlook → 首次使用需注册一个免费的 Azure 应用（界面里有直达链接与 4 步指引），
> 把「应用程序(客户端) ID」填进设置保存 → 点「连接 Outlook」→ 在 `microsoft.com/devicelogin`
> 输入界面显示的验证码（个人账户 9 位、企业账户 8 位）完成授权。应用 ID 由界面填写、存在实例设置里（它不是密钥，公共客户端流程不使用 secret），
> 所有用户共用，随时可在「更换应用 ID」里修改。
> 若注册时报「在目录外部创建应用程序的功能已被停用」：个人 Microsoft 账户 2024-06 起必须先有自己的目录
> （免费 Azure 或 M365 开发人员计划均可获得），详见界面里的提示。

## Agent 接入（MCP）

MailNest 内置 MCP 服务器（Streamable HTTP，无状态），AI 客户端可以通过它读写你的邮件。

**开启步骤：**

1. 网页端「设置 → Agent 接入」→ 生成令牌（勾选权限：读取 / 整理 / 发信）
2. 把令牌和地址填进客户端。通用配置：

```json
{
  "mcpServers": {
    "mailnest": {
      "type": "http",
      "url": "http://<你的地址>:8006/mcp",
      "headers": { "Authorization": "Bearer mn_mcp_你的令牌" }
    }
  }
}
```

Claude Code 也可以用命令行：

```bash
claude mcp add --transport http mailnest http://<地址>:8006/mcp --header "Authorization: Bearer mn_mcp_..."
```

**提供的工具（12 个）：** `list_accounts`、`list_folders`、`list_messages`、`read_message`、
`search_messages`（按关键词搜主题/发件人/收件人/已读正文，走本地索引）、
`set_flags`、`move_messages`、`delete_messages`（只进垃圾箱，不做永久删除）、`create_folder`、
`send_message`、`reply_message`、`save_draft`。

**要点：**

- 令牌**必须携带**，服务端不提供无鉴权模式；令牌等同创建者的账号权限，只能看到该用户自己的邮箱
- 令牌只存哈希，明文只在生成时显示一次；可随时撤销、可设有效期，撤销立即生效
- 每次工具调用都会记入审计日志；每令牌限速 60 次/分钟
- 没有公开的「改账号配置 / 改密码」类工具，即使令牌被签出全量权限也动不了账号本身
- 局域网直接用 `http://内网地址:8006/mcp`；要让云端 AI（Claude.ai / ChatGPT）访问需要公网 + 反代 + HTTPS，
  并在反代里放行 `/mcp` 路径。云端 connector 若强制 OAuth，暂不支持

## 安全建议

- 请通过**反向代理 + HTTPS** 暴露到公网，并在 compose 里把 `MAILNEST_SECURE_COOKIES` 改为 `true`；只在内网用可以保持 `false`
- `data/` 里是所有用户的加密凭据与登录会话，`secret.key` 是加密主密钥——**备份要带上整个目录，但不要把它放到不可信的地方**
- 管理员重置成员密码会生成一次性临时密码，请线下转交，对方登录后应尽快修改

## 从源码运行

```bash
npm ci
npm start          # 默认 8006 端口，数据在 ./data
```

环境变量：`PORT`（默认 8006）、`HOST`、`MAILNEST_DATA`（数据目录，默认 `./data`）、`MAILNEST_SECURE_COOKIES`。

> 换端口：compose 目录下放 `.env` 写 `PORT=9000`，或 `PORT=9000 docker compose up -d`。

## 构建镜像 / 发版

镜像只通过 GitHub Actions 构建发布（amd64 + arm64）：在 Actions 页面手动运行 **docker-publish** workflow，填入版本号即可，会推送 `<version>` 和 `latest` 两个 tag。

```bash
# 本地构建（需要 Docker 引擎）
docker build -t mailnest:dev .
```

## License

MIT。`public/vendor/vue.global.prod.js` 为 Vue.js 3（MIT），见 NOTICE。
