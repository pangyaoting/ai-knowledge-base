# 04 · RAG 检索内核：混合检索、重排与门控

> **本章地图**
> - 学什么：为什么需要检索、向量检索（pgvector + HNSW）、关键词检索（pg_trgm）、RRF 排名融合、bge-reranker 两阶段精排、相关性门控、查询改写与指代消解、符号(C)/档案(A)优先策略、HyDE 兜底、全文(P0)分流、无资料时的回答策略、完整检索决策树
> - 代码在哪：`apps/server/src/modules/chat/rag.service.ts`（retrieve / symbolLookup / profileLookup / symbolsForDocs / loadFulltext）、`apps/server/src/modules/chat/rrf.ts`（rrfMerge）、`apps/server/src/modules/knowledge/rerank.service.ts`、`apps/server/src/modules/knowledge/embedding.service.ts`、`apps/server/src/modules/chat/chat.service.ts`（retrieveWithHyde / rewriteQuery / hydeExpand）、`apps/server/prisma/migrations/`（向量/HNSW/trgm 建索引 SQL）
> - 动手实验：把 `RERANK_MIN_SCORE` 调到 0.5 问一个冷门问题观察"拒绝给来源"；用 psql 直连数据库跑一条 pgvector 查询看 HNSW 索引
> - 本章难度：★★★（全书灵魂，建议精读源码后逐节对照）

---

第 03 章我们把文档切成了块、算出了向量、写进了 PostgreSQL。**但"能检索"和"检得好"之间隔着一整座山。** 这一章回答的问题只有一个：

> 用户问了一句中文，系统如何在几十万个文本块里，**在几十毫秒内、用可控的成本，找到真正该喂给模型的 5 段话，并且确保这 5 段话确实相关**？

这不是一道 SQL 能解决的。它需要一条流水线：向量检索（语义）与关键词检索（字面）并行召回 → 按**排名**而不是分数融合（RRF）→ 用昂贵的交叉编码器对少数候选**精排** → 用相关性阈值**门控** → 不够格就诚实地说"没找到"，而不是硬凑。在讲这条流水线之前，先回答一个更基本的问题。

---

## 一、为什么需要"检索"，而不是把整个知识库塞给模型

如果你只有 3 篇文档，把全文塞进提示词是最省事也最准确的做法——本项目也确实这么做了（P0 全文模式，第十章讲）。但一旦文档多起来，这个朴素方案会在四个维度同时崩掉：

| 维度 | 全塞给模型 | 检索后只喂相关片段 |
|---|---|---|
| **成本** | token 按输入计费，每问一次就把全库重传一遍，O(知识库大小) 随提问次数线性放大 | 只付 5 段片段的输入费，O(1) |
| **上下文窗口** | 几万字之后直接爆窗口，报"context length exceeded" | 5 段 ≈ 几千字，任意模型都装得下 |
| **延迟** | 输入越长，首 token 越慢（prefill 与输入长度成正比） | 首 token 明显更快 |
| **准确性** | 模型注意力被海量无关文本稀释，容易答非所问 | 模型"看着资料回答"，聚焦 |

**类比**：这就像开卷考试。把整座图书馆搬进考场，你翻书的时间比答题还长，还可能被无关书架带偏；真正高效的做法是先查目录锁定 3 本书，翻到相关那几页，把这几页复印给考生。

还有一个常被忽略的理由——**可溯源性**。RAG 产品最大的价值不是"答得对"，而是"答得有出处"：每句话能对应 `[来源N]`，用户点一下能跳回原文段落（前端的 `DocPreviewDrawer` 干的就是这件事）。没有检索，就没有"哪段资料支撑了这个回答"的锚点，幻觉无法被证伪，用户也无法核实。

### 1.1 检索的两个阶段：先广撒网，再精挑细选

工程上把检索拆成两段，这个思想来自推荐系统（粗排 → 精排）：

```
粗召回（第一段）: 快、便宜、多取
    向量路 + 关键词路 各取 ~15 条 → RRF 融合 → 15 条
        ↓
精排（第二段）: 慢、贵、只对少数候选做
    bge-reranker 交叉编码器逐条打分 → 门控 → 取 5 条
```

**为什么必须分两段？** 因为"召回质量"和"排序质量"是两种不同的技术，成本和精度差异悬殊：

- **向量/关键词检索**能在一两毫秒内扫完全库（靠索引），但它对"相关"的度量是粗糙的——向量只看"整体语义像不像"，关键词只看"字面重不重"。它们适合**过滤**：把几十万块筛到几十块，宁可漏检也不能慢。
- **交叉编码器重排**把"问题 + 每一段候选"拼在一起送进 Transformer 精读，精度高得多，但**每一段都要一次完整的前向推理**——只能对几十个候选做，绝不可能对全库做。

一句话概括这一章的主线：**把便宜的召回做得足够宽，把昂贵的精排用在刀刃上，最后用一扇门挡住不够格的资料。**

---

## 二、向量检索：把语义变成几何

### 2.1 为什么：文本没有"距离"，向量有

"语义相似"是个模糊概念，计算机没法直接比较两段话。向量化的思路是：训练一个模型（这里用硅基流动的 **BAAI/bge-m3**，中文效果顶尖、输出 **1024 维**），把任意文本映射成一个 1024 维向量，使得**语义相近的文本，向量在空间里靠得近**。

**类比**：把人按"身高、体重、发色、口音、爱好…"编码成 1000 个维度的"特征档案"，两个人在这些维度上越接近，就越可能是同一种人。文本同理——"如何设置用户头像"和"上传头像并保存到数据库"虽然用词完全不同，但编码后落在相近的区域，这就是语义检索能命中**同义改写**的原因。

第 03 章入库时，每个叶子块都通过 `EmbeddingService.embedTexts()`（OpenAI 兼容协议调 bge-m3）算好了向量，用原始 SQL 写回：

```sql
UPDATE "chunks" SET "embedding" = '[0.013,-0.021,...]'::vector WHERE "id" = '...'
```

注意这里**不能**用 Prisma 写——`vector` 不是 Prisma 支持的类型，schema 里只能用一个 `Unsupported("vector(1024)")` 占位（`schema.prisma` 里的 `Chunk.embedding`），真正的列和索引由迁移 SQL 创建，读写都走 `$queryRaw` / `$executeRaw`。这是"Prisma 管业务表、原始 SQL 管向量列"的分工，值得记住。

### 2.2 怎么比：余弦相似度与 `<=>` 算子

两个向量的相似度有多种度量，本项目用的是**余弦相似度**。为什么是余弦而不是欧氏距离？

- 余弦看的是**方向**（夹角），与向量的**模长**无关。文本长度差异巨大（短标题 vs 长段落），模长天然不同，欧氏距离会被长度"带偏"，余弦只关心"内容取向是否一致"。
- 数学上：`cosine similarity = (a·b) / (|a||b|)`。pgvector 不直接给你相似度，它提供的是**余弦距离**算子 `<=>`：

```
余弦距离 = 1 - 余弦相似度
```

所以代码里那句 `1 - (c.embedding <=> ${vectorStr}::vector) AS similarity` 就是在**把距离翻回相似度**：距离越近（`<=>` 越小），相似度越接近 1。

### 2.3 真实检索 SQL 逐行拆解

下面是 `rag.service.ts` 的 `retrieve()` 里"限定知识库"分支的向量检索 SQL（未限定分支只是把过滤条件换成 `kb.owner_id = 当前用户`，逻辑完全一致）。请逐行看：

```sql
SELECT COALESCE(parent_chunk.id, c.id)                 AS chunk_id,
       COALESCE(parent_chunk.content, c.content)       AS content,
       COALESCE(parent_chunk.chunk_index, c.chunk_index) AS chunk_index,
       d.id AS document_id,
       d.filename,
       1 - (c.embedding <=> ${vectorStr}::vector)       AS similarity
FROM chunks c
JOIN documents d                ON d.id = c.document_id
LEFT JOIN chunks parent_chunk   ON parent_chunk.id = c.parent_id
WHERE c.embedding IS NOT NULL
  AND d.knowledge_base_id = ANY(${kbLiteral}::text[])
  AND (${docLiteral}::text[] IS NULL OR d.id = ANY(${docLiteral}::text[]))
  AND 1 - (c.embedding <=> ${vectorStr}::vector) >= ${minSim}   -- 门槛 1：相似度阈值
ORDER BY c.embedding <=> ${vectorStr}::vector                  -- 距离升序 = 相似度降序
LIMIT ${limit}
```

