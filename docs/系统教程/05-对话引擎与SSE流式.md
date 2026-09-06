# 05 · 对话引擎与 SSE 流式：一条回答是怎么流出来的

> **本章地图**
> - 学什么：为什么用 SSE 而非 WebSocket、`sources/delta/done/error` 事件协议、后端 OpenAI stream + `for await` + 客户端断开 abort、前端 `fetch-event-source` 消费、rAF 节流与渲染缓存、乐观渲染与失败回滚、停止生成的 AbortController 链路、多轮上下文管理、多图多文件与视觉路由、联网双来源与"未检索到资料"诚实披露、`translateLLMError` 错误翻译
> - 代码在哪：`apps/server/src/modules/chat/chat.controller.ts`（SSE 端点）、`apps/server/src/modules/chat/chat.service.ts`（`askAndStream` / `buildPrompt` / `translateLLMError`）、`apps/server/src/modules/chat/web-search.service.ts`（Tavily）、`apps/server/src/modules/chat/dto/ask.dto.ts`、`apps/web/src/api/chat.ts`（`askQuestion`）、`apps/web/src/views/Chat.vue`（`sendPayload`）、`apps/web/src/components/chat/ChatMessageItem.vue` 与 `ChatSourcePanel.vue`
> - 动手实验：Network 面板逐帧看 SSE 事件流；F12 打断点看 rAF 节流；回答到一半点停止看 abort 链
> - 本章难度：★★（链路长但每段不难，建议开着 DevTools 读）

---

第 04 章结束时，5 段检索资料已经躺在 `kbSources` 里——重排、门控、HyDE 这些"阅读理解"全部完成。接下来发生的事——资料如何与 Prompt 组装、模型的回答如何一个 token 一个 token 地"流"回浏览器、前端又如何把它流畅画出来——就是本章的主线。

读本章请把问题从"系统怎么找到资料"换成"系统怎么把答案送出去"：

> 一次 `POST /chat/sessions/:id/messages`，响应要在几十秒里**持续吐出小段文字**；浏览器要**边收边画**；用户随时能**喊停**；出错还得**体面收场**。这不是一次普通 HTTP 请求能表达的。

它需要一套叫 **SSE（Server-Sent Events）** 的技术、一套**前后端约定的事件协议**，以及一整套围绕"长连接 + 流式状态"的工程细节。

---

## 一、全景：从检索结束到文字上屏

`chat.service.ts` 类顶部注释就写明了流程：**检索 → 组装 Prompt → DeepSeek 流式 → 通过 writer 输出 SSE 事件**。一条回答的完整时间线：

```
浏览器                               服务器(askAndStream)               大模型API
  │ POST /chat/sessions/:id/messages    │                                  │
  │ ───────────────────────────────────►│                                  │
  │                                     │ getSession 校验归属（404 早退）      │
  │                                     │ resolveForChat 解析 BYO 目标        │
  │                                     │ ① 取最近 3 轮历史（6 条）            │
  │                                     │ ② rewriteQuery 指代消解             │
  │                                     │ ③ 全文/检索分流 + (可选) 联网         │
  │ ◄─ data:{event:"sources",...} ──────│（检索完先发 sources，再开始生成）     │
  │                                     │ ④ 落库用户消息（含图片 data URL）     │
  │                                     │ ⑤ buildPrompt 组装 → 发起流式请求 ◄─►│
  │ ◄─ data:{event:"delta",...} × N ────│   for await 逐块转发 ◄──────────────│
  │ ◄─ data:{event:"done",...} ─────────│ ⑥ 落库助手消息+来源+token → ⑦ 标题    │
```

图上一眼能读出的四个设计：

1. **`sources` 先于第一个 `delta`**：检索完成、模型还没吐字，来源就先到前端；
2. **`delta` 是流的主体**：每个增量块包装成一个独立事件；
3. **`done` 是终态**：此时后端已完成落库，前端收到它才把"流式中的回答"转正为正式消息；
4. **用户消息在检索之后、生成之前落库**（④ 在 ⑥ 前）：检索结果和改写结果要等；但必须赶在生成前落库，否则生成中途崩溃这条提问就丢了。

本章就是把时间线上每一段的"为什么"和"怎么做"讲透。

---

## 二、为什么是 SSE，而不是 WebSocket

### 2.1 方向决定协议

一次问答的通信方向：客户端**只发一次请求**（问题 + 开关 + 图片），之后几十秒全是**服务器单向推**（sources、delta、done）——典型的**单向流（server push）**。

**类比**：SSE 像收音机——电台（服务器）单向播音，你只能听；WebSocket 像电话——两边随时能开口。RAG 问答的"讲话"几乎全在一个方向，用电话是杀鸡用牛刀。

| 维度 | 轮询 | SSE | WebSocket |
|---|---|---|---|
| 通信方向 | 一问一答 | **服务器→浏览器单向** | 全双工 |
| 开销 | 每分片一次 HTTP 往返 | 一条 HTTP 长连接 | 需 101 协议升级握手 |
| POST + 自定义 Header | 支持 | **支持**（就是普通 HTTP） | 支持 |
| 过 Nginx/负载均衡 | 无问题 | 兼容好（关缓冲即可） | 需配 `Upgrade`、粘性会话 |
| 断线重连 | 天然"新连接" | 规范内置自动重连 | 自己实现心跳/重连 |
| 实现调试成本 | 低但浪费 | 最低：服务端就是 `res.write`，DevTools 直接看 | 较高 |

结论：**流式回答是"服务器单向吐字"，天然匹配 SSE**；SSE 又是纯 HTTP，POST body、`Authorization` 头、Nginx 全兼容，调试时在 Network 里能像普通请求一样逐帧看。而"服务器要主动推送用户状态变化"（协同编辑、IM）才轮到 WebSocket。

### 2.2 SSE 也是 HTTP：四个响应头

SSE 没有魔法——它是一次**永不"结束"响应体的 HTTP 响应**，服务端按需追加文本块。区分 SSE 与普通响应的，是四个响应头（`chat.controller.ts` 的 `ask()`）：

```ts
@Post('sessions/:id/messages')
@HttpCode(HttpStatus.OK) // ★ SSE 流返回 200（NestJS 默认 POST 是 201，SSE 语义应为 200）
async ask(…, @Res() res: Response) {
  await this.chatService.getSession(userId, sessionId); // 先校验归属（此时还没写 SSE 头，
                                                        // 出错会被全局过滤器转成 JSON 错误）
  // 进入 SSE 模式
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 兼容 Nginx
  res.flushHeaders();
  …
}
```

- **`Content-Type: text/event-stream`**：告诉浏览器"这是 SSE"，按 SSE 帧格式解析；
- **`Cache-Control: no-cache`**：实时演播，绝不能被任何缓存层重放；
- **`Connection: keep-alive`**：显式要求连接别关；
- **`X-Accel-Buffering: no`**：给 Nginx 看的私有头（2.3）；
- `@HttpCode(200)`：POST 默认 201，但 SSE 语义是"成功建立且正在持续"，应为 200。

### 2.3 Nginx 必须关缓冲

部署时请求先打 Nginx 再反代到 NestJS。**Nginx 默认开 `proxy_buffering`**：把上游吐的响应攒进缓冲区，攒够 4~8KB 或等上游结束才转发。对 SSE 这是致命的——模型每吐 5 个字 Nginx 就"扣下"，用户看到回答**卡顿几秒后整段蹦出**。

`X-Accel-Buffering: no` 是 Nginx 官方支持的响应头：收到后本响应**逐块透传、不缓冲**（其他服务器不认识就忽略，无副作用）。**在代码里声明而非改 Nginx 配置**还有一个好处：它是"此端点需要流式"的自描述，以后换网关只要尊重它就不会踩坑。配套的 `res.flushHeaders()` 先把响应头立即刷给浏览器——SSE 语义是"头到达 = 连接建立"，不 flush 头会和首段 body 一起积压，首 token 被白白拉长。

### 2.4 手动 `@Res()` 而不是 NestJS 的 `@Sse()`（面试延伸）

本项目刻意用手动 `@Res()` + `res.write`，因为三个诉求 `@Sse()` 的封装都要绕：

```ts
res.setHeader('X-Accel-Buffering', 'no');      // ① 自定义头
res.flushHeaders();                             // ② 手动控制"头先出去"
res.on('close', () => abortController.abort()); // ③ 监听连接关闭
```

SSE 恰恰是"差一个头、差一个 flush 就完全坏掉"的协议，适合直白地全盘掌控。

---

## 三、SSE 事件协议：sources → delta × N → done

SSE 帧的最小格式是 `data: <一行 JSON>\n\n`，浏览器按空行切帧。但"data 里装什么、如何区分事件类型"是**协议设计**，由前后端约定。`apps/web/src/types/chat.ts` 里一行注释说明：

```ts
/** SSE 事件协议（后端按此格式推送） */
export interface SseEvent<T = unknown> {
  event: 'sources' | 'delta' | 'done' | 'error';
  data: T;
}
```

### 3.1 为什么事件类型装在 data 里，而非原生 `event:` 字段

SSE 原生支持命名事件（`event: sources\ndata: …`），但本项目所有帧都用匿名 message，类型写进 data JSON：

```ts
const write = (event: string, data: unknown) => {
  res.write(`data: ${JSON.stringify({ event, data })}\n\n`);
};
```

| | 原生 `event:` 字段 | 类型包进 data（本项目） |
|---|---|---|
| 服务端 | 每类事件拼不同帧头 | 一个 `write()` 统一处理 |
| 客户端 | 按事件名注册多个监听器 | `onmessage` 里一个 `switch` 分流 |
| 演进 | 加事件要两端同步改监听器 | data 里加字段即可，旧客户端忽略未知事件 |

单帧结构固定为 `{ event, data }`，让**服务端只有一种写帧代码、客户端只有一种解析路径**——协议越简单，越不容易出"事件名拼错导致前端静默丢消息"的错。

### 3.2 四类事件：时机、载荷与消费者

