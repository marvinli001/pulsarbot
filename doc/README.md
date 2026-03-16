# Pulsarbot 文档总览

`doc/` 目录用于承载 Pulsarbot 当前代码库对应的使用文档、开发文档、部署文档和排障文档。这里的内容以仓库里的现有实现为准，不复述规划，不提前描述尚未落地的功能。

## 从哪里开始

如果你是第一次访问这个仓库，建议按下面顺序阅读：

1. [根目录 README](../README.md)：先理解项目定位、核心能力和本地运行方式。
2. [快速开始](quick-start.md)：把仓库拉起来，完成第一次 bootstrap。
3. [部署总览](deployment.md)：了解推荐部署拓扑、环境变量和上线清单。
4. [Railway + Telegram Mini App 部署指南](../DEPLOY_RAILWAY_TELEGRAM_MINIAPP.md)：按图索骥完成 Railway 上线。

## 按角色阅读

### 我是首次部署者

- [部署总览](deployment.md)
- [Railway + Telegram Mini App 部署指南](../DEPLOY_RAILWAY_TELEGRAM_MINIAPP.md)
- [常见问题与排障](help-and-faq.md)

### 我是开发者

- [快速开始](quick-start.md)
- [仓库结构与架构](project-structure.md)
- [开发、测试与运维](development-and-ops.md)
- [API 总览](api-overview.md)
- [自动化控制面设计](automation-control-plane.md)

### 我是日常运营者

- [管理台使用说明](miniapp-guide.md)
- [自动化控制面设计](automation-control-plane.md)
- [开发、测试与运维](development-and-ops.md)
- [常见问题与排障](help-and-faq.md)

## 文档索引

- [quick-start.md](quick-start.md)
  - 本地安装、构建、启动、bootstrap 和首次联调入口。
- [deployment.md](deployment.md)
  - 推荐部署拓扑、生产环境变量、Railway 上线清单和相关链接。
- [project-structure.md](project-structure.md)
  - monorepo 布局、运行时数据流、存储边界和代码落点。
- [miniapp-guide.md](miniapp-guide.md)
  - Telegram Mini App 管理台的使用顺序、面板职责和典型操作。
- [automation-control-plane.md](automation-control-plane.md)
  - Tasks、Task Runs、Triggers、Approvals、Executors、workflow templates，以及 Chrome extension / companion 执行端的设计说明。
- [development-and-ops.md](development-and-ops.md)
  - 开发命令、测试建议、运维入口、数据目录和发布前检查。
- [api-overview.md](api-overview.md)
  - 服务端主要 API 的分组索引。
- [help-and-faq.md](help-and-faq.md)
  - 本地联调、部署和运行时的常见故障处理。

## 编写原则

- 只写仓库里已经存在的能力和接口。
- 优先给出可执行命令、明确路径和实际入口。
- 同一件事只在一处写清楚，其他地方用链接串起来。
- 超出当前实现边界的规划，保留在根目录 `PLAN*.md` 中。