几个关键点：

1. **`${vectorStr}::vector` 是参数绑定**。问题向量不是拼进 SQL 字符串的，而是以参数形式传入（`$queryRaw` 模板串会安全绑定），防注入。同理 `kbLiteral` / `docLiteral` 是两个 PG 数组字面量参数，其中 `docLiteral` 传 `null` 表示"不限文档"——那句 `(${docLiteral}::text[] IS NULL OR ...)` 就是为 null 情况写的短路条件。代码注释里特别提醒：**id 列是 TEXT 不是 UUID**，数组必须 cast 成 `text[]`，cast 成 `uuid[]` 会报 `text = uuid` 类型不匹配。

2. **`COALESCE(parent_chunk.*, c.*)` 是父子分块（P2）的"取整"**。第 03 章讲过：结构化文档的父块（整节）被切成小片（子块）用于检索定位，命中子块后要把**父块全文**交给模型——模型要的是完整一段，不是半截小片。所以 `c` 是带向量的被命中行（可能是子块），一旦它存在 `parent_id`，`LEFT JOIN` 命中父块，`COALESCE` 就把返回内容替换成父块的 id/正文/序号。没有父块的普通块（txt/pdf/代码）`parent_id` 为 NULL，`COALESCE` 退化为自身。

3. **阈值在 SQL 里就过滤了**（`>= ${minSim}`），不是查回来再滤。这样既省网络回传，又让索引扫描范围更小。

4. **范围收口**：要么 `knowledge_base_id = ANY(...)`（限定知识库），要么 `kb.owner_id = ${userId}`（不限定=搜该用户全部库）——**后者的 owner 过滤是数据隔离的生命线**，漏掉它就会搜到其他用户的知识库，这是 RAG 应用最严重的安全事故之一。

### 2.4 HNSW 索引：没有它，向量检索是灾难

上面的 SQL 如果全表扫，每个块都要算一次 1024 维的点积——十万个块就是十万次运算，一次提问几百毫秒，完全不可用。所以建索引（迁移 `20260817070000_add_chunk_embedding`）：

```sql
CREATE INDEX "chunks_embedding_idx"
  ON "chunks" USING hnsw ("embedding" vector_cosine_ops);
```

- **HNSW（Hierarchical Navigable Small World，分层可导航小世界图）**是目前最主流的**近似最近邻（ANN）**索引：把向量组织成多层图，高层大跨度跳、低层细搜，查找时从高层往下走，把"精确找最近邻"变成"快速找到足够近的邻居"。**代价是牺牲一点点精度（近似），换来数量级的速度**——百万级向量毫秒级返回。
- **`vector_cosine_ops`** 声明这个索引按余弦距离组织（pgvector 还有 L2 / 内积两个操作符类，三者不可混用，检索用的算子必须和索引匹配）。
- 对 RAG 场景，近似的少量漏检完全可以接受——反正后面还有 RRF 和重排兜着。**用全库精确扫描保证 100% 召回率，是最不值得花的钱。**

至此向量路完成：它负责"语义近"的召回，把"如何改头像"和"avatar update"这类**换了说法**的查询捞回来。

### 2.5 向量检索的天花板（为什么要混合）

但纯向量有一个知名盲区：**专有名词、型号、变量名、代码片段**。embedding 是"整段话语义的平均投影"，一段话里藏着一个冷门符号名时，这个名字的信号会被稀释到几乎为零。你问库里一个函数的确切名字 `rrfMerge`，语义上最接近的可能是任何一段"讲融合"的文字，而不是定义它的那几行。**字面的精确命中，向量天然不擅长。**于是需要第二路检索。

---

## 三、关键词检索：pg_trgm 三元组，补字面的漏

### 3.1 为什么：有些问题只认"字"

想想这些真实查询：

- 代码知识库里问 `MIN_SIMILARITY` 这个环境变量是干什么的；
- 文档里有一个专有名词"BullMQ"，问它如何配置；
- 用户直接粘贴了一段配置、一个报错字符串，问"这是哪来的"。

这些查询的共同点：**答案和问题共享精确的字符序列**，而且这段字符在语义空间里没有明显邻居。向量检索会漏，关键词检索却是一抓一个准。

为什么不用传统全文检索（PostgreSQL 的 `tsvector` 全文搜索）？因为 `tsvector` 按**词**分词、依赖词形还原，对中文（没有天然分词）、对代码标识符（`retrieveWithHyde` 这种驼峰串、`handle_send` 这种下划线串）都不友好，还会被词干化破坏精确匹配。

### 3.2 怎么做：pg_trgm 与三元组

`pg_trgm` 扩展的思路非常朴素：把任意字符串拆成连续 3 个字符的"三元组"（trigram），**两个字符串的相似度 ≈ 它们共享多少三元组**。例如 `knowledge` 的三元组有 `kno, now, owl, wl`（两侧还会补空格填充）。

迁移 `20260817161000_add_trgm_index`：

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX chunks_content_trgm_idx ON chunks USING GIN (content gin_trgm_ops);
```

`GIN` 倒排索引把"三元组 → 包含它的行"建好，查询时先把查询串也切成三元组，去倒排里找——这就是 `content % question` 能走索引的原因。

关键词检索 SQL 的结构与向量路几乎相同（同样的 COALESCE 取父块、同样的 owner/kb 过滤），差异只在选路和排序条件：

```sql
SELECT COALESCE(parent_chunk.id, c.id) AS chunk_id,
       COALESCE(parent_chunk.content, c.content) AS content,
       COALESCE(parent_chunk.chunk_index, c.chunk_index) AS chunk_index,
       d.id AS document_id,
       d.filename,
       similarity(c.content, ${question}) AS similarity        -- 三元组相似度 0~1
FROM chunks c
JOIN documents d ON d.id = c.document_id
LEFT JOIN chunks parent_chunk ON parent_chunk.id = c.parent_id
WHERE c.embedding IS NOT NULL
  AND d.knowledge_base_id = ANY(${kbLiteral}::text[])
  AND c.content % ${question}                                   -- 相似度 > 阈值才算"沾边"