| 事件 | 发出时机（`askAndStream` 内位置） | data 载荷 | 前端处理 |
|---|---|---|---|
| `sources` | 检索（含联网）完成、生成开始前：`writer('sources', { kb, web, mode })` | `{ kb, web, mode: 'fulltext'\|'retrieval'\|'none' }` | 存进 `streamSources`，显示"已检索到 N 条，正在生成回答" |
| `delta` | 流式循环每吐一个增量：`writer('delta', { content: delta })` | `{ content }`（**只含增量**） | `pendingStream += delta`，rAF 节流渲染 |
| `done` | 助手消息落库、标题生成后：`writer('done', { messageId: undefined })` | `{ messageId: null }` | 流式内容转正为正式消息，`loadSessions()` 刷列表 |
| `error` | 未绑 Key 的提前返回；流中异常被 controller catch | `{ message }`（已中文） | 错误条 + 重试/放弃 |

**为什么 `done` 的 `messageId` 是 `undefined`？** 直觉是"后端把落库 id 还给前端做替换"。但前端全程没把流式消息同步回服务器（第七节乐观渲染），本地消息 id 是 `local-` 临时值，拿到数据库 id 反而要多做一次 id 协调。内容两端各一份、以刷新后重拉为准，`done` 就只是**纯信号**："到此为止，把流式内容转正"。

### 3.3 为什么"检索结果先于正文"

`Chat.vue` 流式期间的 UI 顺序是：思考蓝条 + 计时器 → 收到 `sources` 后显示"已检索到 N 条，正在生成回答" → 第一个 `delta` 到达才开始逐字出正文。这是刻意设计，两个理由：

1. **把检索耗时藏进"等首 token"时段**。模型 prefill（读 Prompt 出第一字）本身要几秒，检索（两路 SQL + 重排 + 可能 HyDE）也要一两秒。SSE 连接在请求发出时就建立，检索一结束**立刻**推 `sources`——用户看到"已检索到 N 条"就知道系统在干活，不是卡死了。
2. **来源是"信任预告"**。RAG 产品最反直觉的一点是：**答案未生成，证据先到**——"下面这个回答不是我编的，依据已摆在这里。"这正是第 04 章强调的可溯源性在交互层的落地。

### 3.4 线上报文长什么样

DevTools 里这条请求的响应体持续追加，形如（空行即 `\n\n` 帧分隔）：

```
data: {"event":"sources","data":{"kb":[{"chunkId":"…","filename":"…","similarity":0.91,…}],"web":[],"mode":"retrieval"}}

data: {"event":"delta","data":{"content":"好的，"}}

data: {"event":"delta","data":{"content":"先看 Chat.vue 的 sendPayload…"}}

…
data: {"event":"done","data":{"messageId":null}}
```

注意事件名在 data 里（`"event":"sources"`），帧本身没有 `event:` 字段——3.1 的自定义协议的实相。

---

## 四、后端流式实现：askAndStream 的一次完整旅程

### 4.1 解耦的关键：`StreamWriter` 回调

看 `chat.service.ts` 顶部：

```ts
interface StreamWriter {
  (event: 'sources' | 'delta' | 'done' | 'error', data: unknown): void;
}

async askAndStream(
  userId: string, sessionId: string, question: string, useWebSearch: boolean,
  writer: StreamWriter,   // ★ 只管"发事件"，不碰 HTTP
  signal: AbortSignal,    // ★ 只管"听中止"，不碰连接
  imageDataUrls?: string[],
) { … }
```

**Service 里没有任何 `res`/Express 类型**，只认识两个抽象：`writer` 与 `signal`。这是"业务编排"与"传输细节"的解耦：controller 把 `writer` 实现成 `res.write`、把 `signal` 实现成 `res.on('close')→abort()`；service 可脱离 HTTP 单测（传收集事件的假 writer）；将来换传输（gRPC 流、WebSocket）service 一行不用动。

### 4.2 controller：先校验，再进流

```ts
@Post('sessions/:id/messages')
@HttpCode(HttpStatus.OK)
async ask(…, @Res() res: Response) {
  await this.chatService.getSession(userId, sessionId);   // SSE 头之前出错 → JSON 错误
  // …四个 SSE 头 + flushHeaders（见 2.2）…
  const write = (event: string, data: unknown) => {
    res.write(`data: ${JSON.stringify({ event, data })}\n\n`);
  };
  try {
    // 客户端断开时 abort（由 ChatService 里监听 signal）
    const abortController = new AbortController();
    res.on('close', () => abortController.abort());
    await this.chatService.askAndStream(
      userId, sessionId,
      dto.content ?? '', dto.useWebSearch ?? false,
      (event, data) => write(event, data),
      abortController.signal,
      dto.imageDataUrls ?? (dto.imageDataUrl ? [dto.imageDataUrl] : undefined), // 多图优先，兼容单图旧客户端
    );
    res.end();
  } catch (err) {
    // 流中出错：发 error 事件优雅结束，不把连接挂死
    let message = (err as Error).message || '服务器错误';
    if (/Expected content-type|not a VLM|Model does not exist|invalid api key|insufficient.*balance/i.test(message)) {
      message = '大模型接口返回异常：可能是模型不支持图片、模型名与平台不匹配、Key 无效或余额不足。请检查「模型配置」后重试。';
    }
    write('error', { message });
    res.end();
  }
}
```

四个关键点：

1. **校验分两段、错误形态不同**。`getSession` 在写 SSE 头**之前**——会话不存在（404）走全局过滤器，返回**普通 JSON**；而进入 SSE 后的一切错误都无法再用 JSON 表达（响应头已是 `text/event-stream`），只能发 `error` 事件——这就是协议里 `error` 的由来。
2. **`res.on('close', …)` 把"连接断开"变成 AbortSignal**（4.5 详述）。
3. **catch 兜底再翻译一次**：service 翻译过的错误原样带 message；这个正则拦截漏网的英文，保证 `error` 事件里永远是中文。
4. **`write('error', …)` 后 `res.end()`**：错误是终态，不 end 浏览器会一直等下一帧、错误提示出不来、连接还挂死占资源。

### 4.3 主链路 ①～⑦：逐段拆解

**开头：归属校验 + 参数兜底 + 模型目标**

```ts
const session = await this.getSession(userId, sessionId);   // 归属校验：查不到=404
const images = (imageDataUrls ?? []).filter((u) => !!u && u.length > 0);
// 只发图片（不带文字）也允许：content 为空但有图片
if (!(question ?? '').trim() && images.length === 0) {
  throw new BadRequestException('请填写问题或粘贴/上传图片');
}
const useKnowledgeBase = session.useKnowledgeBase !== false; // 兼容旧数据（列默认 true）
const kbIds = session.knowledgeBases.map((k) => k.knowledgeBaseId);

// 模型目标（BYO 强依赖）：会话绑定配置 → 用户默认配置 → 都没有则提示先绑定 Key
const target =
  (await this.modelConfigService.resolveForChat(userId, session.modelConfigId, session.model))
  ?? (await this.modelConfigService.resolveDefaultForUser(userId));
if (!target) {
  writer('error', {   // ★ 事件而非抛异常：没绑 Key 是业务常态，不是服务器故障
    message: '使用前请先在「模型配置」里绑定你自己的大模型 API Key（设置 → 模型配置，或对话页右上角「模型」入口）。绑定后本会话所有 AI 消耗都由你的 Key 承担。',
  });
  return;
}
```

BYO（Bring Your Own Key）贯穿对话链路：**系统不提供兜底模型**，目标解析是"会话绑定 → 用户默认"两级。没绑 Key 时用 `writer('error')` + 前端提示条，比抛 500 友好得多（此时 SSE 头已发出，也抛不了 JSON 错误了）。

**视觉自动路由**（第十节详述）：`images.length > 0` 且当前模型不含视觉关键字时，用 `resolveVisionForUser` 找用户配置里的视觉模型，**只替换这一次调用的 target**，不改会话绑定。

**① 历史：先倒序取最近 N 条，再反转回正序**

```ts
const history = await this.prisma.chatMessage.findMany({
  where: { sessionId },
  orderBy: { createdAt: 'desc' },
  take: HISTORY_ROUNDS,      // = 6（最近 3 轮，见第九节）
});
history.reverse();
```

源码注释点破坑：**不能 `orderBy: asc + take`**——那会取到"最早的 N 条"，上下文越聊越旧。必须先 desc 拿最新 6 条再反转。

**② 查询改写**：有历史且需要检索（`useKnowledgeBase || useWebSearch`）时才调 `rewriteQuery`，把"它怎么实现的"改写成独立完整的问法；改写只影响检索，回答仍用用户原问题（第 04 章 §7.3）。

**③ 检索 + 联网，完成后立刻发 `sources`**（第三节"来源先行"的落地）：

```ts
const kbScope = kbIds.length ? kbIds : undefined;
const canRetrieve = question.trim().length > 0;   // 只发图片（无文字）时不检索
let kbSources: RetrievalSource[] = [];
let retrievalMode: 'fulltext' | 'retrieval' | 'none' = 'none';
if (useKnowledgeBase && canRetrieve) {
  if (kbIds.length) {
    // 绑定明确知识库：先试全文（P0，04 章 §10.1）→ 超阈值走 retrieveWithHyde
    const ft = await this.ragService.loadFulltext(userId, kbIds, this.fulltextMaxChars);
    if (ft.sources.length > 0) { kbSources = ft.sources; retrievalMode = 'fulltext'; }
    else {
      kbSources = await this.retrieveWithHyde(userId, searchQuery, kbScope, target, sessionId);
      retrievalMode = 'retrieval';
    }
  } else {
    // 未绑定知识库 = 检索该用户全部知识库（范围不可控，不做全文）
    kbSources = await this.retrieveWithHyde(userId, searchQuery, kbScope, target, sessionId);
    retrievalMode = 'retrieval';
  }
}
const webSources = useWebSearch && canRetrieve ? await this.webSearchService.search(searchQuery) : [];
writer('sources', { kb: kbSources, web: webSources, mode: retrievalMode });
```

