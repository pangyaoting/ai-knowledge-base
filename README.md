# AI 知识库问答平台（RAG）

> 全栈 AI 应用：上传文档自动构建知识库，基于检索增强生成（RAG）实现"先查资料、再回答"的智能问答，并支持研究报告与自主研究 Agent。
> 面向 2027 届校招的全栈主项目 · 2026.08 起开发 · 前端为主、全栈打通

---

## ✨ 核心功能

| 模块 | 功能 | 状态 |
|------|------|------|
| 用户系统 | 注册/登录、邮箱验证码、JWT 双 Token 无感刷新、Redis 会话 | ✅ 完成 |
| BYO 大模型 | 用户自带 API Key（DeepSeek 等），AES-256-GCM 加密落库、会话级切换、推理等级 | ✅ 完成 |
| 知识库管理 | 创建/重命名/删除知识库（数据隔离）、文件夹管理、移动端适配 | ✅ 完成 |
| 文档解析 | 上传 PDF / Word / Markdown / TXT / 代码，异步队列（BullMQ）解析 | ✅ 完成 |
| 文本分块 | 手写递归字符分块（500 字/重叠 100，段落→句子→短语三级边界） | ✅ 完成 |
| 向量化 | bge-m3 Embedding（批量 10 + 指数退避重试 + 限速） | ✅ 完成 |
| 向量检索 | pgvector + HNSW 索引，余弦距离 Top-K | ✅ 完成 |
| 混合检索 | 向量 + pg_trgm 关键词，**RRF 排名融合**，再经 bge-reranker 两阶段精排 + 相关性门控 | ✅ 完成 |
| 查询改写 | 多轮对话指代消解（"它的原理"→ 独立完整查询），只影响检索不改语义 | ✅ 完成 |
| 联网检索 | Tavily 实时搜索，结果与知识库来源并列展示 | ✅ 完成 |
| RAG 问答 | 检索 → Prompt 组装 → DeepSeek **SSE 流式输出**，支持中止/多图/文件上传 | ✅ 完成 |
| 引用溯源 | 回答标注 [来源N]，点击可定位到原文片段（文档预览抽屉） | ✅ 完成 |
| 对话管理 | 会话/多轮对话/分支（注入历史）/全文搜索/导出 Markdown | ✅ 完成 |
| 增量向量化 | 内容哈希去重，同名同内容自动跳过，不重复消耗 Token | ✅ 完成 |
| 研究报告 | BullMQ 异步生成，分节撰写 + 汇总，断点可查 | ✅ 完成 |
| 自主研究 Agent | 限时限量（配额 + 计时）、任务队列断点续跑、联网精读 | ✅ 完成 |
| 数据看板 | 使用统计、Token 消耗、近 7 日趋势（ECharts） | ✅ 完成 |
| 2FA | TOTP 双因素认证 | 🚧 规划中 |
| 部署上线 | Docker + Nginx + HTTPS + CI/CD | 🚧 待服务器 |

## 🏗️ 架构

```
浏览器（Vue3.5 + Vite + TS + TailwindCSS + Pinia）
   │  HTTP / SSE（axios + fetch-event-source，KeepAlive 路由缓存）
   ▼
NestJS 后端（模块化 + 依赖注入）
   ├── Auth（JWT 双 Token + 邮箱验证码）
   ├── Knowledge（知识库 CRUD + 异步解析分块向量化 + 重排）
   ├── Chat（查询改写 + 混合检索 + Prompt + SSE 流式 + 联网）
   ├── Research / Research-Agent（BullMQ 异步任务队列）
   ├── Models（BYO 模型配置 + AES 加密）
   └── Stats（使用统计）
   │
   ├── PostgreSQL 16 + pgvector（业务数据 + 向量 + HNSW + pg_trgm 索引）
   ├── Redis 7（refreshToken / BullMQ 队列 / 限流）
   └── 外部 AI：DeepSeek（对话/视觉）· 硅基流动 bge-m3（Embedding）+ bge-reranker（重排）· Tavily（联网）
```

**RAG 流程**：文档上传 → 解析 → 递归分块 → bge-m3 向量化 → 存 pgvector；提问 → 多轮查询改写 → 向量 + pg_trgm 两路并行检索 → RRF 融合 → bge-reranker 精排 → 组装 Prompt → DeepSeek SSE 流式回答 → 前端逐字渲染 + 引用溯源。