ORDER BY similarity(c.content, ${question}) DESC
LIMIT ${limit}
```

三个容易忽略的细节：

1. **`%` 是一个布尔操作符**："左边内容的三元组相似度是否超过 `pg_trgm.similarity_threshold`（默认 0.3）"。它是查询的**粗门槛**，与向量路的 `MIN_SIMILARITY` 对称。0.3 意味着"四分之一以上的三元组重叠"，太宽松会引入噪声、太严格会漏掉改写——阈值可用 `SET pg_trgm.similarity_threshold = 0.4` 按库调。

2. **`similarity()` 只是排序键**。`WHERE ... % ...` 决定哪些行进，`ORDER BY similarity(...) DESC` 决定它们的先后。而**这个 0~1 的分数在融合阶段会被扔掉，只用排名**——这正是第四节的核心。

3. **代码注释特意说明 `c.embedding IS NOT NULL` 也出现在关键词路**——它不是语义要求（关键词检索用不着向量），而是"只检索叶子/检索块"的廉价过滤：父容器块不参与检索，无论哪一路都不该命中它们。

### 3.3 关键词检索的天花板

字面匹配的反面是：**换个说法就抓瞎**。"设置头像"三个字在文档里写的是"修改用户资料图片"，`%` 匹配率几乎为 0。关键词不知道"头像 ≈ 资料图片"。所以关键词路负责**精确**，向量路负责**泛化**，两路各有盲区、恰好互补——这就叫**混合检索（Hybrid Search）**。

现在的难题来了：两路各吐了 15 条，都自称"最相关"，**听谁的？**

---

## 四、RRF：为什么只比排名，不比分数

### 4.1 问题：两路分数根本不可比

直觉上的做法是：把向量相似度和关键词相似度加起来/加权平均，谁总分高听谁的。但这是错的，原因在于**两把尺子的刻度不在一个体系**：

| | 向量路分数 | 关键词路分数 |
|---|---|---|
| 物理含义 | 全库语义空间的余弦相似度（bge-m3 产出，分布受全库影响） | 两段文本的三元组重叠比例（pg_trgm 产出） |
| 典型取值 | 相关片段 0.4~0.8 | 沾边 0.1，高度重合才 0.6+ |
| 可移植性 | 换 embedding 模型，分布就变 | 与语言、文本长度强相关 |

把 0.6 的向量分和 0.3 的关键词分相加，等于把"厘米"和"华氏度"相加——数字上成立，物理上无意义。强行调和还需要给两路调权重，而这个权重在换模型、换语料后又要重调，**脆弱且不可维护**。

### 4.2 思路：扔掉分数，只保留"排第几"

RRF（Reciprocal Rank Fusion，倒数排名融合）提出了一个漂亮的"鸵鸟策略"：**既然分数不可比，那就根本不看分数，只看每条在本路里排第几。** 排名是路的内部排序产物，天然无量纲、天然可比。每条记录的融合分是它在各路的"倒数排名"之和：

```
score(chunk) = Σ  1 / (K + rankᵢ(chunk))
              i∈路
```

- `rankᵢ`：该 chunk 在路 i 里的名次（从 1 开始）；
- `K`：平滑常数，论文默认 60，`rrf.ts` 里的 `RRF_K = 60` 原样保留。

代码逐行看（`rrf.ts`，整个算法是纯函数、便于单测——`rrf.spec.ts` 就专测它）：

```ts
export function rrfMerge(vectorRows: RrfRow[], keywordRows: RrfRow[], topK: number): RrfRow[] {
  const scores = new Map<string, { score: number; row: RrfRow }>();
  const add = (rows: RrfRow[]) => {
    rows.forEach((row, i) => {
      const rank = i + 1;                          // 传入即有序，数组下标即排名
      const contribution = 1 / (RRF_K + rank);     // 第 1 名贡献 1/61，第 2 名 1/62，……
      const cur = scores.get(row.chunk_id);
      if (cur) cur.score += contribution;          // 两路都命中：分数累加
      else scores.set(row.chunk_id, { score: contribution, row });
    });
  };
  add(vectorRows);    // 先加向量路
  add(keywordRows);   // 再加关键词路
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)   // 融合分降序
    .slice(0, topK)                      // 取 Top-K
    .map((x) => x.row);
}
```

**为什么加 `K`？** 防止第 1 名的贡献（1/61）与第 2 名（1/62）差距过大——`K` 越大，相邻名次的差距越小，融合结果越"民主"；没有 `K`（即 K=0）时第 1 名贡献 1、第 2 名贡献 1/2，第一名几乎一票定音。`K=60` 是论文在多个数据集上调出来的稳健值。

**为什么先 add 向量路？** 注释写得很清楚：融合分相同时（比如 A 只在向量路排第 1，B 只在关键词路排第 1，两路各只有 1 条候选时分数恰好相等），数组顺序决定了谁留在前面。先加向量路 = **语义命中优先展示**（对"换个说法提问"更友好）。

### 4.3 数值直觉：为什么"两路都沾边"能赢过"一路第一"

用一个例子感受融合分的行为（`1/61≈0.0164`，`1/62≈0.0161`，……）：

| 片段 | 向量路排名 | 关键词路排名 | RRF 融合分 |
|---|---|---|---|
| A | 1 | 不在 | 1/61 ≈ 0.0164 |
| B | 不在 | 1 | 1/61 ≈ 0.0164 |
| C | 1 | 1 | 2/61 ≈ 0.0328 ← 断层第一 |
| D | 3 | 8 | 1/63 + 1/68 ≈ 0.0306 |
| E | 10 | 12 | 1/70 + 1/72 ≈ 0.0282 |

看 D 和 E：它们**没有一路进前三**，却因为被两路同时捞到（"语义相关 + 字面相关"的双重证据），融合分超过了只被一路认为第一的 A、B。这正是混合检索想要的：**两路互相印证的内容，比单一路的"头名"更可信。**

### 4.4 RRF 的输入输出：为什么要"多取"

`retrieve()` 里召回量的设计（数字别记混）：

```ts
const limit = Math.max(topK * 3, 15);   // 每路 SQL 的 LIMIT：topK=5 时两路各取 15
// …
const merged = rrfMerge(vectorRows, keywordRows, Math.max(topK * 3, 15));  // 融合后仍留 15
```

为什么每路取 15、融合后也留 15，而不直接每路取 5？**因为两路的 Top-5 很可能高度重叠**（同一批好文档两路都排在前面），各取 5 融合完可能只剩 6~7 条，精排就没得挑了。多取是为了给"两路互补的尾部候选"留出位置——**粗召回宁滥勿缺，真正的把关交给下一段精排。**（类似推荐系统的粗排池要远大于精排窗口。）

到此，15 条候选已经带着一个粗略的"可信度"排好了序。但它仍然只是**粗排**——因为 RRF 不知道每条候选和问题的真实关系，它只知道"两路检索器都觉得它不错"。精排登场。

---

## 五、两阶段精排：bge-reranker 交叉编码器

### 5.1 为什么：粗排是"代理指标"，精排才看"真实关系"

向量检索/关键词检索之所以快，是因为它们在入库时就把每块文本**预处理**成了可索引的形式（向量、三元组），查询时只做廉价的近似比较。代价是：问题与片段**从未真正"一起"被模型看过**。

精排用的**交叉编码器（cross-encoder）**完全不同：它把"问题"和"某一段候选"**拼成一个输入**，送进同一个 Transformer，让注意力机制在问题和文档之间**自由贯穿**——模型是真正逐字读完"问句 + 这段资料"之后，才给出一个 0~1 的相关性分。这就是"双塔检索 + 交叉编码重排"这一业界标配组合的分工：

```
双塔/向量（召回阶段）: 文本各自编码 → 余弦近邻，快，但问题和文档只在"最后一步"点积相遇
交叉编码器（精排阶段）: 问题和文档拼起来一起编码，慢，但每一个字都能互相看到
```

**类比**：向量检索像"简历初筛"——看关键词是否匹配，一秒钟刷掉一千份；交叉编码器像"面试"——把候选人和岗位要求放在同一张桌上深聊，准确但一次只能面一个人。

**为什么贵？** 两条原因：

1. **不能预计算**：入库时你可以把每块文本预编码成向量存好，查询时直接比。但交叉编码器的输入是"问题 + 候选"的拼接，**问题每次都不一样**，所以每个候选都必须现算一次完整前向。N 个候选 = N 次 Transformer 前向，且输入长度是"问句 + 候选"的总长。
2. **API 费用**：本项目用硅基流动托管的 `BAAI/bge-reranker-v2-m3`，精排按 token 计费。

所以精排**只能**用在粗召回筛出来的几十条上，绝不可能扫全库——这就是两阶段架构存在的原因。**把贵但准的技术用在少数候选人上，把便宜但快的技术用在海量候选人上。**

### 5.2 怎么做：调用 SiliconFlow 的 /rerank

`apps/server/src/modules/knowledge/rerank.service.ts`（注意：文件在 **knowledge** 模块而不是 chat 模块——第 01 章说过，知识模块负责"知识/嵌入/重排"，`chat.module.ts` 通过 `KnowledgeModule` 的 exports 注入 `RerankService`）：

```ts
@Injectable()
export class RerankService {
  private get baseUrl() { return this.configService.get<string>('SILICONFLOW_BASE_URL', 'https://api.siliconflow.cn/v1'); }
  private get apiKey()   { return this.configService.get<string>('SILICONFLOW_API_KEY'); }
  private get model()    { return this.configService.get<string>('SILICONFLOW_RERANK_MODEL', 'BAAI/bge-reranker-v2-m3'); }