一个诚实观察（注释 vs 实现）：注释写着"全文/检索自动分流…联网搜索并行"，但实现是**顺序 await**——联网要等知识库检索整条链（含 HyDE 兜底）走完。两路只共用 `searchQuery`、互不依赖，想摊薄延迟可用 `Promise.all` 并行；目前是"可以优化但没优化"。读源码要留意这类"注释描述意图、实现留余地"的地方。

**④ 落库用户消息（含图片数组）**

```ts
const savedUserMsg = await this.prisma.chatMessage.create({
  data: {
    sessionId, role: 'user',
    content: sanitizeControlChars(question),   // ★ \u0000 清洗：PG text 禁止 NUL
    imageDataUrl: images[0] ?? null,           // 单图兼容字段存第一张
    imageDataUrls: images.length ? JSON.stringify(images) : null,
  },
});
```

`sanitizeControlChars` 不是洁癖：**PostgreSQL 的 text 禁止 NUL 字节**，粘贴自外部的文本可能夹带 `\u0000`，不洗直接写库会触发 `PG 22P05` 让请求崩掉。同一条纪律贯穿全链（检索片段、模型输出落库前都再洗一遍）。

**⑤ buildPrompt + ⑥ 流式生成 + ⑦ 落库**分别在 4.4 与第九~十一节展开。

### 4.4 流式调用 OpenAI：`stream: true` + `for await` 逐块转发

```ts
const answerClient = new OpenAI({ apiKey: target.apiKey, baseURL: target.baseURL });
const abortController = new AbortController();                 // ★ 内部控制器
const onAbort = () => abortController.abort();
signal.addEventListener('abort', onAbort, { once: true });     // 外部(客户端断开) → 内部

let answer = '';
// 流式 usage（stream_options.include_usage）：最后一个 chunk 携带本次请求的 token 用量
let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
try {
  const stream = await answerClient.chat.completions.create(
    {
      model: target.model,
      messages: [{ role: 'system', content: system }, ...messages],
      stream: true,
      stream_options: { include_usage: true },   // 数据看板的 Token 统计依赖它
      ...(session.reasoningEffort ? { reasoning_effort: session.reasoningEffort } : {}),
    },
    { signal: abortController.signal },          // 客户端断开时中止生成，不浪费 token
  );

  for await (const part of stream) {
    const delta = part.choices[0]?.delta?.content;
    if (delta) {
      answer += delta;                      // 本地累积（落库需要完整文本）
      writer('delta', { content: delta });  // ★ 增量转发：只发新吐的这点
    }
    if (part.usage) usage = part.usage;     // 流式结束时的 usage chunk
  }
} catch (err) { … } finally {
  signal.removeEventListener('abort', onAbort);
}
```

- **`stream: true`** 让 API 返回异步迭代器，SDK 底层处理流式请求与分片解码；
- **`for await`** 每次迭代拿到一个增量块，取 `part.choices[0].delta.content`（OpenAI 流式协议里新文字在 `delta` 而非 `message`），立刻转发；
- **`answer += delta` 双轨制**：事件只带增量，本地维护完整文本——增量是"传输形态"，全文是"存储形态"；
- **`stream_options.include_usage`**：让最后一个 chunk 携带 token 用量，落进消息的 `promptTokens` / `completionTokens`——数据看板的 Token 统计源头就在这里；
- **`reasoning_effort` 透传**：会话推理等级（low/high/max）只在支持的模型上生效。

### 4.5 客户端断开 → abort，不浪费 token

先想问题：**用户点停止或直接关浏览器，正在进行的流式请求怎么办？**

- 不处理：模型继续吐完整个回答，token 照扣（BYO = 扣用户的钱），吐完发现没人听；
- 处理：把"连接断了"翻译成"取消上游生成"。

实现是 controller 一行 + service 两行：

```ts
// controller：连接一关，触发 abort
res.on('close', () => abortController.abort());
// service：把外部 signal 桥接到 OpenAI 请求自己的 AbortController
const onAbort = () => abortController.abort();
signal.addEventListener('abort', onAbort, { once: true });
```

完整链条：**浏览器断开 fetch → Node 触发 `res` 的 `close` → controller 的 abort() → service 监听的 signal aborted → 内部 abortController.abort() → OpenAI SDK 向上游发取消**。终点是"上游停止计费生成"——省钱，也别让模型给没人的观众继续演。

异常分支怎么区分"主动断开"和"真出错"？

```ts
} catch (err) {
  // 客户端主动断开 → 静默停止，不扣后续 token
  if (abortController.signal.aborted) {
    this.logger.log(`会话 ${sessionId} 被客户端中止`);
    return;                     // ★ 静默 return：不落库、不发 error（没人听了）
  }
  // 模型调用失败 → 回滚刚落库的用户消息（防前端"重试"时重复落库，见第七节）
  await this.prisma.chatMessage
    .deleteMany({ where: { id: savedUserMsg.id, sessionId, role: 'user' } })
    .catch(() => undefined);
  const translated = this.translateLLMError(err, images.length > 0);
  throw translated;
}
```

判断依据是**内部 `abortController.signal.aborted`**：被 abort 抛的异常是 `AbortError`，不翻译、不回滚、不抛，直接 return。注意：**回滚的是"落库的用户消息"，不是流到一半的助手回答**——助手回答在流式结束前根本没落库；而用户消息在④已落库，模型调用失败时它就是"库里有、前端也有、但永远没回答"的半截记录，必须删（理由见第七节）。

### 4.6 成功收尾：⑦ 落库助手消息 + 自动标题 + done

```ts
// 流式结束：落库助手消息 + 引用来源（知识库 + 网络）+ Token 用量
const sourcesJson = JSON.parse(sanitizeControlChars(JSON.stringify({ kb: kbSources, web: webSources })));
await this.prisma.chatMessage.create({
  data: {
    sessionId, role: 'assistant',
    content: sanitizeControlChars(answer),
    sources: sourcesJson,                    // 来源与回答同库：刷新后来源还在
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
  },
});
// 第一条提问时自动生成会话标题
if (session.title === '新对话') {
  const title = question.replace(/\s+/g, '').slice(0, 20);   // 取问题前 20 字当标题
  await this.prisma.chatSession.update({ where: { id: sessionId }, data: { title: title || '新对话' } });
}
writer('done', { messageId: undefined });
```

三个看点：

1. **来源跟随助手消息落库**（`sources` Json 列）。`sources` 事件虽早发给前端，但库里它属于"这条回答"——刷新重拉后来源面板还在。落库前 `JSON.parse(sanitizeControlChars(JSON.stringify(...)))` 把对象转成纯 JSON（兼容各版本 Prisma 的 Json 类型，同时洗掉 NUL）。
2. **token 用量随消息存库**：来自流式最后一个 chunk 的 `usage`。
3. **标题是"提问前 20 个字"而非调 LLM 生成**：对第一问花一次模型调用太奢侈，截取问题免费又达意。前端 `onDone` 里 `loadSessions()` 刷新列表，正是为把新标题刷出来。

---

## 五、前端消费：为什么不能用原生 EventSource

后端吐得再好，前端收不下来也是白搭。收 SSE 的"正统"API 是 `EventSource`——但本项目用的是 **`@microsoft/fetch-event-source`**。

### 5.1 原生 `EventSource` 的三个死穴

| 需求 | 原生 `EventSource` | `fetch-event-source` |
|---|---|---|
| POST 发请求体（问题、图片 data URL） | ✗ 只支持 GET | ✓ `method: 'POST'` + `body` |
| 自定义 Header（`Authorization`） | ✗ 无法设置请求头 | ✓ 任意 headers |
| 可控中止（AbortController） | ✗ 只有 `close()` | ✓ 传 `signal`，对接 abort 链 |
| 断线行为 | 自动重连（这里反而是灾难，见 5.3） | `onerror` 里 `throw` 禁用重连 |

本项目鉴权走 **JWT：每请求必须带 `Authorization` 头**，提问是 **POST + JSON body**（问题可长达 40 万字符、带 9 张图 data URL）——原生 `EventSource` 两条都不满足，直接出局。`fetch-event-source` 本质是"用 fetch 实现 SSE 帧解析"：按 `\n\n` 切帧、处理跨 TCP 包的多字节 UTF-8 分片，再回调 `onmessage`。

### 5.2 `askQuestion` 逐段注释

```ts
export function askQuestion(sessionId, content, useWebSearch, signal, callbacks, imageDataUrls?): Promise<void> {
  return fetchEventSource(`/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('accessToken')}`,  // ★ JWT
    },
    body: JSON.stringify({ content, useWebSearch, ...(imageDataUrls?.length ? { imageDataUrls } : {}) }),
    signal,                                   // ★ 与停止按钮/离页共用
    onmessage(ev) {
      // 事件类型在后端写进了 data 的 JSON 里：{ event, data }
      const msg = JSON.parse(ev.data) as { event: string; data: unknown };
      switch (msg.event) {
        case 'sources': callbacks.onSources?.(msg.data as ChatSources); break;
        case 'delta':   callbacks.onDelta?.((msg.data as { content: string }).content); break;
        case 'done':    callbacks.onDone?.(); break;
        case 'error':   callbacks.onError?.((msg.data as { message: string }).message); break;
      }
    },
    onerror(err) {
      // 用户主动中止不算错误
      if (!signal.aborted) {
        const raw = err instanceof Error ? err.message : '连接中断';
        // 响应不是 SSE（如 400 JSON 校验错误）时抛 content-type 错，翻译成中文
        //（真正的错误信息后端会通过 SSE error 事件送达）
        callbacks.onError?.(
          /Expected content-type/i.test(raw)
            ? '请求未正常建立（响应格式异常）：请确认问题内容或模型配置（只发图片时需配置视觉模型）'
            : raw,
        );
      }
      throw err; // ★ 抛出以终止重连（SSE 默认会自动重连，这里不需要）
    },
  });
}
```

三个设计点：

1. **`onmessage` 里只有一个 `switch`**：后端发什么事件、前端调哪个回调，类型收口在 `AskCallbacks` 上，`Chat.vue` 只需提供四个回调。
2. **`onerror` 先查 `signal.aborted`**：用户主动停止会触发 error 回调，那是"计划内中断"不是错误，不该弹错误条（8.2）。
3. **`/Expected content-type/` 翻译**：后端在写 SSE 头之前抛的错误（DTO 400 / 会话 404）返回的是 JSON，`fetch-event-source` 读不懂就抛此错——真正的错误信息在 body 里它拿不到，只能翻译成笼统但可操作的中文提示。

