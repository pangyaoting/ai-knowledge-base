# 阶段 2 学习笔记：Embedding 向量化（Step 5）

> 本阶段完成：chunk 表加 `embedding vector(1024)` 列 + HNSW 索引，接硅基流动 bge-m3 批量向量化，
> 上传文档自动完成"解析→分块→向量化→入库"，并用真实问题验证了语义检索。
> 配套代码：`apps/server/src/modules/knowledge/embedding.service.ts` + `documents.service.ts`

> **后续演进（2026-08 阶段 4 后）**：本笔记对应同步版实现。此后上传已改为 BullMQ 异步队列
> （`document-queue.service.ts` + `document-processor.service.ts`，concurrency 2、失败重试 3 次指数退避）；
> 失败清理逻辑迁移：保留 failed 行展示原因、恢复被标 replacing 的旧文档、不再删磁盘文件。
> 正文其余（bge-m3、BATCH_SIZE=10、HNSW、.env 路径、根目录跑 prisma）保持。

---

## 1. 这一阶段解决了什么

Step 3-4 之后，文档已经被切成 chunk 存在数据库里，但 chunk 只是"文本"。RAG 要做的**语义检索**，需要把文本变成"向量"——语义相近的文本向量距离就近。Step 5 就是给每个 chunk 生成向量：

```
chunk 文本 → 调 bge-m3 Embedding API → 1024 维向量 → 存进 chunks.embedding 列
```

---

## 2. 三个关键技术决策

### 2.1 向量列怎么加：Prisma 的 Unsupported 类型

pgvector 的 `vector(1024)` 类型 Prisma 不认识。三个方案：

| 方案 | 做法 | 问题 |
|------|------|------|
| A. 干脆不写进 schema | 只在数据库里加列 | Prisma 检测到"数据库多了个 schema 没有的列" → 漂移告警，下次 migrate 可能误删 |
| **B. `Unsupported("vector(1024)")` 占位**（本项目） | schema 里声明字段，列用原始 SQL 迁移创建 | 读写要走 `$executeRaw`/`$queryRaw`，不能像普通字段那样用 Prisma API |
| C. 升级到支持 vector 的 ORM | 换 Drizzle 等 | 推翻重来，不值 |

**选了 B**。schema 里：

```prisma
embedding  Unsupported("vector(1024)")? // Prisma 不管它，只当占位
```

迁移文件（手写，因为 migrate dev 非交互环境）：

```sql
ALTER TABLE "chunks" ADD COLUMN "embedding" vector(1024);
CREATE INDEX "chunks_embedding_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);
```

### 2.2 HNSW 索引：检索快的秘密

普通索引（B-tree）适合"等于/范围"查询，不适合"找最相似"。

- **HNSW（Hierarchical Navigable Small World，分层可导航小世界图）**：pgvector 提供的近似最近邻索引。原理是把向量组织成多层图，检索时从顶层粗找、逐层细化，**百万级向量检索毫秒级**。
- `vector_cosine_ops`：指定用**余弦相似度**（bge-m3 官方推荐的度量）。

**面试版**："向量检索我建了 HNSW 索引（cosine 距离），这是 pgvector 的近似最近邻方案，数据量到百万级依然毫秒级返回；不用它的话是暴力全表扫描。"

### 2.3 工程细节：批量 + 重试 + 限速

100 个 chunk 如果不优化，要调 100 次 API（又慢又贵又容易触发限流）。优化后：

| 手段 | 做法 | 效果 |
|------|------|------|
| 批量 | 每批 10 个文本一次请求（bge-m3 支持） | 100 chunk 只要 10 次请求 |
| 指数退避 | 失败后 500ms → 1s → 2s 重试，最多 3 次 | 临时网络抖动自动恢复 |
| 批次限速 | 批间固定 300ms 延时 | 免费额度 QPS 限制不触发 |

```ts
// embedding.service.ts 核心
const resp = await this.client.embeddings.create({
  model: 'BAAI/bge-m3',
  input: batch, // 一批 10 个
});
// 按 index 排序，保证返回顺序和输入一致
return resp.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
```

**注意**：OpenAI SDK 返回的 `data` 数组顺序**不保证**和输入一致，必须按 `index` 字段重排——这是实测踩到的细节。

---

## 3. 向量读写：为什么走原始 SQL

`embedding` 列不在 Prisma 模型能力范围内，写入用 `$executeRaw`：

```ts
await tx.$executeRaw`
  UPDATE "chunks" SET "embedding" = ${toPgVector(vector)}::vector WHERE "id" = ${chunkId}