  get enabled(): boolean {            // 没配 key/模型 → 整个重排环节跳过
    return !!this.apiKey && !!this.model;
  }

  async rerank(query: string, documents: string[], topN: number) {
    if (!this.enabled || documents.length === 0) return null;   // 降级信号
    try {
      const res = await fetch(`${this.baseUrl}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, query, documents, top_n: topN }),
        signal: AbortSignal.timeout(15_000),                     // 15 秒超时：宁可降级也不拖死请求
      });
      if (!res.ok) { this.logger.warn(`重排接口返回 ${res.status}`); return null; }
      const data = await res.json();
      const results = (data.results ?? []).sort((a, b) => b.relevance_score - a.relevance_score);
      return results.map((r) => ({ index: r.index, score: r.relevance_score }));
    } catch (err) {
      this.logger.warn(`重排失败，回退 RRF: ${(err as Error).message}`);
      return null;
    }
  }
}
```

设计上有三个值得品味的点：

1. **返回的是 `{ index, score }` 而不是重排后的文本**。`index` 是候选在传入数组里的下标，调用方用它回查原始行。这让重排服务保持纯粹（只打分，不搬运数据），也让调用方（`rag.service`）能用 `merged[r.index]` 取回完整来源信息。

2. **任何失败都返回 `null`，而不是抛异常**。调用方看到 `null` 就回退到 RRF 顺序（第五节末尾的降级分支）。注释原话："重排是增强不是依赖"——一个外部 API 挂了，不能成为整个问答不可用的理由。**可用性优先级高于效果**，这是所有"锦上添花型"组件（重排、联网、HyDE）的统一设计哲学，后面还会反复见到。

3. **15 秒硬超时**（`AbortSignal.timeout`）。重排发生在 SSE 流的"回答前"，用户正在等首 token；重排器要是慢吞吞 60 秒，体验就毁了。宁可放弃精排直接按 RRF 出结果，也不能让用户干等。

### 5.3 分数长什么样 & 精排的调用点

回到 `rag.service.ts` 的 `retrieve()`，两阶段在这里汇合：

```ts
const ranked = await this.rerankService.rerank(
  question,
  merged.map((r) => r.content),                  // 15 条候选内容全部送评
  Math.max(topK * 2, 10),                        // 只要求返回相关性最高的 10 条
);
if (!ranked) {
  return merged.slice(0, topK).map(toSource);    // 重排不可用 → 直接按 RRF 顺序取前 5（降级）
}

const minScore = this.rerankMinScore;            // 默认 0.1
const gated = ranked
  .filter((r) => r.score >= minScore)            // 相关性门控：低于阈值直接扔
  .slice(0, topK)                                // 截断 Top-5
  .map((r) => merged[r.index])                   // 用 index 回查原始候选
  .map(toSource);
```

把整条链路的数字串起来（默认 `topK = 5`）：

```
两路各召回 15 条（SQL LIMIT 15）
   → RRF 融合取 15 条
   → 15 条全部送给交叉编码器打分（API 只回传 top_n = 10）
   → 门控（score >= RERANK_MIN_SCORE，默认 0.1）
   → 截断前 5 条 → 作为 kbSources 进入 Prompt
```

bge-reranker 的分数量纲与向量相似度完全不同，代码注释给了实测经验：**相关的片段 ≈ 0.9+，无关的 ≈ 0.00x**。分数两极分化非常明显——这是交叉编码器"精读后"的自信表达，也是它能当"门"用的前提。

---

## 六、相关性门控：够不着就不给，宁可不答不乱答

### 6.1 为什么：知识库问答的信任基石

想象最坏的情况：用户问"如何部署到生产环境"，你的知识库只有一篇讲"如何本地调试"的文档。检索器矮子里拔将军，硬塞了 5 段"调试"片段，模型照着这些片段一本正经地回答了"部署"——**这就是 RAG 最臭名昭著的失败模式：看似有来源、实则答非所问**。更糟的是它比普通幻觉更难发现，因为回答确实"引用了资料"。

门控要解决的正是这个问题：**相关性不够，就不让这段资料进 Prompt。** 让模型对着不相关的资料回答，等于把骗子请进证词席——它会把不相关的资料当成依据，编出带引用的错误答案。

### 6.2 两道门：不同阶段、不同尺子

本项目有两道相似度门槛，容易混为一谈，务必分清：

| 门槛 | 常量 | 默认值 | 用在哪 | 衡量什么 |
|---|---|---|---|---|
| 向量相似度下限 | `MIN_SIMILARITY` | 0.35 | 向量路 SQL 的 `WHERE` | 片段与问题的**余弦相似度**（语义距离尺） |
| 重排相关性下限 | `RERANK_MIN_SCORE` | 0.1 | 精排之后 `filter` | 交叉编码器的问题↔片段**相关性分**（精读尺） |

两道门各有位置、各管一段：

- **`MIN_SIMILARITY`（0.35）是粗召回阶段的廉价门**：低于 0.35 的向量候选连进 RRF 的机会都没有。注意它**只拦向量路**——关键词路用 `%` 操作符自己的 0.3 阈值拦。为什么向量门设得松（0.35）？因为向量分本身粗糙，太严格会在召回阶段就误杀，把"两路印证"的机会提前断送。**粗召回阶段宁宽，精排阶段宁严**——又是两阶段哲学。
- **`RERANK_MIN_SCORE`（0.1）是精排后的闸门**：它出现在最下游，过滤的是已经过交叉编码器精读的分数。0.1 看起来小，但别忘了 bge-reranker 的分数是**两极分化**的——相关 ≈ 0.9+，无关 ≈ 0.00x，0.1 已经能干净地切开两堆。**阈值小≠不严格**，分数分布决定阈值语义，这点面试常被追问。

两道门的代码位置：

```ts
// rag.service.ts
private get minSimilarity(): number {
  const v = Number(this.configService.get<string>('MIN_SIMILARITY', '0.35'));
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.35;   // 非法值回落默认
}
private get rerankMinScore(): number {
  const v = Number(this.configService.get<string>('RERANK_MIN_SCORE', '0.1'));
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.1;
}
```

两个 getter 都做了**配置健壮性校验**（不是数字/超出 0~1 就回落默认值）——.env 手滑写错不会让系统崩掉或行为异常，这个习惯贯穿整个项目。

### 6.3 门控不过：日志与"空手而归"

```ts
if (gated.length === 0) {
  this.logger.log(
    `两阶段检索: 召回 ${merged.length} 条 → 重排后全部低于相关性阈值 ${minScore}，判定无相关内容`,
  );
}
```

门控把 15 条全滤掉时，`retrieve()` 返回**空数组**。此时调用链（`chat.service` 的 `retrieveWithHyde`）不会就此罢休——它会依次尝试"放宽范围再检一次""HyDE 假设文档再检一次"（第七~九章讲），最终仍为空才进入"无资料回答"策略（第十章）。**注意门控滤掉的是"不可靠的片段"，不是"回答的权利"**——具体怎么回，看第十章。

为什么"宁可不答不乱答"这么重要？因为**知识库问答的定位就是"可信"，宁可让用户知道"这里没有"，也不能用看似有出处的错误答案污染信任**。一次带假来源的胡答，比十次诚实的"没找到"都更伤产品。

---

## 七、查询改写与指代消解：多轮对话里"它"是谁

### 7.1 为什么：检索必须"自言自语"

多轮对话的第二问通常是残缺的：

- 用户："`Chat.vue` 是怎么做流式渲染的？" → 助手答了一长串。
- 用户紧接着："**那它是怎么做到不卡顿的？**"

如果拿"那它是怎么做到不卡顿的？"原样去检索知识库，向量会找"不卡顿"相关的东西，关键词会把"那""它""怎么""不卡顿"切成一堆无意义三元组——**几乎必然检索失败**。可人显然知道"它"指"流式渲染"。

检索是**无状态的**：每次 `retrieve()` 只拿到一个孤零零的查询串，它看不到前面聊了什么。所以必须在检索前，把"含指代的对话句"翻译成"独立完整的检索查询"——"Chat.vue 的流式渲染是怎么做到不卡顿的？"。

### 7.2 文件证据：改写逻辑不在独立文件里

先澄清一个事实：**本项目没有 `query-rewrite.service.ts`**。查询改写实现在 `chat.service.ts` 的私有方法 `rewriteQuery()` 里，与 RAG 编排同处一室，因为它要同时访问会话、历史、模型目标三样东西。

触发条件（`askAndStream` 里）很克制：

```ts
const HISTORY_ROUNDS = 6;                      // 最近 3 轮（6 条）
// ② 多轮查询改写：有历史时，先把问题改写为"独立完整"的问法再检索
const needRetrieval = useKnowledgeBase || useWebSearch;   // 不需要检索就不改写
const searchQuery =
  history.length && needRetrieval && question.trim()
    ? await this.rewriteQuery(question, history, target)
    : question;
```

三个条件缺一不可：**有历史**（第一问没有指代可消解）、**需要检索**（纯对话模式根本不用检索，改写了也白写）、**问题非空**。这行代码的言外之意是：**改写是一次真实的 LLM 调用，能省则省**——纯对话模式下每次提问省一次小调用，积少成多。

`rewriteQuery()` 本体：

```ts
const res = await client.chat.completions.create({
  model: target.model,             // 用用户自己的模型（BYO），token 用户买单
  messages: [
    { role: 'system', content:
      '你是查询改写助手。根据对话历史，把用户最新提问改写为一个独立、完整、无指代的检索查询（例如"它的原理是什么"→"【主题】的原理是什么"）。只输出改写后的查询本身，不要任何解释或前缀。若无需改写则原样输出。' },
    { role: 'user', content:
      `历史对话：\n${history.slice(-6).map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, 200)}`).join('\n')}\n\n最新提问：${question}` },
  ],
  max_tokens: 100,
  temperature: 0,                  // 改写不是创作：0 温度保证稳定、可复现
});
const rewritten = res.choices[0]?.message?.content?.trim();
return rewritten && rewritten.length > 0 && rewritten.length < 200 ? rewritten : question;
```

要点：

1. **历史只取最近 6 条、每条截断 200 字符**（`m.content.slice(0, 200)`）——消解指代只需要"最近在聊什么"，不需要完整历史，省 token；
2. **`temperature: 0`**：改写是确定性任务，不需要想象力；
3. **输出做防御性校验**：空输出、超 200 字符的输出都视为异常，**回退原问题**。改写失败绝不阻塞主流程（和重排失败回退是同一个哲学）；
4. **改写用的是用户自己的模型 Key**，所以这条"额外调用"的成本是透明的 BYO 成本。

### 7.3 最关键的设计：改写只影响检索，不影响回答

看 `askAndStream` 里两个变量的分工：

```ts
const searchQuery = … await this.rewriteQuery(question, history, target);  // 改写后的 → 拿去检索
// 检索用 searchQuery，但……
kbSources = await this.retrieveWithHyde(userId, searchQuery, kbScope, target, sessionId);
webSources = useWebSearch && canRetrieve ? await this.webSearchService.search(searchQuery) : [];