### 5.3 为什么必须 `throw err` 终止重连

`EventSource` 规范内置**自动重连**。对聊天场景这是**双向灾难**：

- 断线发生在生成中途时，自动重连 = **重新发一次提问**：后端再检索、再落库、再调模型，用户看到回答从头再流一遍，历史里多一条重复的用户消息；
- 更糟的是后端断线时已 abort 原请求（4.5），重连的新请求是全新的第二次生成——**钱付了两份**。

所以 `onerror` 末尾的 `throw err` 是刻意的：让 fetch-event-source 认为"这次流不可恢复"，放弃重连。错误提示已通过 `onError` 送达，剩下交给用户（手动重试按钮，第七节）。

---

## 六、渲染性能三板斧：为什么长回答不卡

流式渲染的挑战是数学性的：假设每秒吐 30 个 token，一个 3000 字回答会触发几百次内容更新。如果每次都"全文重渲染"，必然卡顿。

### 6.1 第零问题：为什么不能"每个 delta 全量渲染 markdown"

流式区渲染（`Chat.vue` 模板）：`v-html="renderMarkdown(streamContent)"`。每次执行都要把**当前完整文本**过一遍 `renderMarkdown`——背后是 `markdown-it` 全量解析 + `highlight.js` 对每个代码块高亮。每个 delta 都来一次，代价三重：

1. **计算量 O(n²)**：第 k 个 delta 到达时重新解析长达 k 段的全文，总工作量 ≈ 回答长度 × 分片数；
2. **语法高亮"闪烁"**：代码块写到一半时语法树不完整，每帧对半截代码高亮，颜色反复跳；
3. **markdown 结构"跳动"**：列表符号、表格线、代码围栏未完成时排版不稳定。

结论：**渲染频率必须从"每个 token 一次"降到"每帧最多一次"**——rAF 节流。

### 6.2 第一板斧：rAF 节流——N 次渲染合并成每帧 1 次

`requestAnimationFrame`（rAF）是"下一帧绘制前回调"，与屏幕刷新率同步（通常 60Hz）。token 来得再密，**一个 ~16ms 的帧里最多刷新一次 DOM**：

```ts
// 流式渲染节流：SSE token 频率远高于屏幕刷新率，每帧最多刷一次 DOM，
// 避免每个 token 都全量跑 markdown-it + 代码高亮（长回答会卡）
let pendingStream = '';      // ★ 帧间累积区：增量先攒在这里
let streamRaf = 0;           // rAF id：0 = 当前没有排队的帧
const flushStream = () => {
  streamRaf = 0;
  streamContent.value = pendingStream;   // ★ 只在 rAF 回调里碰响应式状态
};

onDelta: (delta) => {
  pendingStream += delta;                 // ① 增量先进"桶"
  if (!streamRaf) streamRaf = requestAnimationFrame(flushStream);  // ② 桶里有货才排一帧
},
```

- `onDelta` 职责被压缩到极致：拼字符串 + 本帧没排过才排一个 rAF——一帧来 20 个 delta 也只在帧末 flush 一次；
- `streamRaf` 标记防止一帧内重复排队（否则退化成每 delta 一次渲染）；
- **响应式状态只在 rAF 回调里写**：`streamContent` 一变，`v-html` 重跑、自动滚动 watch 触发——这些昂贵副作用都应"每帧最多一次"。

`onDone` 的收尾照顾节流边界：

```ts
onDone: () => {
  if (streamRaf) {                 // ★ 还有一帧没 flush？取消它，直接落最终值
    cancelAnimationFrame(streamRaf);
    streamRaf = 0;
    streamContent.value = pendingStream;
  }
  // 流式内容转正为正式 assistant 消息
  messages.value.push({ id: `local-${Date.now()}-${++localMsgSeq}`, …, content: streamContent.value, sources: streamSources.value, … });
  streamContent.value = ''; streamSources.value = { kb: [], web: [] };
  loadSessions();
}
```

`done` 到达时可能恰有一帧没执行——取消并手动写入最终值，保证"转正消息 = 完整回答"，不丢最后几个字。

**类比**：水龙头（delta 流）往水池（`pendingStream`）放水，水位计（屏幕）每秒最多看 60 次——龙头开多大都无所谓，抄表频率锁死了渲染成本，与 token 速率解耦。

### 6.3 第二板斧：渲染缓存——内容不变，绝不重算

rAF 解决"流式中同一段内容反复渲染"，但还有一问：**回答转正后，消息列表因滚动/切会话等重渲染时，每条历史消息都要重跑一遍 markdown 吗？** 不。`apps/web/src/utils/markdown.ts` 给 `renderMarkdown` 加了模块级缓存：

```ts
// 渲染结果缓存：AI 回答每条消息内容不变就不重复跑 markdown-it + 代码高亮
const renderCache = new Map<string, string>();
const RENDER_CACHE_MAX = 200;

export function renderMarkdown(text: string): string {
  const hit = renderCache.get(text);
  if (hit !== undefined) return hit;
  if (renderCache.size >= RENDER_CACHE_MAX) renderCache.clear();   // 简单容量上限
  const html = md.render(text);
  // 给每个代码块包容器 + 复制按钮
  const wrapped = html
    .replace(/<pre class="hljs">/g,
      '<div class="code-block"><button type="button" class="code-copy" title="复制代码">复制</button><pre class="hljs">')
    .replace(/<\/pre>/g, '</pre></div>');
  renderCache.set(text, wrapped);
  return wrapped;
}
```

组件层还有一个 computed 缓存（`ChatMessageItem.vue`）：

```ts
const msgHtml = computed(() => renderMarkdown(props.msg.content));
```

两层缓存各管一段：模块 Map 以"文本全文"为 key，容量 200 满了整体清空（聊天内容基数小，不需要 LRU）；computed 靠 Vue 依赖追踪，只要 `content` 没变就不重新求值。叠加效果：**历史消息的 markdown 解析在其生命周期里只发生一次**。流式中的回答每帧渲染一次（内容在变，缓存帮不上），转正后从此零重算。

### 6.4 第三板斧：别让"附加工作"偷走帧

1. **复制按钮用事件委托**：流式块只有一个 `@click="handleStreamClick"`，靠 `classList.contains('code-copy')` 判断（`ChatMessageItem` 同理）。几百次渲染若每块都绑监听器就是几百次重建；事件委托让 DOM 无论多大都只有一层监听，还顺带让生成中的代码块也能复制。
2. **自动滚动只在"用户停在底部"时生效**：`autoScroll` 由滚动事件维护（距底 < 120px 视为"想跟最新"）。用户翻历史时**绝不强制拉回底部**。
3. **KeepAlive 恢复滚动位置**：`savedChatScrollTop` 只在滚动/程序滚底时记录，**绝不在 `deactivated` 里保存**——源码注释记录了真实事故：组件卸载后 DOM 已脱管、`scrollHeight` 读到 0 会覆盖正确值。

### 6.5 组合账本

| 阶段 | 无三板斧 | 有三板斧 |
|---|---|---|
| 流式 500 个 delta | 500 次全文 markdown 解析，O(n²)，明显卡顿 | ≤ 60 次/秒（rAF 合并），每帧最多一次 |
| 转正后滚动/切会话 | 每条历史消息重复全量解析 | Map + computed 双重命中，零重算 |
| 代码块多 | 每块独立监听器反复重建 | 事件委托一层监听 |
| 翻历史时 | 被反复拽回底部 | autoScroll 暂停 |

流式中的 `renderMarkdown` 没走缓存（内容每帧变，Map 命中不了，缓存反而白长）——**流式中靠 rAF 限制"解析次数"，转正后靠缓存消灭"重复解析"**：一个管频率，一个管重复。

---

## 七、乐观渲染与失败处理：先上屏，出错再收拾

### 7.1 为什么乐观渲染

用户在输入框敲回车，期待自己的话**立刻出现在对话里**。若等后端落库甚至整轮完成才上屏，会有 1~2 秒空窗——聊天产品里这是致命的卡顿感。乐观渲染原则：**以本地状态先渲染，把与服务器的同步变成后台职责**。

`handleSend` 清空输入并转交 `sendPayload`：

```ts
async function handleSend() {
  const question = input.value.trim();
  const images = [...pendingImages.value];
  const files = [...pendingFiles.value];
  if ((!question && images.length === 0 && files.length === 0) || streaming.value || !currentSessionId.value) return;
  await sendPayload(question, images, files);
}
```

### 7.2 sendPayload：清状态 → 乐观上屏 → 建流

```ts
async function sendPayload(question, images, files, isRetry = false) {
  const payloadImages = [...images]; const payloadFiles = [...files];
  if (!currentSessionId.value) return;
  if (!isRetry) retryDraft.value = null;   // 新发送：清掉上次的失败草稿

  // 上传文件内容拼进消息（模型据此回答）
  const fileBlock = payloadFiles.length
    ? `\n\n【上传文件内容】\n${payloadFiles.map((f) => `--- ${f.name} ---\n${f.content}`).join('\n\n')}`
    : '';
  const content = question + fileBlock;

  input.value = ''; pendingImages.value = []; pendingFiles.value = [];
  error.value = ''; streaming.value = true;
  streamContent.value = ''; streamSources.value = { kb: [], web: [] };
  startThinkingTimer();

  // 乐观渲染：用户消息立即上屏（id 唯一，防止与历史消息 key 撞车导致图片 DOM 复用堆叠）
  const optimisticId = `local-${Date.now()}-${++localMsgSeq}`;
  lastOptimisticMsgId.value = optimisticId;
  messages.value.push({
    id: optimisticId, sessionId: currentSessionId.value, role: 'user',
    content, imageDataUrl: payloadImages[0] ?? null,
    imageDataUrls: payloadImages.length ? payloadImages : null,
    sources: null, createdAt: new Date().toISOString(),
  });

  // 发送新问题时强制滚到新问题所在位置（即使用户刚才在翻历史）
  autoScroll = true;
  await nextTick();
  const el = messageContainer.value;
  if (el) el.scrollTop = el.scrollHeight;

  abortController.value = new AbortController();
  const ac = abortController.value;   // ★ P1-3：局部持有本次请求的控制器
  // …rAF 节流（见 6.2）、onSources/onDelta/onDone/onError 回调（见 7.3）…
  try {
    await askQuestion(currentSessionId.value, content, useWebSearch.value, ac.signal,
      { …回调… }, payloadImages.length ? payloadImages : undefined);
  } finally {
    stopThinkingTimer();
    // P1-3：Stop 后立刻重发时，旧请求的 finally 晚到不能清掉新流的控制器与状态——
    // 仅当 abortController.value 仍指向本次请求（ac）才复位
    if (abortController.value === ac) { streaming.value = false; abortController.value = null; }
  }
}
```

