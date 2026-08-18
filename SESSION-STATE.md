# 会话状态快照（自动维护，供上下文压缩后无缝续接）

> 用途：AI 知识库问答平台项目的工作状态。当对话超过 50% 容量触发压缩时，以此文件为唯一事实来源恢复上下文。
> 维护规则：每次大功能完成 / 环境变化 / 对话临近 50% 时刷新。

## 项目一句话

**AI 知识库问答平台**：上传文档自动解析分块向量化，基于 RAG（混合检索 + 两阶段精排 + 流式问答）回答用户问题，带引用溯源、联网检索、数据看板。全栈个人项目，2027 届前端求职主项目。

## 技术栈

- monorepo：pnpm workspace（`apps/web` Vue3.5+Vite5+TS5.6+Tailwind+Pinia；`apps/server` NestJS10+Prisma5+PG16+pgvector+Redis7；`packages/shared`）
- AI：DeepSeek `deepseek-chat`（SSE 流式）、硅基流动 `bge-m3`（embedding）+ `bge-reranker-v2-m3`（重排）、Tavily（联网检索）
- 工程：GitHub Actions（check+deploy）、Husky/commitlint/lint-staged、Docker Compose、BullMQ

## 已完成功能（时间线）

- 阶段 0：monorepo 骨架、用户系统（JWT 双 token/刷新轮换/Redis）、CI/CD、docker
- 阶段 1：登录注册、个人中心
- 阶段 2：知识库 CRUD、文档上传（多文件/目录/中文名/空文件拦截/失败清理/同名替换）、解析分块向量化
- 阶段 3：RAG 流式问答（SSE/Markdown/中止/引用溯源/多轮）、会话管理、导出 Markdown
- 阶段 4：联网检索（Tavily）、混合检索（pg_trgm+RRF+相似度阈值）、数据看板（include_usage Token 统计 + ECharts）
- 对标批次（docs/13）：多轮查询改写、异步任务队列（BullMQ，上传 72ms 秒回）、个人中心改密、空状态引导+示例数据、Reranker 两阶段检索、对话知识库多选联动、文档在线编辑、会话导出

## 当前环境状态（本机 Windows）

- PostgreSQL/Redis：WSL2 Alpine 内 docker（kb-postgres/kb-redis），`keep-docker-running.sh` 守护（含端口自愈）
- 后端：`start-backend.bat`（%~dp0 动态路径，编码免疫）→ http://localhost:3000
- 前端：`start-frontend.bat` → http://localhost:5173（vite dev）
- **一键启动.bat**：CRLF+纯ASCII+goto 结构+幂等+端口自愈
- 配置唯一源：**根目录 `.env`**（后端 envFilePath 回退、Prisma 从根目录跑 `--schema apps/server/prisma/schema.prisma`）

## 用户工作规则（重要）

1. 大功能先**方案对比 → 用户选择 → 教学讲解 → 实现**
2. 介绍功能用**大白话**（面向用户，不用开发者黑话）
3. 开发中**把自己当用户**自测每个小功能，体验问题/小 bug 交付前修掉，不让用户试错
4. 大功能拆成**子功能层层深入**，计划先行
5. **对话超过 50% 就压缩**：刷新本快照后触发压缩，续接以本文件为准
6. 文档沉淀在 `docs/00-13`

## 路线图剩余（详见 docs/13）

- ⏳ 文档预览+引用定位 → 移动端适配 → 会话/文档搜索 → 骨架屏/Toast
- ⏳ 2FA（TOTP）→ 配额 → 数据库备份 → 暗色模式
- ⏳ **部署上线（最后）**：需用户买服务器（阿里云/腾讯云 2核2G）→ 配 GitHub Secrets（SERVER_HOST/SSH_PRIVATE_KEY）→ deploy job 自动生效

## 待办 / 悬而未决

- ⚠️ Windows 服务 **rediszt3**（杂散 redis-server 占用 127.0.0.1:6379）：需**管理员**执行 `sc.exe stop rediszt3` + `sc.exe config rediszt3 start= disabled`；当前已用 `REDIS_HOST=::1` 绕过
- GitHub 推送依赖 **Watt Toolkit** 加速（重启后需手动打开）
- `.env` 只在根目录维护，勿在 apps/server 再建副本
- 测试脚本（.e2e/）用完即删，勿提交

## Git

- 仓库：https://github.com/pangyaoting/ai-knowledge-base （public）
- 提交身份：庞耀庭；全部功能已推送，CI 绿色