// 组装 Prompt 时用的是用户的原问题 question，而不是 searchQuery
const { system, messages } = this.buildPrompt(question, kbSources, webSources, history, …);
```

- `searchQuery`（改写结果）只流向两处：`retrieveWithHyde()` 和 `webSearchService.search()`——**检索**。
- `buildPrompt()` 收到的是原始 `question`——**回答**。

为什么刻意分开？因为改写是为了"让检索器听懂"，**不是为了改变对话语义**。如果拿"Chat.vue 的流式渲染是怎么做到不卡顿的"这个冗长的改写问句去问模型，模型会以为用户真的把完整问题又说了一遍，回答的开头可能变成"你问的是流式渲染如何避免卡顿，让我解释……"，画蛇添足。**用户看到的问题、模型回答的问题，永远是用户自己的原话**；改写是检索流水线内部的私事，绝不外溢。这是多轮 RAG 里最容易做错、也最见功力的一点。

---

## 八、符号检索(C)与文件档案(A)：让代码问答"指哪打哪"

第 05 章会看到 `retrieveWithHyde()` 的真正顺序。但在讲编排之前，必须先讲清它的两个"外挂"武器——这正是本项目（一个以**代码仓库**为主要知识来源的知识库）区别于通用 RAG 的地方：**通用 RAG 在"文本块"这一层做文章，本项目还在"代码符号"和"文件"两层做了索引。**

### 8.1 C：符号级命中——问题点名，直接掏源码

**问题**：在代码知识库里问"`rrfMerge` 是怎么实现的"，语义检索能找到什么？它找到的是"任何提到合并/融合/排序的文字"，很可能是一段**讲解 RRF 的笔记**，而不是**函数实现本身**——除非运气好。而用户要的是：**把这个函数的源码给我**。

**做法**：入库时（第 03 章 `document-processor.service.ts` 的 `indexSymbols()`）用 **TS Compiler API** 解析代码文件，把每个符号（函数/类/接口/组件…）连同**行号范围、签名、完整实现源码 body** 存进 `code_symbols` 表（迁移 `20260905130000_add_code_symbols`）：

```sql
CREATE TABLE "code_symbols" (
  "id" TEXT PRIMARY KEY,
  "document_id" TEXT NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "filename" TEXT NOT NULL,
  "symbol_name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,            -- function / const / class / interface / component …
  "signature" TEXT NOT NULL DEFAULT '',
  "body" TEXT NOT NULL DEFAULT '', -- 符号实现源码（命中后直接作为引用返回）
  "start_line" INTEGER NOT NULL,
  "end_line" INTEGER NOT NULL
);
```

检索时（`rag.service.ts` 的 `symbolLookup()`），思路从"语义像不像"变成"**名字在不在**"：

```ts
// 提取问题里的标识符（camelCase/snake 等符号名），排除 3 字符以下减少噪音
const tokens = question.match(/[A-Za-z_$][\w$]{2,}/g) ?? [];
if (tokens.length === 0) return [];                 // 中文问题/无标识符 → 空，走语义检索

const hits = await this.prisma.codeSymbol.findMany({
  where: {
    symbolName: { in: tokens },                      // 标识符精确匹配（有索引）
    document: { knowledgeBase: { ownerId: userId, … } },  // 归属过滤：只能搜自己的库
  },
  …
  take: 10,
});
return hits.map((h) => ({
  chunkId: `${h.documentId}:${h.symbolName}`,        // 符号的稳定键（去重用）
  content: h.body || h.signature,                    // 实现源码优先；interface 等无 body 退签名
  chunkIndex: h.startLine - 1,                       // 行号 → "段序号"（来源定位用）
  documentId: h.documentId,
  filename: h.filename,
  similarity: null,                                  // ★ 关键：非语义来源，没有相似度分
}));
```

两个设计点：

1. **正则 `/^[A-Za-z_$][\w$]{2,}$/` 是"符号名探测器"**：从问题里抠出至少 3 个字符的英文/下划线标识符（camelCase、snake_case 天然命中）。中文问题里夹杂的普通英文词即使被抠出来，也只有在 `code_symbols` 里**精确同名**才命中，普通词自然落空，不会误伤。
2. **`similarity: null` 是"高置信"的标记**。回顾第一章开头 `RetrievalSource` 的注释：相似度为 null 表示"来自非语义检索的关联片段，无向量相似度"。前端来源面板看到 null 会显示"相关"而不是百分比（`ChatSourcePanel.vue` 的 `similarityPercent`），导出 Markdown 时写成"知识图谱关联"（注释里沿用了早期叫法，实际是符号/全文等来源）。**语义分数可能撒谎（像 ≠ 是），但符号名精确命中不会**——所以它在编排里拥有最高优先级，第八节末尾的决策树会看到这一点。

### 8.2 A：文件档案——先定位文件，再定位段落

**问题**：中文泛化问法（"设置头像的代码在哪""登录是怎么做的"）不会点名符号，得靠语义。但此时语义检索在**全库的几万个文本块**里找"设置头像"，而一个大文件（比如 `Settings.vue`）会被切成几十块，其中大部分是**模板/样式**，真正含逻辑的 script 块可能只占一两块——**文件里 99% 的无关块在抢 Top-K**，命中率被稀释得很惨。

**做法**：入库时为每个文档额外生成一份"**档案**"（`file_profiles` 表）：文件名 + 用途摘要 + 符号清单，**单独向量化**。档案是"这个文件是干什么的"的浓缩描述，语义密度远高于任何单个文本块。检索分两步走：

1. `profileLookup()`：用问题向量在档案向量里找最近邻，**锁定最相关的 3 个文件**（语义上"设置头像"→ `Settings.vue` 的档案）；
2. 只在锁定的文件内部做常规混合检索——**检索范围从"全库几万块"缩到"3 个文件内的几十块"**。

```sql
-- profileLookup 的真实 SQL：查档案表，owner 过滤 + 余弦近邻，取最近 topDocs=3 个文档
SELECT p.document_id, d.filename
FROM file_profiles p
JOIN documents d    ON d.id = p.document_id
JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
WHERE p.embedding IS NOT NULL
  AND kb.owner_id = ${userId}
