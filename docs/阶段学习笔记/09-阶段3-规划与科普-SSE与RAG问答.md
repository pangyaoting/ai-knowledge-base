# 阶段 3 规划与科普：RAG 问答核心（SSE 流式输出）

> 这是项目最核心的阶段，也是面试官最看重、最会深挖的部分。
> 做完这一阶段：用户能在知识库上提问，系统**检索最相关的资料 → 组装 Prompt → DeepSeek 流式回答（逐字显示）→ 标注引用来源**。
> 预计 3-4 周。AI 功能强制用户自带 Key（BYO），未绑定则 SSE 发 error 提示；DEEPSEEK_API_KEY 无代码引用。

> **状态标注**：本规划已于 2026-08 阶段 3 全部落地，随后演进出混合检索/重排/联网/BYO 等，
> 现状以 docs/10、11、12、16、20、27 及代码为准。

---

## 1. 先讲透：SSE 到底是什么，为什么选它不选 WebSocket

### 1.1 问题：为什么 AI 回答不能等全部生成完再返回？

DeepSeek 生成一段 500 字回答需要 5-15 秒。如果等全部生成完一次性返回：

- 用户盯着空白屏幕 10 秒 → 体验极差，以为卡死了
- 中间不能中断（想停停不下来，token 照样扣）

所以要**流式输出**：模型生成一个字，服务器就推一个字，用户像看打字机一样看到回答逐渐出现。

### 1.2 SSE vs WebSocket 对比（面试必问）

| 维度 | SSE（Server-Sent Events） | WebSocket |
|------|--------------------------|-----------|
| 方向 | **服务器→客户端单向** | 双向 |
| 协议 | 基于普通 HTTP（`text/event-stream`） | 独立协议（ws://） |
| 断线重连 | **浏览器自动重连**，内置 | 要自己实现 |
| 复杂度 | 极低（就是 HTTP 长连接） | 高（握手、心跳、状态管理） |
| 适用场景 | 推送、流式输出 | 聊天室、游戏、双向实时 |
| 代理兼容 | 好（Nginx 关 buffering 就行） | 需要特殊配置 |

**AI 流式回答的场景是"服务器单向吐数据、客户端只接收"，SSE 是天然匹配**：不用双向，不需要 WebSocket 的复杂度，浏览器自动重连，Nginx 一行配置（`proxy_buffering off`，我们 deploy/nginx.conf 早就写好了）。

**面试一句话**："流式输出我选了 SSE 而不是 WebSocket。SSE 基于 HTTP 单向下行，正好匹配'模型逐字生成、客户端只接收'的场景；浏览器原生支持断线自动重连；穿透 Nginx 只需关闭缓冲。WebSocket 是双向协议，这里用不上它的能力却要付出心跳和状态管理的复杂度。"

### 1.3 SSE 协议长什么样

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

data: {"event":"sources","data":[...]}

data: {"event":"delta","data":{"content":"你"}}

data: {"event":"delta","data":{"content":"好"}}

data: {"event":"done","data":{}}
```

每个事件是 `data: JSON\n\n`（两个换行分隔事件）。前端用 `@microsoft/fetch-event-source` 解析（它支持 POST + headers + AbortController，比原生 EventSource 强——EventSource 只支持 GET）。

---

## 2. RAG 问答的完整链路（后端视角）

```
用户提问 "Vue3 响应式原理是什么？"
        ↓
① 检索：把问题向量化（bge-m3），在知识库里找最相似的 Top-5 chunk
        ↓
② 组装 Prompt：系统提示词 + 检索到的资料 + 历史对话 + 用户问题
        ↓
③ 调 DeepSeek（stream: true）→ 拿到流
        ↓
④ 后端把 DeepSeek 的流"原样转发"成 SSE 事件给前端
        ↓
⑤ 前端逐字渲染 + 显示引用来源
```

### 2.1 检索（Retrieval）—— 复用阶段 2 的成果

```sql
SELECT c.content, c.document_id, d.filename,
       1 - (c.embedding <=> '[问题向量]'::vector) AS similarity
FROM chunks c
JOIN documents d ON d.id = c.document_id
WHERE c.embedding IS NOT NULL
ORDER BY c.embedding <=> '[问题向量]'::vector
LIMIT 5
```

- `<=>` 是余弦距离算子（阶段 2 建 HNSW 索引时用的就是它）
- 如果会话指定了知识库，加 `AND knowledge_base_id = ?` 过滤
- **已演进（2026-08）**：检索不再是"只取 Top-5 余弦"——现为向量 + pg_trgm 关键词 + RRF 融合 + bge-reranker 两阶段精排 + 相关性门控 + 多轮查询改写

### 2.2 Prompt 组装（面试官必问"你怎么拼的"）

```
【系统提示词】
你是一个严谨的 AI 知识库问答助手。请仅根据提供的参考资料回答用户问题。
如果资料中没有相关信息，请明确说明"资料库中未找到相关内容"，不要编造。
回答中引用资料时请标注 [来源1]、[来源2] 等编号。

