# 开发、测试与运维

这份文档关注开发命令、测试入口、本地联调方式，以及部署和日常运维时最常用的信息。

## 常用命令

在仓库根目录执行：

```bash
npm exec --yes pnpm@10.6.3 install
npm exec --yes pnpm@10.6.3 build
npm exec --yes pnpm@10.6.3 typecheck
npm exec --yes pnpm@10.6.3 test
npm exec --yes pnpm@10.6.3 test:e2e
```

按包执行：

```bash
npm exec --yes pnpm@10.6.3 --filter @pulsarbot/server dev
npm exec --yes pnpm@10.6.3 --filter @pulsarbot/admin dev
```

## 推荐本地联调方式

最稳妥的链路是：

1. `build`
2. `@pulsarbot/server dev`
3. 打开 `http://localhost:3000/miniapp/`

原因：

- 管理台 API 使用相对路径请求
- 当前 `apps/admin` 的 Vite 配置没有默认 API 代理
- 因此单跑 `apps/admin` 适合纯 UI 开发，不适合完整业务联调

## 测试结构

当前仓库的测试大致分为几类：

- 单元与模块测试
  - provider request
  - secret envelope
  - market loader
  - runtime resolver
  - mcp runtime / validation
  - memory search
  - token budget
  - telegram stream
- 集成测试
  - server flows
  - agent runtime
- 端到端测试
  - Playwright Mini App 流程

## Railway 部署

当前仓库已经提供：

- `infra/docker/Dockerfile`
- `infra/railway/railway.json`

`railway.json` 当前的关键行为：

- 使用 Dockerfile 构建
- 启动命令是 `node apps/server/dist/index.js`
- 健康检查路径是 `/healthz`
- 失败时自动重启

## `DATA_DIR` 说明

`DATA_DIR` 是本地或部署环境中的运行目录，当前主要承载：

- MCP 日志
- 导出暂存
- 临时文件
- 运行缓存

本地开发建议：

```bash
export DATA_DIR="./data"
```

生产部署建议：

- 把 volume 挂载到 `/data`
- 保持 `DATA_DIR=/data`

## 运行观测建议

排障时建议按以下顺序检查：

1. `GET /healthz`
2. `GET /api/system/health`
3. `GET /api/system/logs`
4. `GET /api/jobs`
5. `GET /api/mcp/servers/:id/logs`

## 多模态与后台作业

文档、语音、图片等链路会依赖 job 系统。出现抽取失败或状态异常时：

1. 先看 `Documents` 面板
2. 再看 `Jobs`
3. 必要时执行 `re-extract` 或 `retry`
4. 如果 memory 检索异常，再执行 `memory reindex`

## 建议的提交前检查

如果改动涉及服务端或运行时逻辑，至少执行：

```bash
npm exec --yes pnpm@10.6.3 typecheck
npm exec --yes pnpm@10.6.3 test
```

如果改动涉及管理台主流程，补充执行：

```bash
npm exec --yes pnpm@10.6.3 test:e2e
```