ORDER BY p.embedding <=> ${vecStr}::vector
LIMIT ${topDocs}
```

`file_profiles.embedding` 同样建了 HNSW 索引（迁移注释：`file_profiles_embedding_idx`）。**档案层还顺带解决了"文件边界被抹掉"的问题**：通用检索只认文本块、不认文件归属，问"哪个文件负责头像"时它回答不出一致文件名；档案命中则天然带着"这个文件"的边界。

### 8.3 A+C 联动：锁定文件后，直接把真实源码塞进去

档案只定位了文件，还没拿到内容。`symbolsForDocs()` 把 A 和 C 串起来：**档案命中哪些文件，就把这些文件里真实存在的符号实现（函数/类 body）拉出来**——这就是"设置头像的代码"的完整答案链：

```ts
// rag.service.ts symbolsForDocs()：先校验文档归属，再按 kind 排序取 body
const rows = await this.prisma.$queryRaw`
  SELECT s.document_id, s.filename, s.symbol_name, s.kind, s.body, s.start_line
  FROM code_symbols s
  WHERE s.document_id = ANY(${docLiteral}::text[])
    AND s.body <> ''
  ORDER BY
    CASE s.kind WHEN 'function' THEN 0 WHEN 'component' THEN 1 WHEN 'class' THEN 2 ELSE 3 END,
    s.start_line ASC
  LIMIT ${limit}                     -- 默认 8 条
`;
return rows.map((r) => ({
  chunkId: `${r.document_id}:${r.symbol_name}`,
  content: r.body.slice(0, 2000),    // 防超长函数撑爆上下文
  similarity: null,
  …
}));
```

这里有两个"为真实代码库量身定做"的细节：

- **`ORDER BY CASE kind …`：函数 > 组件 > 类 > 其他**。用户问代码时最想要"能运行的逻辑"（函数实现），其次是有 UI 的组件，最后才是类型声明。当 8 条限额装不下一个文件的所有符号时，这个排序保证**把最"实现型"的符号留到最后**。
- **`body.slice(0, 2000)`：每个符号 body 最多 2000 字符**。一个几千行的巨型函数直接喂进 Prompt 会撑爆预算，截断既是成本控制也是质量保障（模型对超长源码的理解力是递减的）。

**为什么中文问题也能拿到实现源码？** 这正是"档案(中文语义) → 符号(精确源码)"接力棒的设计：`profileLookup` 用中文向量定位 `Settings.vue`，`symbolsForDocs` 再用**代码本身**回答"这段逻辑怎么写"——模型看到的是函数体原文，**想编都编不了**。

---

## 九、HyDE 查询扩展：问题问不到，就用"答案的样子"去问

### 9.1 为什么：问句和文档的"表述距离"常常很远

向量检索有个隐藏假设：**问句的语义形态 ≈ 文档的语义形态**。但现实里两者常常差很远：

- 用户问："**怎么控制谁有权访问这个页面？**"（用户视角，口语化、问"控制"）
- 库里写的是："**路由守卫根据角色元数据判断跳转**"（文档视角，术语化、陈述"判断"）

问句向量（讲"控制访问"）和文档向量（讲"角色守卫判断"）在语义空间里可能隔得不近——即使文档**确实包含**答案。这不是 embedding 的错，是**查询与文档天然是两种文体**：一个是祈使/疑问，一个是陈述/定义。

HyDE（Hypothetical Document Embeddings，假设文档嵌入）的思路一句话：**别拿问题去检索，先让 LLM 把问题"翻译"成一段"如果知识库里有答案、内容大概长什么样"的陈述文本，再拿这段陈述文本去检索。**

**为什么有效？** 因为检索最理想的情况是"用文档的语言找文档"。假设文档是"文档体"（陈述、含术语、含步骤），它与库中真实文档的语义距离，通常**显著小于**问句与真实文档的距离——这是在用**文档-文档相似度**代替**问句-文档相似度**，前者可比性高得多。HyDE 本质是一次**文体翻译**，把"问句体"翻译成"文档体"。

### 9.2 怎么做：只在 0 结果时触发一次

`retrieveWithHyde()` 里 HyDE 是**最后一搏**，触发条件极其克制（完整决策树见第十一节）：常规混合检索返回 0 条（说明门控全滤或真没捞到），才调用 `hydeExpand()`：

```ts
private async hydeExpand(question: string, target: ChatTarget): Promise<string> {
  const res = await client.chat.completions.create({
    model: target.model,          // BYO 模型
    messages: [{
      role: 'system',
      content: '你是检索增强助手。用户给一个问题，请写一段 150 字以内的"假设的知识库文档内容"：用陈述句直接描述，如果知识库里存有该问题的答案，内容大概会怎么写（包含关键名词、概念、步骤）。只输出这段内容本身，不要任何解释、不要以"根据""假设"开头、不要提问句式。',
    }, { role: 'user', content: question }],
    max_tokens: 250,
    temperature: 0.3,             // 比改写略高：需要一点"展开叙述"的多样性
  });
  const text = res.choices[0]?.message?.content?.trim();
  return text && text.length >= 20 && text.length <= 500 ? text : question;  // 防御校验
}
```

提示词里全是"反提问句式"的约束（"不要以'根据''假设'开头、不要提问句式"）——因为假设文档必须长得**像入库文档**（陈述体），一旦 LLM 偷懒写回"问题重述"或"解答式问答"，HyDE 就退化为普通检索。防御校验要求长度在 20~500 字符之间，越界回退原问题。

**成本纪律**（`retrieveWithHyde` 注释原话）：HyDE 只在**0 结果**时触发**一次** LLM 调用，失败静默回退原问题。它不是为了提分而存在的锦上添花，而是为了"库里有答案但常规检索没够着"这一种情况准备的救生索——成本上完全可控。

```ts
if (!this.hydeEnabled) return sources;        // HYDE_ENABLED 默认 true，可 .env 关掉
const hydeQuery = await this.hydeExpand(query, target);
if (hydeQuery === query) return sources;      // 扩写失败/无变化 → 不重检
const retry = await this.ragService.retrieve(userId, hydeQuery, kbScope, 5);
if (retry.length > 0) {
  this.logger.log(`会话 ${sessionId} HyDE 兜底命中 ${retry.length} 条（原检索 0 条，扩写后命中）`);
}
return retry;
```

注意 HyDE 扩写后走的**仍是 `retrieve()` 全流程**（向量 + 关键词 + 重排 + 门控），不是放宽门控再检——**它赌的是"换一种文体去检索能捞到"，而不是"降低标准去捞"**。门控的门槛在任何一次检索里都不会松动。

---

## 十、P0 全文模式与"无资料兜底"：回答的分寸

### 10.1 P0 全文模式：文档少时，"不检索"反而是最优检索

检索永远在"给片段"，而有些任务**需要看完整文档**：逐行解析一段代码、总结整篇文档、对比两个文件的差异。片段化喂给模型，它必然答不全——**不是模型不行，是输入就不完整**。

所以 `askAndStream` 的最外层分流（第 05 章会详讲）是：**绑定了明确知识库时，先看总量**——如果绑定库的全部文本 ≤ `FULLTEXT_MAX_CHARS`（默认 40000 字符，约等于安全落在绝大多数模型的上下文里），就**干脆不走检索，把整库文本按文档分组全文喂给模型**。这就是为什么 `retrievalMode` 有三个值：`'fulltext' | 'retrieval' | 'none'`。

`rag.service.ts` 的 `loadFulltext()` 有个很实在的优化——**先算总量、超了就空手而归**，不白拉全量文本：

```sql
-- 只统计"叶子块"的总字符数（parent_id IS NULL 的容器父块不计，避免重复计数）
SELECT COALESCE(SUM(LENGTH(c.content)), 0)::int AS total
FROM chunks c
JOIN documents d ON d.id = c.document_id
WHERE d.knowledge_base_id = ANY(${kbLiteral}::text[])
  AND c.parent_id IS NULL
