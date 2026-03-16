# 部署总览

这份文档给出 Pulsarbot 当前推荐的部署拓扑、最小环境变量和上线清单。若你准备直接部署到 Railway，请继续阅读 [Railway + Telegram Mini App 部署指南](../DEPLOY_RAILWAY_TELEGRAM_MINIAPP.md)。

## 推荐拓扑

当前项目推荐按三层拆分理解：

- cloud control plane：
  - 仅部署 `@pulsarbot/server`
  - 由 `apps/server` 同时提供 `/healthz`、`/miniapp/`、`/api/*`、`/telegram/webhook`
  - 不单独部署 `@pulsarbot/admin`
- owner 本地执行端：
  - `apps/chrome-extension`：加载为 unpacked Chrome extension，不单独部署为云服务
  - `apps/companion`：运行在 owner 自己控制的机器上，不单独暴露公网入口
- `cloud_browser`：
  - 当前只是预留 executor kind
  - phase1 不提供托管浏览器执行后端，也不需要为它准备单独服务

这样做的原因是：

- 管理台 API 默认使用相对路径
- 登录态与访问控制基于同域 cookie
- webhook、管理 API 和 Mini App 放在同一域名下最简单
- Chrome extension 和 native companion 都是“云端控制面之外的 owner 侧执行边缘”，不应该和 `server` 混成第二个公网服务

## 生产入口

部署完成后，你通常会用到三个 URL：

- `https://<your-domain>/healthz`
- `https://<your-domain>/miniapp/`
- `https://<your-domain>/telegram/webhook`

## 最小环境变量

| 变量名 | 必需 | 建议值 | 说明 |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 是 | `123456:xxx` | Telegram Bot Token |
| `PULSARBOT_ACCESS_TOKEN` | 是 | 强随机字符串 | 管理台访问口令 |
| `NODE_ENV` | 建议 | `production` | 生产模式 |
| `DATA_DIR` | 建议 | `/data` | 持久化目录 |
| `PUBLIC_BASE_URL` | 建议 | `https://<your-domain>` | 方便 webhook 推导和状态展示 |
| `TELEGRAM_WEBHOOK_URL` | 可选 | `https://<your-domain>/telegram/webhook` | 需要手动覆盖时设置 |
| `BODY_LIMIT_BYTES` | 可选 | `10485760` | 请求体大小限制 |
| `CORS_ORIGIN` | 可选 | `https://<your-domain>` | 生产环境建议收敛来源 |
| `PORT` | 可选 | `3000` | 如平台未自动注入可显式设置 |

## 不需要部署什么

当前上线时，不需要额外部署下面这些组件：

- `@pulsarbot/admin`
  - Mini App 产物已经由 `apps/server` 同域托管
- `@pulsarbot/chrome-extension`
  - 这是 owner 本地浏览器里加载的 unpacked extension，不是云服务
- `@pulsarbot/companion`
  - 这是 owner 自己运行的本地进程，不是云服务
- `cloud_browser`
  - 当前还没有可用的托管执行后端

## Railway 部署清单

1. 导入 Git 仓库后，仅保留 `@pulsarbot/server`
2. 确认服务使用根目录 `railway.json`
3. 配置最小环境变量
4. 挂载 volume 到 `/data`
5. 部署后验证 `/healthz`
6. 把 Telegram webhook 指向 `/telegram/webhook`
7. 在 BotFather 把 Mini App URL 指向 `/miniapp/`
8. 如果需要浏览器或本地高权限执行，再由 owner 后续接入 Chrome extension 或 companion

## Telegram 配置清单

### Webhook

部署完成后，需要把 Telegram webhook 指向你的服务：

- `https://<your-domain>/telegram/webhook`

你可以通过 Telegram API，或调用 `/api/system/telegram-webhook/sync` 完成同步。

### Mini App URL

BotFather 中的 Menu Button、Main App、Direct Link 都可以指向：

- `https://<your-domain>/miniapp/`

## 首次上线后的初始化顺序

1. 从 Telegram 打开 Mini App
2. 输入 `PULSARBOT_ACCESS_TOKEN`
3. 绑定 owner
4. 连接 Cloudflare
5. 初始化或接管资源
6. 配置 Provider 并执行 provider test
7. 回到 Telegram 私聊 Bot 验证真实对话

## Executor 接入清单

### Chrome Extension Executor

适用场景：

- 需要让云端任务操作 owner 已登录的网页会话
- 只需要浏览器能力，不需要本地文件系统或 shell

接入步骤：

1. 在 Mini App `Executors` 面板创建 kind=`Chrome Extension`
2. 配置最小 `allowedHosts`
3. 生成 pairing code
4. 在 owner 的 Chrome 里加载 `apps/chrome-extension/dist`
5. 在扩展 popup 里填入 server URL、executor id、pairing code
6. `Pair`
7. 把目标网页切到前台并执行 `Attach Current Window`

安全建议：

- 使用 dedicated Chrome profile
- 只 attach 你愿意暴露登录态的窗口
- 用 `allowedHosts` 做最小域名约束

### Native Companion

适用场景：

- 需要 `http / fs / shell` 或高权限本地浏览器执行
- 需要 owner 自控主机承担执行

接入步骤：

1. 在 Mini App `Executors` 面板创建 kind=`Companion`
2. 配置 capability 与 scope
3. 生成 pairing code
4. 在 owner 自己控制的机器上运行 `apps/companion`

两类执行端都接入到同一个云端 control plane，不需要第二个部署服务。

## 上线后优先检查什么

1. `/healthz`
2. `/api/system/health`
3. `/api/system/telegram-webhook`
4. Provider test 结果
5. 一轮真实 Telegram 对话
6. 如你启用了 executor，再检查一次：
  - `Executors` 面板在线状态
  - Chrome extension 的 attach state / origin
  - `Sessions` 面板里的 `executor_log`

## 深入阅读

- [Railway + Telegram Mini App 部署指南](../DEPLOY_RAILWAY_TELEGRAM_MINIAPP.md)
- [开发、测试与运维](development-and-ops.md)
- [常见问题与排障](help-and-faq.md)