两个设计点：

1. **`local-` id 的唯一性防 DOM 复用**。`v-for :key="msg.id"`，Vue 用 key 决定 DOM 复用/重建：**id 相同会被当成同一条消息直接复用旧 DOM**——普通文本没事，带图消息会"图片叠在旧消息上、切走残留"。所以 `localMsgSeq` 是模块级自增序号（跨消息不重复），拼 `Date.now()` 双保险——这正是源码注释"id 相同会复用 DOM 导致图片堆叠"的意思。
2. **`finally` 里的 `ac` 身份校验**是停止/重发竞态的保险：点停止后立刻发新消息，旧请求的 `finally` 会晚到——无脑复位会清掉**新流**的状态；`abortController.value === ac` 保证"只有我还是当前请求才复位"。

### 7.3 失败三件套：错误条 + 草稿保留 + 后端回滚

流式失败时（`onError`）前端做三件事：

```ts
onError: (message) => {
  // P2-7：失败时保留本次内容供"重试"（后端已回滚未成功的用户消息，前端可安全重发）
  error.value = message;
  retryDraft.value = { question, images: payloadImages, files: payloadFiles };
},
```

1. **`error.value`**：模板渲染红色错误条；
2. **`retryDraft`**：原样保存本次内容，错误条出现"重试 / 放弃"——**用户的字、图、文件一个不丢**；
3. **乐观用户消息的去留由后端配合**：后端在模型调用失败时**回滚刚落库的用户消息**（4.5 的 `deleteMany`）。不回滚会怎样？用户点重试，后端再落库一条相同提问——刷新后历史里出现**两条相同提问**；回滚 + 前端移除乐观消息后，重试是干净的一次重发。

重试与放弃：

```ts
/** 失败"重试"：移除失败的乐观用户消息（后端已回滚，不重复），用原内容重新发送 */
async function handleRetrySend() {
  const d = retryDraft.value;
  if (!d || streaming.value) return;
  if (lastOptimisticMsgId.value) {   // 不删会残留一条假消息
    messages.value = messages.value.filter((m) => m.id !== lastOptimisticMsgId.value);
    lastOptimisticMsgId.value = null;
  }
  await sendPayload(d.question, d.images, d.files, true);   // isRetry=true
}
```

`lastOptimisticMsgId` 的时机：失败时**只记录 id 不移除消息**（错误条与用户消息同屏）；点"重试/放弃"才移除。配合后端回滚形成一个闭环：

```
前端: onError → 保留 retryDraft + 记录 lastOptimisticMsgId
后端: LLM 调用失败 → deleteMany 回滚用户消息（防刷新后重复）
用户: 点"重试" → 移除乐观消息 → sendPayload(…, isRetry=true) 重新走全链路
结果: 无论刷新与否，历史里只有一条用户提问 + 一次回答
```

### 7.4 一个边界：失败发生在用户消息落库之前

回滚的注释写得很清楚：

```
// 模型调用失败 → 回滚刚落库的用户消息（回答没生成，留着会让前端"重试"重复落库）
// 检索阶段失败时用户消息还没建，无需处理；此处只在 LLM 阶段失败时回滚。
```

失败发生在检索阶段（④ 之前）时，用户消息**根本没创建**，前端移除乐观消息即可、后端无事可做；只有 ④ 之后流式阶段失败才需回滚——**回滚点精确对应落库点**。

---

## 八、停止生成：AbortController 链路与部分内容保留

### 8.1 从按钮到上游的整条链

用户点"停止"，前端只有一行 `abortController.value?.abort()`，却沿着一整条链传导：

```
用户点停止
  → abortController.value.abort()             Chat.vue handleStop
  → fetch-event-source 收到 signal.abort      api/chat.ts（同一 signal）
  → 浏览器中止 fetch，关闭连接
  → Node 触发 res 的 close                     chat.controller.ts
  → controller 的 abort()                      （res.on('close')）
  → service 监听的外部 signal aborted          chat.service.ts
  → 内部 abortController.abort()
  → OpenAI SDK 向上游发取消                    （不再计费后续 token）
```

**为什么需要两级 AbortController？** 外部 signal（来自 `res.on('close')`）是"连接断开"的抽象，内部 controller 是"取消这次 OpenAI 请求"的抽象——两层用 `addEventListener` 解耦：将来取消原因不止一种（管理员强制停止、超时自动取消），只需外部多触发几次 abort，内部零改动。

### 8.2 停止后：部分内容保留，但不落库

```ts
function handleStop() {
  abortController.value?.abort();
  // 保留已生成的部分回答：把流式累积的内容落成一条 assistant 消息
  //（否则中止时 onDone 不触发，回答到一半的内容就丢了）
  if (streamContent.value.trim()) {
    messages.value.push({
      id: `local-${Date.now()}-${++localMsgSeq}`,
      sessionId: currentSessionId.value!,
      role: 'assistant',
      content: streamContent.value,      // ★ 已经流出来的部分
      sources: streamSources.value,      // 来源一并保留
      createdAt: new Date().toISOString(),
    });
    streamContent.value = ''; streamSources.value = { kb: [], web: [] };
  }
  streaming.value = false;
  stopThinkingTimer();
}
```

三个行为：

1. **`streamContent` 非空就把部分内容转正成 assistant 消息**。为什么手动转正？正常流程里"流式转正"发生在 `onDone`（6.2）——而 abort 后 `onDone` 永远不会触发（后端在中止分支直接 return、不发 done，4.5）。不处理的话，用户看到"回答消失，只剩自己的问题"。**停止 = 保留已经吐出来的部分**。
2. **这条半截消息只存在于前端**。后端中止分支静默 return、**没落库任何 assistant 消息**：落库一条"被用户打断的不完整回答"会污染历史（无完整 sources 关联、无完整 token 统计）。代价是刷新后半截回答消失——**用户消息还在**（④ 早已落库）。"本地留 partial、服务器不留半成品"，是清晰的分工。
3. **`streaming.value = false`** 恢复输入框；配合 7.2 的 `ac` 身份校验，停止后立刻重发也不会串状态。

### 8.3 离页自动中止

```ts
// 真正卸载（登出/退出）：中止进行中的 SSE，避免后台继续消耗 token（P1-4）
onBeforeUnmount(() => {
  stopThinkingTimer();
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  abortController.value?.abort();
  abortController.value = null;
});
```

这是 **BYO 成本纪律**的延伸：切路由/登出不断流，后端会继续生成到结束——在用户自己的 Key 计费下是**用户的钱在后台悄悄烧**。离页 abort 让"用户不看了 = 不生成 = 不扣费"成为默认。

---

## 九、多轮上下文管理：只带最近 3 轮

### 9.1 为什么不能把全部历史塞给模型

- **token 成本随轮数线性涨**：聊到 50 轮，每问一句都把前 50 轮全文重发一次（BYO 是用户的账单）；
- **上下文窗口有硬上限**：终有一天 `context length exceeded`，整个对话不可用；
- **注意力被稀释**：读 50 轮旧账再答第 51 问，抓不住重点。

真实产品做**滑动窗口**。本项目把 N 定为 **3 轮（6 条）**，常量带注释：

```ts
const HISTORY_ROUNDS = 6; // 历史对话最多保留最近 3 轮（6 条）
```

### 9.2 取历史的正确姿势：倒序 take 再反转

```ts
// ① 历史对话（最近 3 轮）：先按时间倒序取最近 N 条，再反转回时间正序
//（注意：不能 orderBy asc + take，那会取到【最早】的 N 条——上下文会越聊越旧）
const history = await this.prisma.chatMessage.findMany({
  where: { sessionId },
  orderBy: { createdAt: 'desc' },
  take: HISTORY_ROUNDS,
});
history.reverse();
```

直觉上的 `ORDER BY createdAt ASC LIMIT 6` 是**整个会话最早的 6 条**！消息表只追加，最早的记录永远不变——聊得越久，这个查询越像"重播开场白"，模型永远看不到最近对话。必须先 DESC 拿最新 6 条（只扫倒序索引），再内存 `reverse()`。**方向错了，整个多轮对话就废了。**

### 9.3 同一份历史的两种用法

| 消费者 | 用途 | 截断策略 |
|---|---|---|
| `rewriteQuery(question, history, target)` | 生成独立检索查询（指代消解） | 每条 `content.slice(0, 200)`（第 04 章 §7.2） |
| `buildPrompt(…)` 的 `【历史对话】` 段 | 让模型"记得前面聊什么"再回答 | 最近 6 条全量拼接 |

为什么改写截 200 而 Prompt 不截？**职责不同**：改写只需要"上一轮在聊什么"的粗粒度（200 字符足够消解"它指什么"），截断省 token；Prompt 里模型要真正"读"历史保持连贯，截断会丢实质内容。各按需裁剪，不搞一刀切。

上下文总量的"软上限"三层叠加：历史 3 轮硬上限；改写历史每条再截 200；单条用户输入 DTO 上限 40 万字符；单文件提取 30k 截断（第十节）。仍可能超窗口时（如上一轮回答本身 1 万字），由 `translateLLMError` 的 context 分支兜底成中文提示（第十二节）。**项目没有做"按 token 动态裁剪"的精确预算**，用"轮数上限 + 出错提示"组合拳——多数对话够用、行为可预期。