```

总量 ≤ 40000 才真正 SELECT 全部叶子块，交给纯函数 `aggregateFulltext()` 按 `(document_id, chunk_index)` 聚合成"每文档一条全文"。聚合结果的 `chunkIndex` 统一置 `-1`、`similarity` 置 `null`——**标记"这是全文块而不是第 N 段"**，Prompt 组装时据此显示"（文档《xxx》全文）"而不是"第 N 段"。

`aggregateFulltext` 被拆成独立导出函数、输入输出都是纯数据结构——注释明说"便于单测"（`rag-aggregate.spec.ts`）。**把"会变的部分"（SQL/IO）和"不变的部分"（聚合算法）分开，是这段代码值得模仿的结构。**

### 10.2 无资料兜底：诚实披露的三层防线

现在处理全书最微妙的一个产品决策：**门控全滤 / 库里真没有 / 没绑知识库，用户还是问了，怎么回？**

先看行业里两种糟糕的做法：

- **硬拒**："未在知识库中找到相关内容，无法回答。"——过于死板，用户明明在跟一个 AI 对话，它却假装自己只能查资料。
- **硬编**：没资料也照答不误，且**不告诉用户这答案没有出处**——这就是"带引用的幻觉"。

本项目的答案在两者之间，靠**三道防线**维持诚实：

**防线一（Prompt 层）**：`buildPrompt()` 在"使用知识库但 0 资料"时，向系统提示词注入两句话（`chat.service.ts`）：

```
本次未检索到任何知识库与网络资料：你可以基于自身知识回答，
但必须在回答开头明确标注"（未检索到知识库资料，以下为模型自身知识）"。
严禁编造来源编号或假装引用了资料。
```

关键词是**允许答、必须标**：模型有自身知识，可以继续提供帮助（可用性），但**必须在开头声明这回答没有资料支撑，且严禁编造 `[来源N]`**。注意系统提示词会随模式切换（知识库/纯对话+联网/纯对话），每种模式都有对应的引用纪律。

**防线二（前端层）**：即使模型忘了标注，前端还会兜底提示。`ChatMessageItem.vue` 对"使用了知识库、但这条回答 0 引用"的助手消息渲染一个虚线框：

```
⚠️ 未检索到知识库资料，以上回答基于模型自身知识（可在知识库补充相关文档后重问）
```

**双保险披露**：模型口头标注一次，UI 视觉再标一次。后端说"你可以答但必须注明"，前端说"我替你把'没资料'这件事钉在屏幕上"——用户永远分得清"有出处的回答"和"模型自由发挥"。

**防线三（引用纪律）**：有资料时系统提示词写的是"如果【参考资料】中没有相关信息，请明确说明'未找到相关内容'，不要编造"——**即使检索到了资料，资料里没有的也不许编**。这条规则独立于门控，是回答内容的最后闸门。

**这个"宁缺毋滥 + 诚实披露"的组合，就是第六章门控的意义所在**：门控把不可靠的资料挡在门外，兜底策略保证"门外"不是深渊，而是一条明码标价的"自身知识"通道。面试时能把这个分寸讲清楚（为什么不全拒、为什么不硬编、披露做在哪几层），比背十个算法名词都加分。

---

## 十一、最终检索编排：一条检索请求的完整决策树

把本章所有部件拼起来。注意编排分**两层**：

- **外层（`askAndStream`，chat.service）**：决定"全文模式 or 检索模式 or 不检索"，以及"要不要并行联网"；
- **内层（`retrieveWithHyde`，chat.service）**：决定"符号？档案？锁定文件？宽召回？HyDE？"。

### 11.1 外层：全文 or 检索

```
askAndStream（问一句话）
│
├─ useKnowledgeBase = false（纯对话模式）？ ──────────────→ 不检索知识库（mode: none）
│
├─ 问题没有文字（只发图片）？ ────────────────────────────→ 不检索（空查询检索无意义，且空嵌入会报错）
│
└─ 绑定了明确知识库（kbIds 非空）？
      │
      ├─ 是 → loadFulltext 统计总量
      │        ├─ 总量 ≤ FULLTEXT_MAX_CHARS(40000) → ★P0 全文模式（mode: fulltext）
      │        └─ 总量 > 40000 → 进入 retrieveWithHyde（mode: retrieval）
      │
      └─ 否（0 个绑定 = 检索该用户全部知识库，范围不可控，不做全文）
                → 进入 retrieveWithHyde（mode: retrieval）
│
└─ 若开联网：webSearchService.search(searchQuery) 与上面【并行】执行
```

### 11.2 内层：retrieveWithHyde 的优先级链

```
retrieveWithHyde(query)
│
│  ① C 符号命中（symbolLookup）
│      问题含库中符号名？ ────────── 是 → 直接返回符号实现源码（similarity=null，最高置信）
│      无 → ↓
│
│  ② A 档案锁定（profileLookup，语义定位文件）
│      问题向量 → 档案表 HNSW 近邻 → 锁定最多 3 个文件
│      没锁到 → ↓（跳到 ⑤，范围 = 全库）
│      锁到 → ↓
│
│  ③ A+C 联动（symbolsForDocs）
│      锁定文件里有实现型符号（function/component…）？
│          是 → 注入符号源码（最多 8 条）；文件内混合检索片段补足到 8 → 返回
│          否 → ↓
│
│  ④ 文件内混合检索（retrieve，docIds=锁定文件）
│      有结果 → 返回
│      0 结果 → ↓
│
│  ⑤ 宽召回（仅当有档案锁定时）：放宽到全库再检一次（问的是跨文件概念时有用）
│      有结果 → 返回
│      0 结果 → ↓
│
│  ⑥ HyDE 假设文档（开关 HYDE_ENABLED，默认开）
│      原问题检索 0 条 → LLM 扩写成"假设文档"陈述 → 全库重检
│      命中 → 返回；仍 0 条 → 返回空（进入 10.2 的诚实披露兜底）
```

把两层叠起来，一条"设置头像的代码在哪里"的请求完整走一遍：

```
用户 → ChatService.askAndStream
  → useKnowledgeBase=true，绑定了库，但库里不止 40000 字符 → 检索模式
  → 多轮改写？第一问无历史，跳过
  → retrieveWithHyde("设置头像的代码在哪里")
      → ① symbolLookup：无英文符号 → 空
      → ② profileLookup：档案向量近邻 → Settings.vue、UserProfile.vue …（锁 3 个文件）
      → ③ symbolsForDocs：Settings.vue 里抠出 updateAvatar()/handleAvatarChange()… 注入
           + retrieve(docIds) 的语义片段补充到 8 条 → 返回
  → writer('sources', { kb: [...8 条], web: [], mode: 'retrieval' })   ← 用户先看到来源
  → buildPrompt：用户原问题 + 8 条真实源码 + 引用纪律 → DeepSeek 流式回答