【参考资料】
[1]（来自文档《Vue3核心知识整理》）Vue3 的响应式系统基于 ES6 的 Proxy...
[2]（来自文档《Vue3核心知识整理》）ref 用于包装基本类型值...

【历史对话】（最多保留最近 3 轮，控制 token）
用户：...
助手：...

【用户问题】
Vue3 响应式原理是什么？
```

三个设计点：
1. **系统提示词**："仅根据资料回答 + 不知道就说不知道" → 抑制幻觉
2. **引用编号**：资料带 [1][2] 编号，模型回答时标注 → 前端显示"来源"（引用溯源）
3. **历史对话滑动窗口**：只带最近 3 轮，控制 token 成本（这是面试点："多轮对话我用滑动窗口管理上下文，避免无限增长烧 token"）
4. **已演进（2026-08）**：参考资料为知识库 + 联网双来源；无资料时不再要求"明说没有"，改为允许模型自身知识但必须披露"（未检索到知识库资料，以下为模型自身知识）"

### 2.3 DeepSeek 流式调用（openai SDK）

```ts
const stream = await this.client.chat.completions.create({
  model: 'deepseek-chat', // 注：现为 BYO——deepseek-chat 仅是默认示例名，实际模型由用户自带 Key 路由
  messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: question }],
  stream: true,
});
for await (const part of stream) {
  const delta = part.choices[0]?.delta?.content;
  if (delta) res.write(`data: ${JSON.stringify({ event: 'delta', data: { content: delta } })}\n\n`);
}
```

---

## 3. 数据模型设计

```prisma
model ChatSession {
  id          String   @id @default(uuid())
  ownerId     String   // 属于哪个用户（数据隔离）
  title       String   @default("新对话")
  knowledgeBaseId String?  // 可选：限定检索范围
  messages    ChatMessage[]
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model ChatMessage {
  id        String   @id @default(uuid())
  sessionId String
  role      String   // user / assistant
  content   String   // 完整内容（流式结束后落库）
  sources   Json?    // 引用来源数组
  createdAt DateTime @default(now())
}
```

**已演进（2026-08）**：`knowledgeBaseId` 单字段 → 多对多 `SessionKnowledgeBase` + `useKnowledgeBase` 开关
（迁移 `20260817160000_session_multi_kb`、`20260818110000_add_use_knowledge_base`），另加 `modelConfigId`、`reasoningEffort`。

**为什么消息流式结束后才落库**：流式中间态不写库（每写一次都是一次 IO），等回答完整后一次性存。刷新页面能从库里恢复历史。

## 4. API 设计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/chat/sessions | 我的会话列表 |
| POST | /api/chat/sessions | 新建会话 { title?, knowledgeBaseIds[], useKnowledgeBase?, modelConfigId?, seedMessages? } |
| PATCH | /api/chat/sessions/:id/knowledge-bases | 更新会话绑定的知识库 |
| PATCH | /api/chat/sessions/:id/model | 切换会话模型配置 |
| GET | /api/chat/sessions/:id/export | 导出会话（Markdown） |
| POST | /api/extract-file | 提取文件内容（不建库） |
| GET | /api/chat/sessions/:id/messages | 会话历史 |
| DELETE | /api/chat/sessions/:id | 删除会话 |
| POST | /api/chat/sessions/:id/messages | **提问 → SSE 流式回答** |

SSE 事件协议（前端按 event 分发）：

```
event: sources → 检索到的引用资料
event: delta   → 增量文本（逐字渲染用）
event: done    → 回答结束
event: error   → 出错信息
```

## 5. 本阶段验证标准

1. 后端：curl 发问题 → 看到 `data:` 流式事件逐条到达（不是一次性）
2. 引用：回答引用的内容确实来自上传的文档（相似度 Top-5 相关）
3. 前端：浏览器里逐字渲染 + 回答下面的"来源"可点击查看原文
4. 中止：点停止按钮，DeepSeek 请求被 abort，token 不再扣
5. 历史：刷新页面，对话还在（数据库持久化）

## 6. 面试亮点预埋

1. **SSE vs WebSocket 决策**（上面 1.2 节完整话术）
2. **引用溯源**："检索结果带文档和编号注入 Prompt，模型回答标注 [来源N]，前端可点击查看原文——这解决了 AI 回答'不可信'的问题"
3. **滑动窗口**："历史对话只保留最近 3 轮 + 检索资料拼接，控制单次请求 token 在合理范围"
4. **中止生成**："前端 AbortController 中断请求，后端监听断开事件 abort DeepSeek 流，不浪费 token"
5. **错误处理**："流中出错不会让连接挂死，而是发 error 事件优雅结束"