### 9.4 注意：历史是"文字段"而非"多轮消息"

看 `buildPrompt` 的组装（片段）：

```ts
const historyText = history
  .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
  .join('\n');
const userPrompt = [
  sourceText ? `【参考资料】\n${sourceText}` : '',
  history.length ? `【历史对话】\n${historyText}` : '',
  '【用户问题】',
  // 只发图片时没有文字问题 → 给模型一个明确指令
  (question ?? '').trim() ||
    (imageDataUrls.length > 1 ? '请描述这些图片的内容' : '请描述这张图片的内容'),
].filter((s) => s !== '').join('\n');
```

**最终发给模型的 `messages` 数组里只有一条 user 消息**——历史不是多条独立 OpenAI 消息，而是被格式化成"文字段"嵌进 `【历史对话】` 小节，与 `【参考资料】`、`【用户问题】` 并列。这是刻意的简化：

- 优点：请求结构固定（system + 单条 user），历史是"上下文材料"而非"需要逐轮回应的对话流"；一整块文本肉眼可读、易调试；
- 代价：牺牲 OpenAI API 原生的多轮消息语义（role 轮换让模型更精确理解"最后一句是用户说的"）。对"参考历史 + 回答当前问题"的 RAG 场景，文字段方案够用且可控——**用结构换简单**。

---

## 十、多模态：图片传 data URL，文件提取成文本

### 10.1 图片链路：粘贴/上传 → 压缩 → data URL → JSON body

图片从剪贴板/文件选择器到模型，前端四步：

1. **收集**：`onPasteImage` 读剪贴板 `image/*` 项、`onPickImage` 收文件选择结果，都受 `MAX_IMAGES_PER_MESSAGE = 9` 限制（定义在 `apps/web/src/types/chat.ts`，多个组件共用避免硬编码漂移）；
2. **压缩**：`compressImage` 用 canvas 把最长边缩到 1024px、JPEG 0.8 重编码为 data URL：

```ts
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1024;
      const scale = Math.min(1, max / Math.max(img.width, img.height)); // 等比缩放
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(url); reject(new Error('图片处理失败')); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}
```

**为什么必须压缩？** ① **传输**——`AskDto` 单图上限 6,000,000 字符，手机原图的 base64（体积再膨胀 ~33%）轻松超限；② **成本**——视觉模型按分辨率/token 计费，4K 与 1024px 对"看懂内容"没差别、对账单差别很大；③ **性能**——9 张原图 data URL 让请求体和消息列表双双臃肿。1024px/JPEG 是"看得清 vs 传得起"的折中。

3. **随消息发送**：`sendPayload` 把 data URL 数组传进 `askQuestion`，进 POST body：
   `body: JSON.stringify({ content, useWebSearch, ...(imageDataUrls?.length ? { imageDataUrls } : {}) })`

4. **后端 DTO 校验**（`dto/ask.dto.ts`）——数据进业务前最后一道闸：

```ts
export class AskDto {
  @IsOptional() @IsString({ message: '问题必须是字符串' })
  @MaxLength(400_000, { message: '内容过长' })
  content?: string;                     // 可只发图不带字

  @IsOptional() @IsBoolean({ message: 'useWebSearch 必须是布尔值' })
  useWebSearch?: boolean;

  @IsOptional() @IsString({ message: '图片必须是字符串' })
  @MaxLength(6_000_000, { message: '图片过大' })
  imageDataUrl?: string;                // 单图（兼容旧客户端）

  @IsOptional() @IsArray({ message: '图片必须是数组' })
  @ArrayMaxSize(9, { message: '一次最多 9 张图片' })
  @IsString({ each: true })
  @MaxLength(6_000_000, { each: true, message: '单张图片过大' })
  imageDataUrls?: string[];             // 多图数组
}
```

"新旧兼容"的痕迹：`imageDataUrl`（单图）是历史字段，controller 里 `dto.imageDataUrls ?? (dto.imageDataUrl ? [dto.imageDataUrl] : undefined)` 归一化——**向后兼容旧客户端而不必立即升级**。

### 10.2 视觉模型自动路由：发图时悄悄换模型

图片发出去是一回事，**当前模型能不能看懂**是另一回事——纯文本模型收到 `image_url` 消息会直接报错。解法是自动路由：发图时当前模型不支持视觉，就自动换用用户配置里的视觉模型，**只这一次调用生效、不改会话绑定**：

```ts
// 带图自动路由：当前模型不支持视觉时，自动换用用户配置里的视觉模型
//（如 deepseek-v4-flash-vision-exp、Qwen3-VL）——文本对话仍用会话/默认模型，
// 两个模型各司其职，不用手动切换；没有视觉配置则保持原模型（报错会提示切换）
if (images.length > 0 && !isVisionModelName(target.model)) {
  const visionTarget = await this.modelConfigService.resolveVisionForUser(userId);
  if (visionTarget) {
    this.logger.log(`会话 ${sessionId} 图片路由: ${target.model} → ${visionTarget.model}（识别图片）`);
    // 只改这一次调用的目标，不改变会话绑定
    target.model = visionTarget.model;
    target.baseURL = visionTarget.baseURL;
    target.apiKey = visionTarget.apiKey;
  }
}
```

视觉判定是命名启发式，前后端各一份、规则一致：

```ts
// 后端（model-config.service.ts）
export function isVisionModelName(model: string): boolean {
  return /vision|[-/]vl\b|vl[-.\d]|4v|omni|glm-4v|internvl|minicpm/i.test(model);
}
// 前端（Chat.vue，发图前预报提示用）：与后端一致
const VISION_RE = /vision|[-/]vl\b|vl[-.\d]|4v|omni|glm-4v|internvl|minicpm/i;
```

`resolveVisionForUser` 的策略是"遍历用户全部配置 × 每配置的模型列表，命中视觉关键字即返回，默认配置优先"。模型名是用户自己填的（BYO），只能靠启发式猜哪个能看图——猜错也没关系：路由失败时 `translateLLMError` 的图片分支会把上游报错翻译成"请切换支持视觉的模型"（第十二节）。

前端发图前还有一个**预报 toast**，让"自动路由"不是黑盒：

```ts
if (payloadImages.length > 0 && activeModelId.value && !VISION_RE.test(activeModelId.value)) {
  const v = modelConfigs.value.find((c) => VISION_RE.test(c.model));
  if (v) toast.info(`图片将自动使用视觉模型 ${v.model} 识别，文字对话仍用当前模型`);
}
```

### 10.3 视觉消息格式 & 只发图兜底指令

`buildPrompt` 里图片消息用 OpenAI 兼容协议的视觉格式：`content` 是数组（文字 + 多张 `image_url`）：

```ts
imageDataUrls.length > 0
  ? {
      role: 'user',
      content: [
        { type: 'text', text: userPrompt },
        ...imageDataUrls.map((url) => ({
          type: 'image_url' as const,
          image_url: { url },          // data URL 直接可用
        })),
      ],
    }
  : { role: 'user', content: userPrompt },
```

两个细节：① data URL 本身就是合法的 `image_url`，**无需上传对象存储**——图片跟消息同生共死、删了消息图片也没了、无孤儿文件；② 用户**只发图不带字**时 `【用户问题】` 是空的，若不兜底模型会收到空标题——所以补了明确指令（9.4 的 `(question ?? '').trim() || …`）。

### 10.4 文件上传：提取成文本，拼进问题

普通文件（txt/代码/PDF/Word）走另一条路：**先在后端提取文本，再把文本拼进消息**。上传入口是独立端点（multipart 与 JSON 分开）：

```ts
@Post('extract-file')
@UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
extractFile(@UploadedFile() file: Express.Multer.File) {
  return this.chatService.extractFile(file);
}
```

`chat.service.ts` 的 `extractFile` 核心：

```ts
async extractFile(file: Express.Multer.File | undefined) {
  if (!file) throw new BadRequestException('未收到文件（multipart 字段名应为 file）');
  if (file.size === 0) throw new BadRequestException('文件内容为空');
  const filename = fixMojibakeFilename(file.originalname);   // 修复 multipart 中文文件名乱码
  const fileType = detectFileType(filename);
  if (!fileType) throw new BadRequestException('不支持该文件类型：仅支持文本/代码/PDF/Word 等可读取的文件');
  const raw = await extractText(file.buffer, fileType as DocType);
  const content = cleanText(raw);
  if (!content) throw new BadRequestException('未能从文件中提取到文本（可能是扫描件或图片型 PDF）');
  // 防止超大文本撑爆模型上下文：单文件截断到 3 万字符（3 个文件 ≈ 9 万字符，模型上下文内）
  const MAX_FILE_CHARS = 30_000;
  const truncated = content.length > MAX_FILE_CHARS;
  return {
    filename,
    content: truncated ? `${content.slice(0, MAX_FILE_CHARS)}\n…（文件过长，已截断）` : content,
    truncated,
  };
}
```

这条链复用了**第 03 章文档入库的解析工具**（`document-parser` 的 `detectFileType` / `extractText` / `cleanText`）——同一个 PDF 解析器，入库用、对话传文件也用。前端（`Chat.vue` 的 `onPickFile`）：

- **先做 20MB 本地预检**（与后端 `FileInterceptor` 一致，超限直接 toast 拒绝、不走网络），再调 `extractFileText(f)`（60s 超时）拿 `{ filename, content, truncated }`；
- `truncated` 为真时 toast 告知"已截断（仅保留前 3 万字符）"——**明确告知，避免用户误以为模型看到全文**；
- 发送时拼进消息文本：`【上传文件内容】` 标记不是给人看的格式，而是**前后端切分的协议**：渲染时 `ChatMessageItem.vue` 用 `indexOf('【上传文件内容】')` 把消息切成"问题正文"和"文件块"——问题进气泡、文件块渲染成可点击 chip（右侧预览内容），**绝不把几十 KB 内容整屏铺开**；"分支"开新会话时把文件块从 seed 消息剥掉，避免污染新会话。

### 10.5 一条消息的三种内容各归其位