```

**为什么把符号/档案放在混合检索前面？** 因为它们命中时的**置信度更高、成本更低**（符号命中是数据库精确匹配，档案命中只扫一个 HNSW 索引，都没有交叉编码器调用），而且一旦命中就**不再需要**昂贵的全流程。排列顺序本质是"**先走便宜的精确路，再走贵的模糊路**"——这跟两阶段检索是同一条成本哲学在编排层的延伸。

### 11.3 各路径产物速查表

| 路径 | 触发 | 产物特征 | 成本量级 |
|---|---|---|---|
| P0 全文 | 绑定库 & 总量 ≤ 40000 字符 | 每文档一条全文，chunkIndex=-1，similarity=null | 一次 SUM + 一次 SELECT |
| C 符号 | 问题含符号名 | 符号实现源码，similarity=null | 一次 Prisma 精确查询，≈0 |
| A+C 联动 | 档案锁到有代码的文件 | 符号源码 + 片段，最多 8 条 | 一次 HNSW + 一次符号查询 + 文件内检索 |
| 常规混合 | 兜底 | 5 条，门控后 similarity ≥ 阈值 | 两路 SQL + 一次 rerank API |
| HyDE | 常规检索 0 条 | 同上，但查询被扩写过 | 多一次 LLM 小调用 |
| 空 | 全部失败 | 无来源 → 10.2 诚实披露兜底 | 0 |

---

## 十二、动手实验

> 先决条件：项目在本机跑通（第 00 章步骤），`apps/server/.env`（或你部署时使用的 .env，参考仓库根目录 `.env.example`）里配置了 `SILICONFLOW_API_KEY` 与 `SILICONFLOW_RERANK_MODEL`——**注意：重排与门控只有在配置了重排服务时才生效**，没配 key 时 `RerankService.enabled=false`，检索会静默降级为 RRF 直出，`RERANK_MIN_SCORE` 不会起作用。

### 实验 A：把 RERANK_MIN_SCORE 调到 0.5，观察"够不着就不给"

1. 打开 .env，把 `RERANK_MIN_SCORE=0.1` 改成 `RERANK_MIN_SCORE=0.5`，重启后端；
2. 挑一个**冷门问题**——你的知识库里明确没有的内容。比如知识库全是代码文档时，问"火星上种土豆需要几步"；或者问一个库里文档**提及但只是顺带一提**的术语；
3. 观察三种现象：
   - 后端日志出现 `两阶段检索: 召回 15 条 → 重排后全部低于相关性阈值 0.5，判定无相关内容`（`rag.service.ts` 里那行 logger）；
   - 回答开头出现"（未检索到知识库资料，以下为模型自身知识）"；
   - 回答下方的来源区为空，并出现 `⚠️ 未检索到知识库资料，以上回答基于模型自身知识` 的虚线提示框；
4. 再问一个库里**确有**的问题（如"rrfMerge 怎么实现的"），对比：0.5 门槛下连真正相关但重排分没到 0.5 的片段也会被滤掉——感受"门控过严"的副作用；
5. 改回 `0.1`，重启。**理解闭环**：阈值不是越大越好，0.1 的默认值是"bge-reranker 分数两极分化"这一事实下的经验最优；调阈值前先搞清楚重排分数的分布。

### 实验 B：用 psql 直接跑一条 pgvector 查询

1. 连接数据库（连接参数见 .env）：

```bash
psql -h localhost -U kbuser -d knowledge_base
```

2. 先确认表与索引存在：

```sql
\dt chunks
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'chunks';
-- 应看到 chunks_embedding_idx（hnsw, vector_cosine_ops）与 chunks_content_trgm_idx（gin）
```

3. 自举实验：拿库里**某一块的真实向量**当查询向量，检索"和它最像的块"——这是验证整条向量链（embedding 列 + HNSW 索引 + `<=>` 算子）能否工作的最简方式：

```sql
-- 先挑一个 chunk 当查询锚点（随便取一个库里存在的 id）
SELECT id FROM chunks WHERE embedding IS NOT NULL LIMIT 1;

-- 用它的 embedding 作查询向量，复刻 rag.service.ts 的检索 SQL：
WITH q AS (
  SELECT embedding FROM chunks WHERE id = '<上面查到的 id>'
)
SELECT d.filename,
       c.chunk_index,
       1 - (c.embedding <=> q.embedding) AS similarity
FROM chunks c
JOIN documents d ON d.id = c.document_id
CROSS JOIN q
WHERE c.embedding IS NOT NULL
  AND d.knowledge_base_id = '<你的知识库 id>'
  AND 1 - (c.embedding <=> q.embedding) >= 0.35      -- 复刻 MIN_SIMILARITY 门槛
ORDER BY c.embedding <=> q.embedding
LIMIT 15;
```

预期：第 1 名就是锚点自己（相似度 = 1），其余是同文档邻近块——这验证了"余弦相似度 1 - 距离"的换算、以及阈值过滤的行为。

4. 看执行计划，理解 HNSW 的近似扫描：

```sql
EXPLAIN ANALYZE
SELECT d.filename, 1 - (c.embedding <=> (SELECT embedding FROM chunks WHERE id = '<chunk id>')) AS sim
FROM chunks c JOIN documents d ON d.id = c.document_id
WHERE c.embedding IS NOT NULL
ORDER BY c.embedding <=> (SELECT embedding FROM chunks WHERE id = '<chunk id>')
LIMIT 15;
```

应出现 `Index Scan using chunks_embedding_idx`（而不是 `Seq Scan`）。可以再跑一条 **去掉** embedding 过滤条件的对照，感受"没有向量索引时全库扫描"的代价差异。

5. 顺带验证关键词路的 `%` 与 `similarity()`：

```sql
SELECT d.filename, c.chunk_index, similarity(c.content, 'rrfMerge')
FROM chunks c JOIN documents d ON d.id = c.document_id
WHERE c.content % 'rrfMerge'
ORDER BY similarity(c.content, 'rrfMerge') DESC
LIMIT 15;
```

---

## 本章自测

1. 为什么不能把整个知识库塞给模型？从成本、上下文、准确性、可溯源性四个角度各说一点。（🎯 面试必背）
2. 向量检索 SQL 里 `1 - (embedding <=> query)` 是在算什么？`MIN_SIMILARITY=0.35` 为什么只拦向量路、不拦关键词路？
3. 为什么 RRF 只用排名不用分数？举例说明"两路都排中游"的片段为什么可能赢过"一路第一"的片段。（🎯 面试必背）
4. 交叉编码器重排为什么比双塔检索准、又为什么只能用在少量候选上？本项目"粗召回 15 → 精排 → 取 5"的完整数字链路是什么？
5. 查询改写和 HyDE 都是"检索前调一下查询"，它们的区别是什么？改写后的查询会不会改变模型看到的用户问题？
6. 符号检索（C）和档案检索（A）分别解决代码问答的什么问题？`similarity: null` 在 UI 上、在 Prompt 里分别代表什么含义？

---

## 本章小结

你现在应该能完整画出这条流水线：**问题进来 → （多轮时先改写）→ 符号命中？没有就档案锁定 → 向量+关键词双路并行召回（各 15 条）→ RRF 只看排名融合 → bge-reranker 交叉编码器精排 → 相关性门控（两道门槛）→ 取 5 条 → 还是空的就 HyDE 再搏一次 → 仍空则全文模式或诚实披露兜底**。整章反复出现两条设计主线：**把贵的（精排/LLM 调用）用在最少数、最关键的时刻**，以及**宁可诚实地说"没有"，也不让不可靠的资料冒充答案**。第 05 章，我们将顺着 `askAndStream` 往下走，看这 5 段资料如何与 Prompt 组装、如何被流式地"吐"成一条回答，以及前端如何把它流畅地画出来。
