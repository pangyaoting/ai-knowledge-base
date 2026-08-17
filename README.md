# AI 知识库问答平台（RAG）

> 全栈 AI 应用：上传文档自动构建知识库，基于检索增强生成（RAG）实现"先查资料、再回答"的智能问答。
> 面向 2027 届校招的全栈主项目 · 2026.08 起开发

---

## ✨ 核心功能

| 模块 | 功能 | 状态 |
|------|------|------|
| 用户系统 | 注册/登录、JWT 双 Token 无感刷新、Redis 会话 | ✅ 完成 |
| 知识库管理 | 创建/重命名/删除知识库（数据隔离） | ✅ 完成 |
| 文档解析 | 上传 PDF / Word / Markdown / TXT，自动解析 | ✅ 完成 |
| 文本分块 | 手写递归字符分块（500 字/重叠 100） | ✅ 完成 |
| 向量化 | bge-m3 Embedding（批量 10 + 指数退避重试 + 限速） | ✅ 完成 |
| 向量检索 | pgvector + HNSW 索引，余弦距离 Top-K | ✅ 完成 |
| RAG 问答 | 检索 → Prompt 组装 → DeepSeek **SSE 流式输出** | ✅ 完成 |
| 引用溯源 | 回答标注 [来源N]，可查看原文片段 | ✅ 完成 |
| 对话管理 | 会话/多轮对话/中止生成/历史持久化 | ✅ 完成 |
| 混合检索 | 向量 + BM25 关键词 | 🚧 规划中 |
| 数据看板 | 使用统计、Token 消耗 | 🚧 规划中 |
| 2FA | TOTP 双因素认证 | 🚧 规划中 |
| 部署上线 | Docker + Nginx + HTTPS + CI/CD | 🚧 待服务器 |

## 🏗️ 架构

```
浏览器（Vue3 + Vite + TS + TailwindCSS）
   │  HTTP / SSE（axios + fetch-event-source）
   ▼
NestJS 后端（模块化 + 依赖注入）
   ├── Auth 模块（JWT 双 Token + Redis）
   ├── Knowledge 模块（知识库 CRUD + 上传解析分块向量化）
   └── Chat 模块（RAG 检索 + Prompt + DeepSeek 流式）
   │
   ├── PostgreSQL 16 + pgvector（业务数据 + 向量 + HNSW 索引）
   ├── Redis 7（refreshToken / 限流 / 会话）
   └── 外部 AI：DeepSeek（对话）· 硅基流动 bge-m3（Embedding）
```

**RAG 流程**：文档上传 → 解析 → 递归分块 → bge-m3 向量化 → 存 pgvector；提问 → 问题向量化 → HNSW 检索 Top-5 → 组装 Prompt（系统提示词 + 资料编号 + 历史）→ DeepSeek SSE 流式回答 → 前端逐字渲染 + 引用溯源。

## 🛠️ 技术栈

- **前端**：Vue 3.5 · Vite 5 · TypeScript 5.6 · TailwindCSS · Pinia · Vue Router · markdown-it · highlight.js
- **后端**：NestJS 10 · Prisma 5 · PostgreSQL 16 + pgvector · Redis 7 · openai SDK
- **AI**：DeepSeek `deepseek-chat`（流式）· 硅基流动 `BAAI/bge-m3`（1024 维 Embedding）
- **工程化**：pnpm workspace monorepo · ESLint · Prettier · Husky · commitlint · Docker Compose · GitHub Actions

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
│       ├── auth/        # 认证（JWT 双 Token）
│       ├── user/        # 用户
│       ├── knowledge/   # 知识库 + 文档解析分块 + Embedding
│       └── chat/        # RAG 问答 + SSE 流式
└── web/src/
    ├── api/  stores/  types/  utils/
    ├── components/ui/  # shadcn-vue 风格设计系统
    └── views/          # 登录/注册/知识库/文档/对话
packages/shared/        # 前后端共享类型
docs/                   # 项目规划与学习笔记（00-12）
```

## 📈 面试亮点速览

1. **SSE vs WebSocket**：单向流式场景选 SSE，基于 HTTP、浏览器自动重连、Nginx 只需关缓冲
2. **递归分块**：段落→句子→短语三级分隔符 + 100 字重叠，对比固定/语义分块后选递归
3. **pgvector + HNSW**：业务数据与向量同库，HNSW 索引让百万级向量检索毫秒级
4. **批量 Embedding**：100 chunk 只调 10 次 API，指数退避重试
5. **引用溯源**：检索资料带编号注入 Prompt，模型回答标注 [来源N]
6. **性能优化**：highlight.js 按需引入，对话页 JS 1054 kB → 170 kB（gzip 367 → 72 kB）
7. **安全**：bcryptjs + JWT 双 Token 轮换 + ownerId 数据隔离（越权 404）

> 简历项目描述与完整面试讲解脚本见 `docs/12-项目讲解与面试话术.md`