| 内容 | 传输形态 | 渲染 |
|---|---|---|
| 图片 | `imageDataUrls`（data URL 数组，落库 JSON 列） | 网格缩略图（单图/多图两列） |
| 上传文件 | 提取文本拼进 `content` 的 `【上传文件内容】` 段 | 解析出 `{name, content}` → chip → 预览抽屉 |
| 文字 | `content` 开头（`msgHead` 切片） | 普通气泡 |

渲染前还有**防御性解析**（`ChatMessageItem.vue` 的 `imgList`）：`imageDataUrls` 在旧数据里可能是 **JSON 字符串**而非数组——直接 `v-for` 一个字符串会**按字符拆成无数张"图片"**（源码注释：图片叠满屏）。统一 `Array.isArray` 检查 + 失败兜底空数组，新旧数据通吃。

---

## 十一、联网双来源与"未检索到资料"的诚实披露

### 11.1 开关与 Tavily：锦上添花必须"可降级"

联网开关在输入框上（`useWebSearch`），`localStorage` 持久化（`kb-use-web-search`），默认关，一路传到 `askAndStream`。后端实现 `web-search.service.ts` 只有 100 行，选型与降级哲学写在类注释：

```ts
/**
 * 为什么选 Tavily：
 * - 专为 LLM/Agent 设计的搜索 API，返回干净的"标题+URL+内容摘要"，不需要自己解析 HTML
 * - 免费额度 1000 次/月，学生项目够用
 * - 对比：自己抓 DuckDuckGo/Bing 不稳定且可能被反爬
 * 设计：key 在 .env 的 TAVILY_API_KEY 配置；
 * 未配置 key 时 search() 返回空数组，问答自动退化为"纯知识库检索"，不影响主流程
 */
```

`search` 延续第 04 章的"**锦上添花型组件必须可降级**"哲学：

```ts
async search(query: string, maxResults = 5): Promise<WebSource[]> {
  const key = this.apiKey;
  if (!key) return [];               // 没配 key → 空数组，主流程照走
  try {
    const res = await fetch(this.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic' }),
    });
    if (!res.ok) { this.logger.warn(`联网搜索失败: HTTP ${res.status}`); return []; }
    const data = (await res.json()) as { results?: … };
    return (data.results ?? [])
      .filter((r) => r.title && r.url && r.content)   // 缺字段条目直接丢
      .map((r) => ({ title: r.title!, url: r.url!, content: r.content!, score: r.score }));
  } catch (err) {
    this.logger.warn(`联网搜索异常: ${(err as Error).message}`);
    return [];                        // 任何异常 → 空数组，绝不阻断问答
  }
}
```

Tavily 返回"标题 + URL + 干净摘要"而非原始 HTML——**搜完直接喂 Prompt，不用自己解析网页**，这是被选中的核心原因。类里还有个 `extract(url)`（Tavily Extract API）供**自主研究 Agent 精读网页正文**用，第 06 章再见。

注意 `WebSource` 与知识库来源结构完全不同：`{ title, url, content, score? }`——有 URL 因为网络资料要**可点击核实**；没有 `chunkIndex`/`documentId` 因为网页没有"第几段"。

### 11.2 双来源同屏：一个 sources 事件，两套展示

收到 `sources` 后来源进 `streamSources = { kb, web }`。生成期间的小字提示：

```html
<div v-if="streamSources.kb.length || streamSources.web.length" class="mt-2 text-xs text-muted-foreground">
  已检索到知识库 {{ streamSources.kb.length }} 条
  <template v-if="streamSources.web.length"> + 网络 {{ streamSources.web.length }} 条</template>
  ，正在生成回答
</div>
```

回答完成后来源随消息转正，由 `ChatSourcePanel.vue` 渲染成可折叠面板（`<details>`）：标题"引用来源（知识库 X 条 · 网络 Y 条）"，内部上下两段——**📚 知识库**（文件名 + 相似度 + 预览，点击触发 `open-source` → `DocPreviewDrawer` 定位原文第 N 段）和 **🌐 网络**（带链接标题，点击新标签打开原网页）。

```html
<summary class="cursor-pointer font-medium text-muted-foreground">
  引用来源（知识库 {{ sourcesKb(props.sources).length }} 条
  <template v-if="sourcesWeb(props.sources).length"> · 网络 {{ sourcesWeb(props.sources).length }} 条</template>）
</summary>
```

与第 04 章呼应的细节：`similarity: null`（符号/全文来源）显示"相关"而非百分比：

```ts
function similarityPercent(s: number | null): string {
  return s == null ? '相关' : `${Math.round(s * 100)}%`;
}
```

新旧兼容在展示层兜底：`ChatSourcePanel` 与 `ChatMessageItem` 的 `sourcesKb()` 里 `Array.isArray(s) ? s : s.kb` 一行兼容"旧消息 sources 是纯数组、新消息是 `{kb, web}` 对象"两个时代。

**为什么不合并成一个列表？** 两者的"核实路径"不同：知识库来源点击跳回**文档原文段落**，网络来源点击跳**外链网页**——分栏展示，各点各的。

### 11.3 "未检索到知识库资料"的三层诚实披露

第 04 章 §10.2 讲过"无资料兜底"的前两层，本章从全链路把它串完——这套披露横跨 sources 事件、buildPrompt、落库、渲染每个环节。`buildPrompt` 按模式切系统提示词，每种模式都有对应的"引用纪律"：

```ts
if (useKnowledgeBase) {
  systemParts.push(
    '你是一个严谨的 AI 问答助手，具备两个知识来源：私有知识库资料和联网搜索到的网络资料。',
    '回答时请结合两者：优先以【参考资料】中的知识库内容为准；知识库没有的、但【网络资料】中有的事实，可以引用网络资料。',
    '回答中引用资料时请标注 [来源1]、[来源2] 等编号（编号与资料一致），网络资料请附上对应链接。',
  );
  if (kbSources.length === 0 && webSources.length === 0) {
    // ★ 用知识库但完全没检索到：允许用自身知识，但必须明说
    systemParts.push(
      '本次未检索到任何知识库与网络资料：你可以基于自身知识回答，但必须在回答开头明确标注"（未检索到知识库资料，以下为模型自身知识）"。',
      '严禁编造来源编号或假装引用了资料。',
    );
  } else {
    systemParts.push('如果【参考资料】中没有相关信息，请明确说明"未找到相关内容"，不要编造。');
  }
} else if (webSources.length) {
  // 纯对话 + 联网：只允许引用网络资料
  systemParts.push('你是一个严谨的中文 AI 助手。', '回答可以引用【网络资料】中的内容，引用时标注 [来源N] 并附上链接。', '网络资料没有的信息请如实说明，不要编造。');
} else {
  systemParts.push('你是一个友善、严谨的中文 AI 助手。');   // 纯对话
}
```

核心纪律：**可以基于任何可得资料回答，但引用必须实名（[来源N] 一一对应），没资料不许假装有**。同时，**有资料才写 `【参考资料】` 小节**，完全没检索到就整个省略——"不写这一节"本身就是诚实：不给模型"假装有资料可引"的由头。资料标签也有讲究：

```ts
const kbText = useKnowledgeBase && kbSources.length
  ? kbSources.map((s) => {
      number += 1;
      const label =
        s.similarity === null
          ? `[${number}]（文档《${s.filename}》全文）`      // 全文模式注入
          : `[${number}]（来自文档《${s.filename}》第 ${s.chunkIndex + 1} 段）`;  // 检索命中
      return `${label}\n${s.content}`;
    }).join('\n\n')
  : '';
// webText 类似：[编号]（来自网页：{title}\n链接：{url}）\n{content}
```

模型据此在正文写 `[来源1]`，读者回来源面板看是**哪一段**——`chunkIndex + 1` 因为库里段序号从 0 开始、人类从 1 数。

UI 双保险（`ChatMessageItem.vue`）：一条助手消息**用了知识库模式、sources 非空、但 kb 与 web 都 0 条**时渲染虚线框，把"这回答没资料支撑"钉在屏幕上：

```html
<p v-if="props.msg.role === 'assistant' && props.msg.sources &&
          sourcesKb(props.msg.sources).length === 0 &&
          !hasWebSources(props.msg.sources) && props.useKnowledgeBase"
   class="mt-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
  ⚠️ 未检索到知识库资料，以上回答基于模型自身知识（可在知识库补充相关文档后重问）
</p>
```

| 层 | 位置 | 手段 | 管什么 |
|---|---|---|---|
| 第一层：Prompt 纪律 | `buildPrompt` 系统提示词 | 允许用自身知识 + 必须开头标注 + 严禁编造 [来源N] | 约束模型"嘴上"诚实 |
| 第二层：UI 兜底 | `ChatMessageItem` 虚线框 | 0 引用时钉一句"未检索到知识库资料…" | 模型忘了标注用户也分得清 |
| 第三层：引用纪律 | `【参考资料】` 组装 | 有资料才写参考资料节、资料没有的明确说"未找到" | 有资料也不许超范围编造 |

与第 04 章的门控是一枚硬币的两面：**门控挡住"不可靠的资料进 Prompt"，披露让"没有资料"这件事本身可见**——用户永远不会把"模型自由发挥"误认成"有出处的回答"。

---

## 十二、错误翻译：把上游英文错误变成中文行动指南

### 12.1 为什么必须翻译

对话链路出错最多的环节是**调模型那一下**，而 SDK 抛的错误长这样：

```
400 Model does not exist: 'deepseek-chat-extra'. ...
429 Too Many Requests ...
```

用户是中文产品用户；更要命的是很多错误**不是用户能直接修的**（模型名与平台不匹配），要告诉用户**去哪改**。所以 `translateLLMError` 不只是翻译，而是把错误**映射成可操作的中文行动指南**。

### 12.2 分类表与代码

先归一化：状态码 + body 拼成小写串，统一正则匹配：

```ts
private translateLLMError(err: unknown, hasImage: boolean): BadRequestException {
  const e = err as { status?: number; message?: string; body?: unknown; code?: string | number };
  const status = e.status ?? 500;
  const bodyText =
    typeof e.body === 'string' ? e.body : JSON.stringify(e.body ?? e.message ?? '');
  const raw = `${e.message ?? ''} ${bodyText}`.toLowerCase();   // ★ 统一小写再匹配
  …
}
```

