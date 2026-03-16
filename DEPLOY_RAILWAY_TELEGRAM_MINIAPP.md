# Pulsarbot 部署指南（Railway + Telegram Mini App）

这份文档回答三个核心问题：

1. 现在能不能直接部署到 Railway？
2. Telegram Bot 的 Mini App（Menu Button / Main App / Direct Link）怎么配？
3. 从 GitHub 导入后出现两个容器（`@pulsarbot/admin` 和 `@pulsarbot/server`）怎么处理？

## 1. 结论先说

可以直接部署到 Railway。

但按当前代码结构，**推荐只保留一个对外服务：`@pulsarbot/server`**。当前实际拓扑是：

- Railway 上的 `@pulsarbot/server`：云端 control plane
- owner 本地浏览器里的 `apps/chrome-extension`：browser-only executor
- owner 自己机器上的 `apps/companion`：native executor

原因是：

- `apps/server` 会托管 Mini App 静态页面，入口是 `/miniapp/`
- Telegram webhook 入口在同一个服务：`/telegram/webhook`
- `apps/admin` 不是独立后端服务，单独部署通常是冗余的
- Chrome extension 和 companion 都是 owner 本地执行边缘，不是第二个公网服务
- `cloud_browser` 当前只是预留 kind，不需要准备单独基础设施

## 2. 当前项目的线上入口（重要）

部署完成后你会用到这 3 个 URL：

- 健康检查：`https://<your-domain>/healthz`
- Mini App：`https://<your-domain>/miniapp/`
- Telegram webhook：`https://<your-domain>/telegram/webhook`

## 3. Railway 部署步骤（推荐：单服务）

### 3.1 导入仓库

把 GitHub 仓库导入 Railway 后，可能会自动识别成两个服务：

- `@pulsarbot/admin`
- `@pulsarbot/server`

### 3.2 服务处理建议

推荐做法：

- 保留 `@pulsarbot/server`
- 删除或停用 `@pulsarbot/admin`
- 不为 `chrome-extension` 或 `companion` 再创建 Railway 服务

如果你还在 Railway 的 staged changes（你截图里 `Apply changes` 那一层）：

1. 点 `Details`
2. 找到 `@pulsarbot/admin` 相关的新增变更
3. 点击该变更右侧的 `x` 丢弃
4. 只保留 `@pulsarbot/server` 再 Deploy

因为当前仓库已经在根目录 `railway.json`（并保留 `infra/railway/railway.json` 镜像）指定了部署入口，且 `infra/docker/Dockerfile` 会构建整个 monorepo，再由 `server` 对外提供 `/miniapp/`。

### 3.2.1 能否通过 `railway.json` 强制“只创建一个服务”？

结论：**不能只靠 `railway.json` 达成**。

原因（和 Railway 当前机制有关）：

- `railway.json` / `railway.toml` 是“单个服务部署配置”（build/deploy）；
- JavaScript monorepo 的“自动识别并 staged 多服务”发生在导入阶段；
- 所以配置文件能控制“这个服务怎么部署”，但不能控制“导入时创建几个服务”。

如果你要尽量接近“打开即用 + 永远单服务”，建议两种方式：

1. 导入后在 staged changes 丢弃 `@pulsarbot/admin`（一次性操作）；
2. 先创建空 Railway 项目，再手动只创建一个服务并连接这个 GitHub 仓库（从源头避免双服务）。

### 3.2.2 用代码配置 watch path（让 admin/ui 改动也触发 server 部署）

当前仓库已在根目录 `railway.json` 加入 `build.watchPatterns`（使用相对路径，无前导 `/`），包含：

- `apps/**`
- `packages/**`
- `market/**`
- `infra/docker/**`
- `infra/railway/**`
- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `turbo.json`
- `tsconfig.base.json`

这意味着你改 Mini App UI（`apps/admin/**`）或共享包（`packages/**`）时，`@pulsarbot/server` 也会触发 build/deploy。

如果仍看到 `No deployment needed - watched paths not modified`，通常是服务没有读取到这个配置文件。请在 Railway 服务里确认：

1. 已启用 Config as Code；
2. 若用 Railway 自动发现，优先使用根目录 `railway.json`；
3. 若你强制写了 Config as Code 路径，确保它指向 `railway.json` 或 `infra/railway/railway.json`；
4. 保存后手动点一次 `Deploy latest commit` 让新规则生效。

### 3.3 `@pulsarbot/server` 环境变量

至少配置：

