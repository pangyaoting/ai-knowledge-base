# AI 知识库问答平台

基于 Vue3 + NestJS + RAG 的全栈 AI 知识库问答系统。

## 技术栈

- **前端**：Vue 3.5 + Vite 5 + TypeScript + TailwindCSS + Pinia
- **后端**：NestJS 10 + Prisma 5 + PostgreSQL + Redis
- **AI**：DeepSeek（对话）+ bge-m3（Embedding）
- **部署**：Docker + Nginx + GitHub Actions

## 快速开始

### 环境要求

- Node.js >= 20
- pnpm >= 8
- Docker Desktop（运行 PostgreSQL + Redis）

### 安装依赖

```bash
pnpm install
```

### 启动数据库

```bash
docker compose up -d
```

### 初始化数据库

```bash
cd apps/server
pnpm prisma:migrate
```

### 启动开发服务器

```bash
# 根目录执行，同时启动前后端
pnpm dev:server   # 后端 http://localhost:3000
pnpm dev:web      # 前端 http://localhost:5173
```

## 项目结构

```
.
├── apps/
│   ├── server/          # NestJS 后端
│   │   ├── src/
│   │   │   ├── common/  # 公共模块（Prisma、Redis、过滤器、拦截器）
│   │   │   └── modules/ # 业务模块
│   │   └── prisma/      # 数据库 schema
│   └── web/             # Vue3 前端
│       └── src/
│           ├── api/     # 接口封装
│           ├── components/
│           ├── composables/
│           ├── router/
│           ├── stores/
│           ├── styles/
│           └── views/
├── packages/
│   └── shared/          # 前后端共享类型
├── docker-compose.yml   # PostgreSQL + Redis
└── pnpm-workspace.yaml
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm dev:web` | 启动前端开发服务器 |
| `pnpm dev:server` | 启动后端开发服务器 |
| `pnpm build` | 构建前后端 |
| `pnpm lint` | 代码检查 |
| `pnpm format` | 代码格式化 |
| `docker compose up -d` | 启动数据库 |
| `docker compose down` | 停止数据库 |