| 匹配条件 | 翻译 | 用户该做什么 |
|---|---|---|
| 带图 + `400/422` 或含 `not a vlm / vision language model / image` | 当前模型不支持图片 | 换视觉模型 / 查模型名与平台匹配 |
| `401` 或含 `invalid api key / authentication / unauthorized` | API Key 无效或已失效 | 「模型配置」检查或重绑 Key |
| `402` 或含 `insufficient / balance / quota / payment` | 账户余额不足 | 去对应平台充值 |
| `429` 或含 `rate limit / too many requests` | 触发限流 | 稍等几秒再试 |
| 含 `model does not exist / no such model / invalid model` | 模型名不存在：平台和模型名必须配套 | 修正模型名（附示例） |
| 含 `context / too long / maximum length / token.*limit` | 超出模型上下文长度 | 精简问题 / 减少历史 / 换长上下文模型 |
| 含 `expected content-type` 且非 500 | 带出上游 JSON 错误原文 | 看具体错误 |
| 其余 | 通用兜底（含 HTTP 状态码） | 检查 Key / 模型名 / 余额 / 视觉模型 |

对应代码（分支命中即 return，**特例在前、泛例在后**）：

```ts
// 带图请求被上游拒绝（400/422/无 body）→ 优先提示模型不支持图片
if (hasImage && (status === 400 || status === 422 || /not a vlm|vision language model|image/i.test(raw))) {
  return new BadRequestException('当前模型不支持图片：请在该会话右上角切换到支持视觉的模型（如 deepseek-v4-flash-vision-exp、Qwen/Qwen3-VL 等），或在「模型配置」检查模型名与平台是否匹配。');
}
if (status === 401 || /invalid api key|authentication|unauthorized/i.test(raw)) { … }
if (status === 402 || /insufficient|balance|quota|payment/i.test(raw)) { … }
if (status === 429 || /rate.?limit|too many requests/i.test(raw)) {
  return new BadRequestException('请求过于频繁（触发限流），请稍等几秒再试。');
}
if (/model does not exist|model not found|no such model|invalid model/i.test(raw)) {
  return new BadRequestException('模型名不存在：平台和模型名必须配套（DeepSeek 官方 API 用 deepseek-v4-flash 等；SiliconFlow 用 deepseek-ai/DeepSeek-V4-Flash 等）。请到「模型配置」修正模型名。');
}
if (/context|too long|maximum length|token.*limit/i.test(raw)) {
  return new BadRequestException('对话内容超出模型上下文长度：请精简问题、减少历史或切换更长上下文的模型。');
}
// 兜底：把上游 JSON 错误的关键信息带出来，而不是只给 SDK 的 content-type 报错
if (/expected content-type/i.test(raw) && status !== 500) {
  return new BadRequestException(`大模型接口调用失败（HTTP ${status}）：${…}`);
}
return new BadRequestException(
  `大模型调用失败（HTTP ${status}）：请检查「模型配置」的 Key / 模型名 / 余额，或切换到支持图片的视觉模型。${e.message ?? ''}`.slice(0, 300),
);
```

两个细节：

1. **正则匹配比只信状态码稳**：上游（尤其代理网关）状态码常不标准（400 也可能是 Key 错），每分支"状态码 **或** 文本命中"双保险；`raw` 统一 `toLowerCase()` 防大小写漏网；
2. **兜底不空泛**：HTTP 状态码 + 常见原因清单 + 截断 300 字符的原始信息——宁可长而完整，不给查不了原因的废话。

### 12.3 错误翻译的三层链路

把翻译在链路里串起来：

```
第 1 层：service 的 translateLLMError —— 流式 catch（非 abort）→ 翻译 → throw
第 2 层：controller 的 catch —— 翻译过的透传；漏网的英文正则再兜底 → write('error') → res.end()
第 3 层：前端 askQuestion 的 onerror —— SSE 头之前的 JSON 错误 → "Expected content-type"
        → 翻译成"请求未正常建立（响应格式异常）…"
```

第 2 层正则（`Expected content-type|not a VLM|Model does not exist|invalid api key|insufficient.*balance`）是补网：万一有路径漏过 `translateLLMError`，controller 保证 `error` 事件里绝不出现英文。最终效果：**无论错误发生在 SSE 头之前还是之后、被哪一层接住，用户看到的永远是中文、可操作、指向「模型配置」的提示**。

---

## 动手实验

> 先决条件：项目在本机跑通（第 00 章步骤），已绑定可用的大模型 Key，知识库里至少有一篇文档。实验全在浏览器 DevTools 里完成，不改代码。

### 实验 A：在 Network 面板里"逐帧"看 SSE 事件流

1. 打开对话页，F12 → Network，Filter 输入 `messages`；
2. 清空面板，发一个问题（建议开启联网或问知识库问题，让 `sources` 有内容）；
3. 点开这条请求 → **Response** 标签（Chrome 新版对 SSE 有 EventStream 视图）。响应体持续追加，顺序应严格是：第一个 `"event":"sources"`（data 里有 `kb`/`web` 数组与 `mode`，**先于任何正文**）→ 一长串 `"event":"delta"`（每个 content 只有一小段增量）→ 最后 `"event":"done"`；
4. 对照 3.4 报文格式，确认事件间有空行（`\n\n` 帧分隔）；
5. **看首帧时序**：记下 `sources` 与第一个 `delta` 的时间戳——中间隔着"检索完成后、模型 prefill"的时间，这就是"来源先行"让用户不干等的时段；
6. 看 **Headers**：确认 `Content-Type: text/event-stream`、`Cache-Control: no-cache`、`X-Accel-Buffering: no`、状态码 200（而非 201）——验证 2.2。

### 实验 B：F12 打断点，看 rAF 节流合并渲染

1. Sources 里打开 `apps/web/src/views/Chat.vue`（Ctrl+P 搜文件名；源码映射可用时直接定位）；
2. 在 `flushStream` 里 `streamContent.value = pendingStream` 那行断点，同时在 `onDelta` 里 `pendingStream += delta` 那行断点；
3. 发一个长问题。观察：`onDelta` **一帧内命中很多次**（token 密集），而 `flushStream` **每帧最多命中一次**——渲染次数被锁死在帧率、与 token 速率解耦（验证 6.2）；
4. 临时把 `onDelta` 改成直接 `streamContent.value += delta`（去掉 rAF 合并）再发一次，观察是否明显变卡、高亮是否闪烁，然后改回——**对比是理解"为什么不能每 token 全量渲染"的最好方式**；
5. 附带：在 `ChatMessageItem.vue` 的 `msgHtml` computed 断点，回答转正后反复滚动/切会话，`renderMarkdown` 不会对同一内容二次执行（缓存命中，验证 6.3）。

### 实验 C：回答到一半点停止，看整条 abort 链

1. 后端终端保持可见（`pnpm --filter @app/server start:dev`）；
2. 发长问题，流到一半点**停止**；
3. 观察：前端已生成部分**留在屏幕**并转正（没消失），输入框恢复；后端日志出现 `会话 <id> 被客户端中止`（abort 分支 logger，4.5）；**刷新页面**：半截回答消失（后端没落库），但**问题还在**（用户消息生成前已落库）——验证 8.2；
4. 再试"停止后立刻重发"：新回答正常流式、旧 `finally` 没清掉新流状态（7.2 的 `ac` 身份校验——失效的话新流停止按钮会失灵）；
5. 最后开着回答直接**刷新/切走页面**：后端日志同样出现"被客户端中止"（`onBeforeUnmount` 离页 abort，8.3）——"用户不看了 = 不生成 = 不扣费"。

---

## 本章自测

1. 为什么"流式回答"用 SSE 而不是 WebSocket？部署到 Nginx 不做任何配置会发生什么，`X-Accel-Buffering: no` 解决了什么？（🎯 面试必背）
2. 前端为什么不用原生 `EventSource` 而是 `fetch-event-source`？`onerror` 末尾的 `throw err` 为什么是刻意的？
3. SSE 协议里 `sources` / `delta` / `done` / `error` 分别在什么时候发出？为什么"检索结果（sources）要先于正文（delta）"送达？（🎯 面试必背）
4. 流式渲染的"三板斧"是哪三件？为什么不能每个 delta 都全量跑 markdown-it + 代码高亮？（提示：O(n²) 计算量、高亮闪烁、结构跳动三个角度）
5. 后端在流式失败时为什么要回滚"刚落库的用户消息"？停止生成（abort）时为什么**不回滚**它、也**不落库**半截回答？前端停止后如何保证部分内容不丢？
6. 用户只发图片（不带文字）时后端做了哪几件事让请求成功？（提示：视觉模型自动路由、Prompt 兜底指令、DTO 的 content 可选）；若用户没配视觉模型，错误如何被翻译、提示用户做什么？

---

## 本章小结

现在你应该能完整画出"一条回答是怎么流出来的"：**POST 进来 → controller 校验归属、写四个 SSE 头 → service 解析 BYO 目标、取 3 轮历史、改写查询 → 检索知识库（可配联网）→ `sources` 先行 → 落库用户消息 → buildPrompt 组装 → OpenAI `stream: true` + `for await` 逐块转 `delta` → 客户端断开即 abort 不浪费 token → 流完落库助手消息 + 来源 + token → `done` → 前端 rAF 节流 + 渲染缓存流畅画出**。

贯穿本章的设计主线：**单向流用 SSE、双向才用 WebSocket**（选型看方向）；**事件协议要简单统一**（`{event, data}` 单帧）；**断线 = 中止 = 不扣费**（AbortController 全链路）；**渲染成本锁在帧率上**（rAF）**再锁在缓存上**（Map + computed）；**乐观渲染必须配后端回滚**（两端对账不重复）；以及贯穿全书的**诚实披露**——模型可以说"没检索到资料"，但绝不许假装引用了资料。

下一章，把"回答"升级成"研究报告"：当用户丢来一个主题、需要拆成多个子问题逐一检索撰写时，几秒钟的 SSE 流就撑不住了——那是第 06 章 BullMQ 长任务编排的舞台。