| 变量名 | 必需 | 建议值 | 说明 |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 是 | `123456:xxx` | Bot Token |
| `PULSARBOT_ACCESS_TOKEN` | 是 | 强随机字符串 | 管理台访问口令 |
| `NODE_ENV` | 建议 | `production` | 生产模式 |
| `DATA_DIR` | 建议 | `/data` | 持久化目录 |
| `BODY_LIMIT_BYTES` | 可选 | `10485760` | 请求体大小限制（10MB） |
| `CORS_ORIGIN` | 可选 | `https://<your-domain>` | 生产环境建议收敛 CORS 来源 |
| `PORT` | 可选 | 通常由 Railway 在运行时注入 | 变量页可能看不到；生成域名时仍可能需要手动填 target port |

补充说明：

- “`PORT` 运行时注入”和“生成域名时选择 target port”是两件事；
- 即使 `PORT` 已自动注入，Railway 在 Public Domain 流程中仍可能要求你手动选一次 target port；
- 如果你想避免歧义，可直接显式设置 `PORT=3000`，然后在 Generate Domain 时填 `3000`。

### 3.4 挂载持久化卷

在 `@pulsarbot/server` 服务挂载 Volume，并挂到 `/data`，同时保证：

- `DATA_DIR=/data`

这样可以保留缓存、日志、导出暂存等运行数据。

### 3.5 部署并验证

部署成功后，先检查：

```bash
curl -sS https://<your-domain>/healthz
```

预期返回里包含 `"ok": true`。

如果 Railway 日志里持续出现 `Healthcheck failed` / `service unavailable`，优先检查下面两项：

1. 是否在**当前部署服务**里配置了这两个必需变量：
   - `TELEGRAM_BOT_TOKEN`
   - `PULSARBOT_ACCESS_TOKEN`
2. 是否误把变量配在了另一个服务（Railway 导入 monorepo 时可能出现双服务）

当前服务在缺少必需环境变量时会直接退出。最新版本会在启动日志中打印明确提示，例如：

`Server failed to start due to invalid environment variables:`

- `TELEGRAM_BOT_TOKEN: Required`
- `PULSARBOT_ACCESS_TOKEN: Required`

### 3.6 关于“导入仓库后自动挂载 Volume”

当前不能仅靠仓库内 `railway.json` 自动创建并挂载 Volume。原因是 Railway 的 Config as Code 仅覆盖 build/deploy 配置，不覆盖 Volume 资源本身。

所以 Volume 目前是二选一：

- 在 Railway 控制台创建并挂载（最直观）
- 用 Railway CLI 执行 volume add/attach（可脚本化，但仍是仓库外一次性操作）

结论：

- 你想要“完全导入即自动挂载 volume”，当前 Railway 原生流程做不到
- 但可以做到“导入即部署可用，外加一次性 1 分钟挂载 volume”

### 3.7 打开即用（最低操作）

如果你现在目标是先联调和验证，不追求数据长期保留，可用最短路径：

1. 只部署 `@pulsarbot/server`
2. 只填 `TELEGRAM_BOT_TOKEN` 与 `PULSARBOT_ACCESS_TOKEN`
3. 先不挂 Volume（使用临时存储）
4. 配置 webhook + BotFather Mini App URL

这样可以最快开跑。

注意：不挂 Volume 时，服务重建/迁移后 `DATA_DIR` 里的运行数据可能丢失，因此建议在你准备长期使用时再补上 `/data` 挂载。

## 3.8 Executor 与 Railway 的关系

当前需要明确区分三件事：

### Railway 负责什么

- 部署 `@pulsarbot/server`
- 提供 `/miniapp/`、`/api/*`、`/telegram/webhook`
- 承担 task runtime、approval、sessions、executors control plane

### Railway 不负责什么

- 不托管 `apps/chrome-extension`
- 不托管 `apps/companion`
- 不提供可用的 `cloud_browser` backend

### 这意味着什么

- 如果你只想先把 Bot + Mini App 上线，Railway 单服务就够了
- 如果你还想让任务操作浏览器登录态，再由 owner 在本地加载 Chrome extension
- 如果你还想让任务碰 `fs / shell / 本地文件`，再由 owner 在本地运行 companion

## 4. Telegram webhook 配置

Pulsarbot 使用 webhook 接收 Telegram 消息。部署成功后执行：

```bash
curl -sS -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-domain>/telegram/webhook" \
  -d "drop_pending_updates=true"
```

检查 webhook 状态：

```bash
curl -sS "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

你应看到 webhook URL 指向你的 Railway 域名。

## 5. BotFather 里配置 Mini App

你截图里的三个入口都可以指向同一个 Mini App URL：

- `https://<your-domain>/miniapp/`

### 5.1 Menu Button

在 BotFather -> Mini Apps -> Menu Button：

- URL: `https://<your-domain>/miniapp/`
- Title: 例如 `Open Pulsarbot`

### 5.2 Main App

在 BotFather -> Mini Apps -> Main App：

- URL: `https://<your-domain>/miniapp/`
- Launch Mode：建议 `Fullscreen`（管理台更易用）

### 5.3 Direct Link

在 BotFather -> Mini Apps -> Direct Link：