## 🛠️ 技术栈

- **前端**：Vue 3.5 · Vite 5 · TypeScript 5.6 · TailwindCSS · Pinia · Vue Router · markdown-it · highlight.js · ECharts · lucide-vue-next
- **后端**：NestJS 10 · Prisma 5 · PostgreSQL 16 + pgvector + pg_trgm · Redis 7 · BullMQ · openai SDK
- **AI**：DeepSeek（对话/视觉模型自动路由）· 硅基流动 `BAAI/bge-m3`（Embedding）+ `bge-reranker-v2-m3`（重排）· Tavily（联网）
- **工程化**：pnpm workspace monorepo · ESLint · Prettier · Husky · commitlint · lint-staged · Jest（后端）· Vitest（前端）· GitHub Actions CI/CD

## 🚀 本地运行

```bash
# 方式一（本机推荐）：双击项目根目录的 一键启动.bat
# 方式二：分别启动
docker compose up -d          # 数据库（PostgreSQL + Redis）
pnpm install                  # 安装依赖
npx prisma migrate deploy --schema apps/server/prisma/schema.prisma   # 初始化数据库（在根目录跑，读根目录 .env）
pnpm dev:server               # 后端 http://localhost:3000/api
pnpm dev:web                  # 前端 http://localhost:5173
```

- Swagger 接口文档：`http://localhost:3000/api/docs`
- 所有配置放在**根目录 `.env`**（唯一配置源，参考 `.env.example`）：DeepSeek、硅基流动、Tavily 等 API Key（见 `docs/05-AI服务申请指南.md`）

## 📁 项目结构

```
apps/
├── server/src/
│   ├── common/          # Prisma、Redis、全局过滤器/拦截器/装饰器
│   └── modules/
│       ├── auth/        # 认证（JWT 双 Token + 邮箱验证码）
│       ├── user/        # 用户（头像上传）
│       ├── knowledge/   # 知识库 + 文档异步解析分块 + Embedding + 重排
│       ├── chat/        # 查询改写 + 混合检索 + SSE 流式 + 联网
│       ├── research/    # 研究报告（BullMQ）
│       ├── research-agent/  # 自主研究 Agent（BullMQ）
│       ├── models/      # BYO 模型配置（AES 加密）
│       └── stats/       # 使用统计
└── web/src/
    ├── api/  stores/  types/  utils/
    ├── components/ui/  # shadcn-vue 风格设计系统
    └── views/          # 登录/注册/知识库/文档/对话/研究/看板
packages/shared/        # 前后端共享类型
docs/                   # 项目规划与学习笔记（00-32）
```

## 📈 面试亮点速览

1. **SSE vs WebSocket**：单向流式场景选 SSE，基于 HTTP、浏览器自动重连、Nginx 只需关缓冲
2. **混合检索**：向量 + pg_trgm 两路并行，RRF 按排名融合（无需归一化调权重），再经 bge-reranker 交叉编码器精排 + 相关性门控（实测相关≈0.9+、无关≈0.00x）
3. **递归分块**：段落→句子→短语三级分隔符 + 100 字重叠，对比固定/语义分块后选递归
4. **多轮查询改写**：指代消解只作用于检索，回答仍用原问题，不改对话语义
5. **pgvector + HNSW**：业务数据与向量同库，HNSW 索引让百万级向量检索毫秒级
6. **批量 Embedding**：100 chunk 只调 10 次 API，指数退避重试；增量向量化内容哈希去重
7. **SSE 流式渲染**：fetch-event-source 消费 + AbortController 中止 + KeepAlive 路由缓存（切导航流不中断）
8. **前端体验**：自动滚动（用户上翻暂停跟随）、思考动画 + 实时计时、消息复制/分支、图片粘贴压缩上传
9. **安全**：bcryptjs + JWT 双 Token 轮换 + ownerId 数据隔离（越权 404）+ BYO Key AES-256-GCM 加密
10. **工程化**：ESLint/Prettier/Husky/commitlint 全绿，Jest/Vitest 单测，GitHub Actions 自动构建部署

> 简历项目描述与完整面试讲解脚本见 `docs/12-项目讲解与面试话术.md`