`;
```

- `${toPgVector(vector)}`：把 `[0.1,0.2,...]` 转成字符串 `"[0.1,0.2,...]"`，再 `::vector` 转类型
- **参数化**：值通过 Prisma 的参数绑定传进去，不是字符串拼接——防 SQL 注入（虽然这里是数字，但习惯要养成）

查询（阶段 3 检索用）的核心算子：

```sql
-- <=> 是余弦距离（0=完全相似，2=完全相反），距离越小越相似
SELECT content FROM chunks
ORDER BY embedding <=> '[问题向量]'::vector
LIMIT 3;
```

---

## 4. 验证：语义检索真的有效吗

用真实问题测了检索（问题向量化后按余弦距离取 Top-3）：

```
问题：Vue3 的响应式系统相比 Vue2 有什么优势？
chunk 0  相似度 0.7574  "Vue3 的响应式系统基于 ES6 的 Proxy..."  ← 完美命中
chunk 2  相似度 0.6336  "computed/watch 用于派生状态..."          ← 部分相关
chunk 1  相似度 0.4702  "ref 用于包装基本类型..."                 ← 弱相关
```

Top-1 精确命中响应式系统段落——这就是 RAG 的灵魂：**不靠猜，靠检索**。

---

## 5. 本阶段踩的坑（重要！）

### 坑 1：`apps/server/.env` 影子配置（本次最贵的坑）

**现象**：服务器调 Embedding API 一直 "Connection error"，但同一段代码单独跑就好。

**排查过程**（一步步缩小范围）：
1. 前台跑 openai SDK → 通
2. 后台任务跑 → 通
3. 怀疑沙箱 → 放开权限重启 → 仍失败
4. **发现** `apps/server/.env` 存在，里面是阶段 0 的占位 key（`sk-你的key`）
5. 服务器配置 `envFilePath: ['.env', '../../.env']`——`'.env'` 相对启动目录（apps/server）优先加载

**根因**：**两个 .env 同名变量，靠前的文件赢了**。占位 key 含乱码字节 → 请求头非法 → 请求根本发不出去 → 报 "Connection error"。

**最终修复（结构性，杜绝再犯）**：配置**只保留一份**——根目录 `.env`：
- 后端 `envFilePath: ['.env', '../../.env']` 自带回退，`apps/server/.env` 删掉后自动读根目录；
- docker-compose 本来就从根目录插值 `${DB_USER}` 等；
- Prisma CLI 只从"当前目录"读 `.env`，所以 `prisma migrate` 统一在**根目录**执行（`--schema apps/server/prisma/schema.prisma`），根目录 devDependencies 里装了 prisma；
- `prisma generate` 不需要数据库环境，仍在 apps/server 里跑，生成位置不变。

**教训（面试可讲）**："排查网络问题时我没有先怀疑配置——项目里存在被旧 .env 覆盖真实配置的问题，我通过'前台/后台/沙箱'逐项排除后定位到配置加载顺序。之后我把配置收敛为根目录单一来源，后端用 envFilePath 回退、Prisma 用 --schema 从根目录执行，从结构上消灭了双文件漂移。"

### 坑 2：失败路径留孤儿数据

**现象**：Embedding 失败时，chunk 已写入但没向量，Document 标记 failed 后这些 chunk 成了孤儿。

**修复**：catch 块里 `chunk.deleteMany({ where: { documentId } })`，失败时把文件、chunk 一起清理，只留 Document 行展示错误。

**教训**："失败路径必须清理全部中间产物——文件、chunk、状态，三件套一致，不留半成品数据。"

---

## 6. 自测题

- [ ] 能说出 Prisma `Unsupported` 类型解决什么问题
- [ ] 能说出 HNSW 索引是干什么的、为什么比全表扫描快
- [ ] 能写出 OpenAI SDK 返回顺序和输入不一致时怎么处理
- [ ] 能说出指数退避的间隔怎么算（500ms→1s→2s）
- [ ] 能解释 `.env` 加载顺序的坑（envFilePath 数组顺序）
- [ ] 能在 psql 里写出一条余弦距离检索 SQL
- [ ] 能说出失败路径要清理哪些东西

> 下一步（阶段 3）：RAG 问答——检索接口 + Prompt 组装 + DeepSeek 流式输出（SSE）+ 前端对话界面。
> 阶段 2 还差前端页面（Step 7-8：知识库管理页 + 文档上传页），做完后端就完整了。