- URL: `https://<your-domain>/miniapp/`
- Title / Description：按你的运营文案填写
- 封面图可后续补

创建后 Telegram 会给你类似 `t.me/<bot_username>/...` 的直达链接。

## 6. 首次上线后的初始化顺序

1. 用 Telegram 里的目标 owner 账号打开 Mini App（不要先用普通浏览器）
2. 输入 `PULSARBOT_ACCESS_TOKEN` 并 Verify
3. 点击绑定当前 Telegram 用户为 owner
4. 连接 Cloudflare（如你要启用 D1/R2/Vectorize/AI Search）
5. 初始化或接管资源
6. 配置 Provider API Key 并做 provider test
7. 回到 Telegram 私聊 Bot 发消息验证

如果你要继续验证 executor：

8. 在 `Executors` 面板创建并配对 `Chrome Extension` 或 `Companion`
9. 用一个最小 task 做闭环验证

## 7. 两个容器场景说明（你当前截图对应）

如果你已经有两个服务：

### 方案 A（推荐）

- `@pulsarbot/server`：保留并对外
- `@pulsarbot/admin`：删除或停用

这是和当前代码最一致、最省心的方案。

影响说明（为什么不建议双服务并行）：

- 成本与构建时间上升：每次变更可能触发两条部署链路
- 运维复杂度上升：两个域名、两套变量、两份日志，容易混淆
- 当前代码是同域设计：Mini App 用相对路径 API + cookie 会话，天然更适合由 `server` 同域托管
- 误把 BotFather URL 指向 `admin` 服务时，可能出现 API/登录链路异常

### 方案 B（不推荐，且需要改代码）

把 `admin` 做成独立前端域名，把 `server` 做成独立 API 域名。

当前仓库默认使用相对路径请求 API、并依赖同域 cookie，会涉及额外改造（API Base URL、跨域与认证策略），不适合你现在的“先上线测试”目标。

## 8. 常见问题

### 8.1 Bot 不回消息

优先检查：

1. `setWebhook` 是否成功
2. webhook URL 是否是 `https://<your-domain>/telegram/webhook`
3. Railway 服务日志是否有 4xx/5xx

### 8.2 Mini App 打不开或白屏

优先检查：

1. BotFather 的 URL 是否是 HTTPS 且以 `/miniapp/` 结尾
2. `@pulsarbot/server` 是否成功构建并在线
3. 是否误把流量打到了 `@pulsarbot/admin` 服务

如果日志里出现这两条：

- `"root" path ".../apps/admin/dist" must exist`
- `Route GET:/miniapp/ not found`

说明服务端启动时没有找到前端构建产物，常见原因是：

1. 使用了旧镜像（未包含最新修复）；
2. 构建阶段没有执行 `@pulsarbot/admin` 的 build。

当前仓库已在 `@pulsarbot/server` 构建脚本中显式加入 `pnpm --filter @pulsarbot/admin build`，更新后重新部署即可。

### 8.3 浏览器访问 Mini App 提示 `initData is required outside development`

这是预期行为：生产环境要求 Telegram `initData`。请从 Telegram 客户端进入 Mini App。

### 8.4 启动日志报错 `ERR_MODULE_NOT_FOUND: @fastify/cookie`

如果日志类似：

- `Cannot find package '@fastify/cookie' imported from /app/apps/server/dist/index.js`

这不是业务代码问题，而是镜像打包阶段把 monorepo 的运行时依赖裁掉了。常见于旧版 Dockerfile 使用：

- `pnpm prune --prod`
- 手动 `cp -R /app/node_modules /runtime/node_modules`

处理方式：

1. 确认已部署包含最新 Dockerfile 的提交（`infra/docker/Dockerfile`）；
2. 在 Railway 构建日志中确认出现：
   - `pnpm --filter @pulsarbot/server deploy --prod --legacy /runtime/apps/server`
3. 同时确认不再出现：
   - `pnpm prune --prod`
4. 重新执行 `Deploy latest commit`。

补充：如果你已经改了仓库但日志仍显示旧命令，通常是服务没有读取到最新 Config as Code，先检查服务的配置文件路径是否指向根目录 `railway.json`（或 `infra/railway/railway.json`），再重新部署。

## 9. 上线后最小自检清单

- `GET /healthz` 正常
- `getWebhookInfo` 指向正确 URL
- Telegram 私聊 `/start` 有响应
- Menu Button / Main App / Direct Link 都能打开 Mini App
- Owner 账号可进入管理台，非 owner 会被限制
- 如果启用了 Chrome extension：
  - `Executors` 面板显示 `Attached`
  - 当前 origin 命中 allowlist
  - `Sessions` 中能看到 `executor_log`
- 如果启用了 companion：
  - `Executors` 面板显示 `online`
  - capability / scope 与 task preview 一致
