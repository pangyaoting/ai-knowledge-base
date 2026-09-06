# 05 · 对话引擎与 SSE 流式：一条回答是怎么流出来的

> **本章地图**
> - 学什么：为什么用 SSE 而不是 WebSocket、`sources/delta/done/error` 事件协议设计、后端 OpenAI stream + `for await` + 客户端断开 abort、前端 `fetch-event-source` 消费、rAF 节流 + 渲染缓存三板斧、乐观渲染与失败回滚、停止生成的完整 AbortController 链路、多轮上下文管理、多图多文件与视觉模型自动路由、联网双来源展示与"未检索到资料"诚实披露、`translateLLMError` 错误翻译
> - 代码在哪：`apps/server/src/modules/chat/chat.controller.ts`（SSE 端点）、`apps/server/src/modules/chat/chat.service.ts`（`askAndStream` / `buildPrompt` / `translateLLMError` / `retrieveWithHyde`）、`apps/server/src/modules/chat/web-search.service.ts`（Tavily）、`apps/server/src/modules/chat/dto/ask.dto.ts`、`apps/web/src/api/chat.ts`（`askQuestion`）、`apps/web/src/views/Chat.vue`（`handleSend` / `sendPayload`）、`apps/web/src/components/chat/ChatMessageItem.vue` 与 `ChatSourcePanel.vue`（渲染与来源）
> - 动手实验：浏览器 Network 面板逐帧看 SSE 事件流；F12 在 `flushStream` / `onDelta` 打断点看 rAF 节流；回答到一半点停止观察后端"被客户端中止"日志
> - 本章难度：★★（链路长但每段都不难；建议配着浏览器 DevTools 读）

---

第 04 章的结尾停在 `askAndStream` 的门口：5 段检索资料已经躺在 `kbSources` 里，重排、门控、HyDE 这些"阅读理解"全部完成。接下来发生的事——资料如何与 Prompt 组装、模型的回答如何一个 token 一个 token 地"流"回浏览器、前端又如何把它流畅地画出来——就是本章的主线。

读这一章时请把问题从"系统怎么找到资料"切换到"系统怎么把答案送出去"：

> 一次 `POST /chat/sessions/:id/messages`，响应要在**几十秒里持续不断地吐出小段文字**，浏览器要**边收边画**，用户还能随时**喊停**，出错了还要能**体面地结束**——这不是一次普通 HTTP 请求能表达的。

它需要一套叫 **SSE（Server-Sent Events）** 的技术，一套**前后端约定的事件协议**，以及一整套**围绕"长连接 + 流式状态"的工程细节**。我们先在浏览器里看一条回答的"线"，再一层层拆开。

---

## 一、全景：一条回答从检索结束到上屏，中间发生了什么

先给一条完整回答画时间线（这是 `chat.service.ts` 类顶部注释就写好的流程：**检索 → 组装 Prompt → DeepSeek 流式 → 通过 writer 输出 SSE 事件**）：

```
浏览器                                服务器(askAndStream)                大模型API
  │ POST /chat/sessions/:id/messages     │                                  │
  │ ────────────────────────────────────►│                                  │
  │                                      │ getSession 校验归属（404 早退）      │
  │                                      │ resolveForChat 解析 BYO 目标        │
  │                                      │ ① 取最近 3 轮历史（6 条）             │
  │                                      │ ② 有历史→rewriteQuery 指代消解       │
  │                                      │ ③ 全文/检索分流 + (可选) 联网搜索     │
  │ ◄─ data:{event:"sources",...} ───────│（检索完先发 sources，再开始生成）     │
  │                                      │ ④ 落库用户消息（含图片 data URL）      │
  │                                      │ ⑤ buildPrompt 组装系统/用户消息       │
  │                                      │ ⑥ 发起流式请求 ◄───────────────────►│
  │ ◄─ data:{event:"delta",...} × N ─────│   for await 逐块转发 ◄──────────────│
  │ ◄─ data:{event:"done",...} ──────────│ ⑦ 落库助手消息 + 来源 + token 用量    │
  │                                      │    自动生成会话标题                    │
```

几个在图上就能读出来的设计：

1. **`sources` 事件先于第一个 `delta`**：资料检索完成后、模型还没吐第一个字，来源就先送到前端；
2. **`delta` 是"流"的主体**：模型每个增量块都会被包装成一个独立事件转发；
3. **`done` 是终态**：此时后端已完成落库，前端收到它才把"流式中的回答"转正成一条正式消息；
4. **用户消息落库发生在检索之后、生成之前**（④ 在 ⑥ 之前）——为什么不在收到请求就落库？因为要等检索结果和改写结果都确定；而它又必须赶在生成前落库，否则生成中途崩溃这条提问就丢了。

本章其余部分，就是把这根时间线上每一段的"为什么"和"怎么做"讲透。

---

## 二、为什么是 SSE，而不是 WebSocket

### 2.1 方向决定协议

先想清楚一次问答的**通信方向**：客户端只需要发**一次请求**（问题 + 开关 + 图片），剩下几十秒全是**服务器单向往浏览器推**（sources、delta、done）。这是典型的**单向流（server push）**场景。

**类比**：SSE 像收音机——电台（服务器）单向播音，你（浏览器）只能听，不能对着电台讲话；WebSocket 像电话——两边都能随时开口，是真正的双向全双工。RAG 问答的"讲话"几乎全部发生在一个方向，用电话是杀鸡用牛刀。

为什么单向流场景里 SSE 是更优解？把三种候选方案摆在一起看：

| 维度 | 轮询 (Polling) | SSE | WebSocket |
|---|---|---|---|
| 通信方向 | 一问一答（短轮询）/ 周期拉取 | **服务器→浏览器单向** | 全双工 |
| 额外开销 | 每个分片一次完整 HTTP 往返，头开销巨大 | 一条 HTTP 连接长驻，服务端写即可 | 需要先 101 协议升级握手 |
| 需要 POST + 自定义 Header | 支持 | **支持**（就是普通 HTTP） | 支持 |
| 经过 Nginx / 负载均衡 | 无问题 | 兼容好（关掉缓冲即可） | 需要专门配置 `Upgrade` 头、粘性会话 |
| 断线重连 | 每轮天然"新连接" | 规范内置（`EventSource` 自动重连） | 需要自己实现心跳与重连 |
| 实现与调试成本 | 低但浪费 | **最低**：服务端就是 `res.write`，浏览器 DevTools 直接看 | 较高，需要维护 ws 状态机 |
| 浏览器兼容性 | 全兼容 | 现代浏览器全兼容 | 全兼容 |

结论很直接：**流式回答是"服务器单向吐字"，天然匹配 SSE**；而 SSE 又是纯 HTTP，POST body、`Authorization` 头、经过 Nginx 都畅通无阻——调试时在浏览器 Network 里能像看普通请求一样逐帧看它。反过来，如果产品需要"用户消息也能被服务端实时推送打断"（比如协同编辑、游戏、IM），那才轮到 WebSocket 出场。

### 2.2 SSE 也是 HTTP：四个响应头说明一切

SSE 没有魔法——它就是一次普通 HTTP 响应，只是**响应体永远不会"结束"**，服务端按需往里追加文本块。区分 SSE 与普通响应的，是下面四个响应头（`chat.controller.ts` 的 `ask()`）：

```ts
@Post('sessions/:id/messages')
@HttpCode(HttpStatus.OK)   // ★ SSE 流返回 200：NestJS 默认 POST 是 201，SSE 语义应为 200
async ask(…, @Res() res: Response) {
  // 先校验会话归属（此时还没写 SSE 头，出错会被全局过滤器转成 JSON 错误）
  await this.chatService.getSession(userId, sessionId);

  // 进入 SSE 模式
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 兼容 Nginx
  res.flushHeaders();
  …
}
```

逐行读这四个头的含义：

1. **`Content-Type: text/event-stream`**：告诉浏览器"这是 SSE"，浏览器的 `EventSource`/`fetch-event-source` 才会按 SSE 帧格式解析（见第三节）；
2. **`Cache-Control: no-cache`**：长连接的内容是"实时演播"，绝不能被任何一层缓存（浏览器、代理）存下来重放；
3. **`Connection: keep-alive`**：显式要求连接不要关，等后续数据；
4. **`X-Accel-Buffering: no`**：这是给 **Nginx** 看的私有头（见 2.3）。

`@HttpCode(HttpStatus.OK)` 是个容易踩的坑：NestJS 对 `POST` 默认返回 **201 Created**，但 SSE 语义上这条响应"成功建立且正在持续"应该是 200——否则前端状态码判断会出诡异问题。

### 2.3 Nginx 必须关缓冲：`X-Accel-Buffering: no`

部署时前端请求先打到 Nginx 再反代到 NestJS。**Nginx 默认开着 `proxy_buffering`**：它会先把上游（NestJS）吐出来的响应攒进自己的缓冲区，攒够 4~8KB（或等上游结束）才一次性转发给浏览器。对 SSE 这是致命的——模型每吐 5 个字 Nginx 就"扣下"不发给浏览器，用户会看到回答**卡顿几秒后突然整段蹦出来**，流式体验全毁。

`X-Accel-Buffering: no` 是 Nginx 官方支持的响应头：收到它，Nginx 对本响应**逐块透传、不缓冲**（其他服务器不认识这个头，会当普通头忽略，无副作用）。**在代码里声明而不是改 Nginx 配置**还有个好处：它是"这个端点需要流式"的自描述，前端 Nginx、CDN、负载均衡都能读到；哪怕以后换了网关，只要它尊重这个头就不会踩缓冲坑。

配套的还有 `res.flushHeaders()`：**先把响应头立即刷给浏览器**。SSE 的语义是"头到达 = 连接已建立"，浏览器看到头才会开始等后续帧；不 flush，头会和第一段 body 一起被积压，首 token 延迟被白白拉长。

### 2.4 手动 `@Res()` 而不是 NestJS 的 `@Sse()`（面试延伸）

NestJS 内置了 `@Sse()` 装饰器，但这个项目**刻意用手动 `@Res()` + `res.write`**。为什么？看真实代码的三个诉求：

```ts
res.setHeader('X-Accel-Buffering', 'no');   // ① 要加自定义头
res.flushHeaders();                          // ② 要手动控制"头先出去"
res.on('close', () => abortController.abort());  // ③ 要监听连接关闭
```

`@Sse()` 适合"把 SSE 优雅地接进 NestJS 的 Observable/异步迭代器体系"，但它封装了太多东西：你想加一个 Nginx 私有头、想在写任何数据前先校验会话、想精确控制断开时机，都得跟它的抽象较劲。手动方案**代码更直白、每字节都在掌控中**——而 SSE 恰恰是那种"差一个头、差一个 flush 就完全坏掉"的协议，适合直白。

---

## 三、SSE 事件协议：sources → delta × N → done

SSE 规范定义的最小帧格式是：

```
data: <一行 JSON>\n\n
```

浏览器端按**空行**切帧。但"data 里装什么、怎么区分事件类型"是**协议设计**，由前后端自行约定。本项目的约定就在 `apps/web/src/types/chat.ts` 里，一行注释说得很清楚：

```ts
/** SSE 事件协议（后端按此格式推送） */
export interface SseEvent<T = unknown> {
  event: 'sources' | 'delta' | 'done' | 'error';
  data: T;
}
```

### 3.1 为什么事件类型装在 `data` 的 JSON 里，而不是用 SSE 原生的 `event:` 字段

SSE 原生支持命名事件：`event: sources\ndata: …`，浏览器端 `addEventListener('sources', …)` 分派。但这个项目选择**所有帧都用匿名 message，事件类型写进 data JSON**：

```ts
const write = (event: string, data: unknown) => {
  res.write(`data: ${JSON.stringify({ event, data })}\n\n`);
};
```

两种方案的取舍：

| | 原生 `event:` 字段 | 类型包进 data（本项目） |
|---|---|---|
| 服务端写法 | 每类事件拼不同帧头 | 一个 `write()` 函数统一处理 |
| 客户端解析 | 按事件名注册多个监听器 | `onmessage` 里一个 `switch` 分流 |
| 事件附带元数据 | 只能靠 data 里再包一层 | 天然就是 `{ event, data }` 结构 |
| 协议版本演进 | 加事件要两端同步改监听器 | data 里加字段即可，旧客户端忽略未知事件 |

单帧结构固定为 `{ event, data }`，让**服务端只有一种写帧的代码、客户端只有一种解析路径**——协议越简单，越不容易出"某个事件名拼错导致前端静默丢消息"的错。数据看板 / 测试脚本也可以直接复用同一个解析函数。

### 3.2 四类事件：时机、载荷与消费者

| 事件 | 何时发出（后端源码位置） | data 载荷 | 前端处理 |
|---|---|---|---|
| `sources` | 检索（含联网）全部完成后、模型开始生成前，`askAndStream` 里 `writer('sources', { kb, web, mode })` | `{ kb: RetrievalSource[], web: WebSource[], mode: 'fulltext'\|'retrieval'\|'none' }` | 存进 `streamSources`，显示"已检索到知识库 N 条，正在生成回答" |
| `delta` | 流式循环里模型每吐一个增量块：`writer('delta', { content: delta })` | `{ content: string }`（**只含增量**，不含前文） | `pendingStream += delta`，rAF 节流后渲染（第六节） |
| `done` | 助手消息落库、标题生成后：`writer('done', { messageId: undefined })` | `{ messageId: null }` | 把累积的 `streamContent` 落成一条正式 assistant 消息，`loadSessions()` 刷新列表 |
| `error` | ① 未绑定模型 Key 的提前返回；② 流中任何异常被 controller catch | `{ message: string }`（已是中文可读） | 显示错误条 + 重试/放弃按钮 |

**为什么 `done` 的 `messageId` 是 `undefined`？** 一个直觉是"后端落库了，把数据库 id 还给前端，前端替换本地消息"。但本项目前端**全程没有把流式消息同步回服务器**（见第七节乐观渲染），本地消息的 id 是 `local-` 开头的临时值，拿到数据库 id 反而要再做一次"替换 id"的协调。既然消息内容两端各有一份、以刷新后重新拉取为准，`done` 就只是一个**纯信号**——"到此为止，把流式中的内容转正"。

### 3.3 为什么"检索结果先于正文"：两个理由

打开 `Chat.vue` 的模板，流式期间的样子是：先出现"思考中"蓝条 + 计时器（`ChatThinkingBar`），收到 `sources` 后出现一行小字"已检索到知识库 N 条 + 网络 M 条，正在生成回答"，第一个 `delta` 到达后正文才开始逐字出现。

这个顺序**不是巧合，是刻意设计**，理由有二：

1. **把检索耗时藏进"等待首 token"的时间段**。模型的 prefill（读 Prompt 出第一个字）本身就要几秒，而检索（两路 SQL + 重排 + 可能的 HyDE）也要一两秒。如果等全部就绪才让浏览器看到任何动静，用户会对着空白屏干等。SSE 连接在请求发出时就建立了，检索一结束**立刻**把 `sources` 推出去——用户看到"已检索到 N 条"，就知道系统正在工作，而不是卡死了。
2. **来源是"信任预告"，先于结论到达**。RAG 产品最反直觉的一点是：**答案还没生成，证据先到了**。这恰好是产品想传达的："下面这个回答不是我凭空编的，依据已经摆在这里。"来源先行的顺序让用户在读正文前就对"这回答有出处"建立预期——这正是第 04 章反复强调的可溯源性在交互层的落地。

### 3.4 真实线上报文：Network 面板里长什么样

浏览器 DevTools 里展开这条请求，响应体（Response → EventStream 标签，或直接看原始响应）大致是这样一帧帧追加的：

```
data: {"event":"sources","data":{"kb":[{"chunkId":"…","filename":"…","similarity":0.91,…}],"web":[],"mode":"retrieval"}}

data: {"event":"delta","data":{"content":"好的，"}}

data: {"event":"delta","data":{"content":"先看"}}

data: {"event":"delta","data":{"content":"Chat.vue 的 sendPayload…"}}

…
data: {"event":"done","data":{"messageId":null}}
```

每帧以 `\n\n` 结尾（图中的空行就是帧分隔符）。值得注意的是：**事件名出现在 data 里**（`"event":"sources"`）而帧本身没有 `event:` 字段——这就是 3.1 说的"自定义协议"的实相。

---

## 四、后端流式实现：askAndStream 的一次完整旅程

第三节讲的是"线上长什么样"，这一节讲"后端怎么把它写出来"。核心文件两个：`chat.controller.ts`（HTTP 边界）与 `chat.service.ts`（业务编排）。

### 4.1 解耦的关键：`StreamWriter` 回调

看 `chat.service.ts` 顶部定义的服务与 writer 接口：

```ts
interface StreamWriter {
  (event: 'sources' | 'delta' | 'done' | 'error', data: unknown): void;
}

@Injectable()
export class ChatService {
  async askAndStream(
    userId: string,
    sessionId: string,
    question: string,
    useWebSearch: boolean,
    writer: StreamWriter,      // ★ 只管"发事件"，不碰 HTTP
    signal: AbortSignal,       // ★ 只管"听中止"，不碰连接
    imageDataUrls?: string[],
  ) { … }
}
```

**Service 里没有任何 `res`、`@Res`、Express 类型**——它只认识两个抽象：`writer(event, data)` 和 `signal`。这是把"业务编排"与"传输细节"分开的教科书式做法：

- controller 负责把 `writer` 实现成 `res.write(...)`，把 `signal` 实现成 `res.on('close') → abort()`；
- service 可以脱离 HTTP 单测（传一个收集事件的假 writer）；
- 未来若换传输（比如改成 gRPC 流、改走 WebSocket），**service 一行不用动**。

### 4.2 controller：先校验，再进流

```ts
@Post('sessions/:id/messages')
@HttpCode(HttpStatus.OK)
async ask(
  @CurrentUser('id') userId: string,
  @Param('id', ParseUUIDPipe) sessionId: string,
  @Body() dto: AskDto,
  @Res() res: Response,
) {
  // 先校验会话归属（此时还没写 SSE 头，出错会被全局过滤器转成 JSON 错误）
  await this.chatService.getSession(userId, sessionId);

  // …设置四个 SSE 头 + flushHeaders（见 2.2）…

  // SSE 事件写入器
  const write = (event: string, data: unknown) => {
    res.write(`data: ${JSON.stringify({ event, data })}\n\n`);
  };

  try {
    // 客户端断开时 abort（由 ChatService 里监听 signal）
    const abortController = new AbortController();
    res.on('close', () => abortController.abort());

    await this.chatService.askAndStream(
      userId, sessionId,
      dto.content ?? '',
      dto.useWebSearch ?? false,
      (event, data) => write(event, data),
      abortController.signal,
      // 多图数组优先；兼容旧客户端传的单图字段
      dto.imageDataUrls ?? (dto.imageDataUrl ? [dto.imageDataUrl] : undefined),
    );
    res.end();
  } catch (err) {
    // 流中出错：发 error 事件优雅结束，不把连接挂死
    let message = (err as Error).message || '服务器错误';
    // 兜底：任何漏网的 SDK 英文错误也翻译成中文（防未知路径把英文甩给用户）
    if (/Expected content-type|not a VLM|Model does not exist|invalid api key|insufficient.*balance/i.test(message)) {
      message = '大模型接口返回异常：可能是模型不支持图片、模型名与平台不匹配、Key 无效或余额不足。请检查「模型配置」后重试。';
    }
    write('error', { message });
    res.end();
  }
}
```

值得停下来看的四个点：

1. **校验分两段，错误形态不同**。`getSession` 放在写 SSE 头**之前**——会话不存在时（404）走 NestJS 全局异常过滤器，返回**普通 JSON 错误**（前端 `fetch-event-source` 收到的不是 SSE，会走 `onerror` 的 content-type 翻译，见 5.2）；而进入 SSE 之后的一切错误都**无法再用 JSON 表达**（响应头已经是 `text/event-stream`），只能发一个 `error` 事件让前端自己读——这就是协议里 `error` 事件的由来。
2. **`res.on('close', …)` 把"连接断开"变成 AbortSignal**（4.6 详述）。
3. **catch 兜底再翻译一次**：service 里 `translateLLMError` 翻译过的错误会原样带 message；这个正则是对"漏网英文"的最后一道防线，保证 `error` 事件里永远是中文。
4. **`write('error', …)` 后 `res.end()`**：错误是终态，连接必须优雅关闭——不 end 的话浏览器会一直等下一个帧，错误提示出不来，连接还挂死占着资源。

### 4.3 `askAndStream` 主链路：①～⑦ 逐段拆解

进 service。方法签名在 4.1 看过，现在按代码顺序走七步（编号与源码注释一致）。前三步在第 04 章已经见过大半，这里快速带过、把重点放在"流式"相关的新内容。

**开头：鉴权归属 + 参数兜底 + 模型目标解析**

```ts
const session = await this.getSession(userId, sessionId);   // 归属校验：查不到=404
const images = (imageDataUrls ?? []).filter((u) => !!u && u.length > 0);
// 只发图片（不带文字）也允许：content 为空但有图片
if (!(question ?? '').trim() && images.length === 0) {
  throw new BadRequestException('请填写问题或粘贴/上传图片');
}
const useKnowledgeBase = session.useKnowledgeBase !== false; // 兼容旧数据（列默认 true）
const kbIds = session.knowledgeBases.map((k) => k.knowledgeBaseId);

// 模型目标（BYO 强依赖）：会话绑定的配置（含选中的模型名）→ 用户的默认配置 → 都没有则提示先绑定 Key。
const target =
  (await this.modelConfigService.resolveForChat(userId, session.modelConfigId, session.model))
  ?? (await this.modelConfigService.resolveDefaultForUser(userId));
if (!target) {
  writer('error', {
    message: '使用前请先在「模型配置」里绑定你自己的大模型 API Key（设置 → 模型配置，或对话页右上角「模型」入口）。绑定后本会话所有 AI 消耗都由你的 Key 承担。',
  });
  return;
}
```

BYO（Bring Your Own Key）贯穿本项目的对话链路：**系统不提供兜底模型**，目标解析是"会话绑定的配置 → 用户默认配置"两级，都没有就直接发 `error` 事件并 return——注意这里用的是**事件而非抛异常**：用户没绑 Key 是业务常态而非服务器故障，用 SSE `error` 事件 + 前端提示条比抛 500 友好得多（而且此时 SSE 头已发出，也抛不了 JSON 错误了）。

**视觉模型自动路由**（第十节详述）：当 `images.length > 0` 但当前模型名不含视觉关键字（`isVisionModelName` 启发式判断）时，用 `resolveVisionForUser` 找用户配置里的视觉模型，**只替换这一次调用的 target**，不改变会话绑定。

**① 历史对话：先倒序取最近 N 条，再反转回正序**

```ts
const history = await this.prisma.chatMessage.findMany({
  where: { sessionId },
  orderBy: { createdAt: 'desc' },
  take: HISTORY_ROUNDS,        // = 6（最近 3 轮）
});
history.reverse();
```

源码注释把这里的坑写得明明白白：**不能 `orderBy: asc + take`**——那会取到"最早的 N 条"，上下文会越聊越旧。必须先 `desc + take 6` 拿最新的 6 条，再 `reverse()` 回时间正序喂给 Prompt（第九节详述）。

**② 多轮查询改写（有历史且需要检索时才调用）**：`rewriteQuery` 用最近 6 条历史把"它的原理是什么"改写成独立完整的问法，改写**只影响检索**，回答仍用用户原问题（第 04 章 §7.3 已详述，此处不再展开）。

**③ 检索 + 联网，完成后立刻发 `sources`**（本章第三节讲的"来源先行"就在这里落地）：

```ts
const kbScope = kbIds.length ? kbIds : undefined;
const canRetrieve = question.trim().length > 0;   // 只发图片（无文字）时不检索
let kbSources: RetrievalSource[] = [];
let retrievalMode: 'fulltext' | 'retrieval' | 'none' = 'none';
if (useKnowledgeBase && canRetrieve) {
  if (kbIds.length) {
    // 绑定明确知识库：先试全文（P0，04 章 §10.1）→ 超阈值走 retrieveWithHyde
    const ft = await this.ragService.loadFulltext(userId, kbIds, this.fulltextMaxChars);
    if (ft.sources.length > 0) {
      kbSources = ft.sources;
      retrievalMode = 'fulltext';
    } else {
      kbSources = await this.retrieveWithHyde(userId, searchQuery, kbScope, target, sessionId);
      retrievalMode = 'retrieval';
    }
  } else {
    // 未绑定知识库 = 检索该用户全部知识库（范围不可控，不做全文）
    kbSources = await this.retrieveWithHyde(userId, searchQuery, kbScope, target, sessionId);
    retrievalMode = 'retrieval';
  }
}
const webSources =
  useWebSearch && canRetrieve ? await this.webSearchService.search(searchQuery) : [];
writer('sources', { kb: kbSources, web: webSources, mode: retrievalMode });
```

一个诚实的技术观察（源码注释 vs 实现）：代码注释写着"全文/检索自动分流…联网搜索并行"，但**实现是顺序 await**——联网搜索要等知识库检索整条链（含可能触发的 HyDE 兜底）走完才开始。两路其实只共用 `searchQuery`，互不依赖，想摊薄延迟可以用 `Promise.all` 并行；目前顺序执行是"可以优化但没优化"的状态。读源码时留意这类"注释描述意图、实现留了余地"的地方，比照搬代码更有收获。

**④ 落库用户消息（含图片 data URL 数组）**

```ts
const savedUserMsg = await this.prisma.chatMessage.create({
  data: {
    sessionId, role: 'user',
    content: sanitizeControlChars(question),   // ★ \u0000 清洗：PG text 禁止 NUL
    imageDataUrl: images[0] ?? null,           // 单图兼容字段存第一张
    imageDataUrls: images.length ? JSON.stringify(images) : null,  // 多图数组
  },
});
```

`sanitizeControlChars` 出现在这里不是洁癖：**PostgreSQL 的 text 类型禁止 NUL 字节**，粘贴自外部文本的内容可能夹带 `\u0000`，不洗直接写库会触发 `PG 22P05` 让整条请求崩掉。同一条纪律贯穿全链（检索片段、模型输出在落库前都会再洗一遍）。

**⑤ buildPrompt 组装 + ⑥ 流式生成 + ⑦ 落库助手消息**是本章后半部分的主角，分别拆到第四~五、九~十一节细讲。先给流式部分一个全貌（4.4 逐段注释）。

### 4.4 流式调用 OpenAI：`stream: true` + `for await` 逐块转发

```ts
const answerClient = new OpenAI({ apiKey: target.apiKey, baseURL: target.baseURL });
const abortController = new AbortController();          // ★ 内部控制器
const onAbort = () => abortController.abort();
signal.addEventListener('abort', onAbort, { once: true });  // 外部(客户端断开) → 内部

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
      answer += delta;                    // 本地累积（落库需要完整文本）
      writer('delta', { content: delta }); // ★ 增量转发：只发新吐的这一点
    }
    if (part.usage) {
      usage = part.usage;                 // 流式结束时的 usage chunk
    }
  }
} catch (err) { … } finally {
  signal.removeEventListener('abort', onAbort);
}
```

逐点注释：

1. **`stream: true` 让 API 返回一个异步迭代器**而不是完整 JSON——SDK 底层替你发起了流式请求，把每个分片解码成 `part`。
2. **`for await (const part of stream)` 是消费流的正统姿势**：每次迭代拿到一个增量块，取 `part.choices[0].delta.content`（OpenAI 流式协议里真正的"新文字"在 `delta` 而不是 `message` 里），立刻 `writer('delta', …)` 转发。
3. **`answer += delta` 双轨制**：事件只带增量，但本地要维护完整文本 `answer`——落库、以及将来可能的续写都只需要最终完整版；增量是"传输形态"，全文是"存储形态"，两者职责分明。
4. **`stream_options: { include_usage: true }` 让流式最后一个 chunk 携带 token 用量**（`part.usage`）。不用它的话，流式响应的 token 统计是拿不到的——而数据看板（`stats` 模块）的 Token 统计依赖这条消息落库的 `promptTokens` / `completionTokens` 字段。
5. **`reasoning_effort` 透传**：会话设置的推理等级（low/high/max）只在支持它的模型上生效，代码用展开语法透传给 OpenAI 兼容协议。

### 4.5 客户端断开 → abort，不浪费 token（本节的"为什么"重点）

先想一个问题：**用户点了"停止"或直接关了浏览器，服务器这边正在进行的流式请求该怎么办？**

- 不处理：模型继续吐完整个回答，token 照扣（BYO 场景 = 扣用户的钱），吐完发现连接早断了，白写。
- 处理：把"连接断了"翻译成"取消上游生成"。

实现就是两行注册 + controller 的一行监听：

```ts
// controller：连接一关，触发 abort
res.on('close', () => abortController.abort());
// service：把外部 signal 桥接到 OpenAI SDK 请求自己的 AbortController
const onAbort = () => abortController.abort();
signal.addEventListener('abort', onAbort, { once: true });
```

桥接之后的链条是：**浏览器断开 fetch → Node 触发 `res` 的 `close` 事件 → controller 的 `abort()` → service 监听的 `signal` 变成 aborted → `abortController.abort()` → OpenAI SDK 收到 `signal` 后向上游平台发送取消请求**。整条链路的终点是"上游平台停止计费生成"——这既是省钱，也是礼貌（别让模型为一个已经没人听的观众继续演）。

异常分支怎么区分"客户端主动断开"和"真的出错"？看 catch：

```ts
} catch (err) {
  // 客户端主动断开 → 静默停止，不扣后续 token
  if (abortController.signal.aborted) {
    this.logger.log(`会话 ${sessionId} 被客户端中止`);
    return;                     // ★ 静默 return：不落库、不发 error（没人听了）
  }
  // 模型调用失败 → 回滚刚落库的用户消息（第七节详述）
  await this.prisma.chatMessage.deleteMany({
    where: { id: savedUserMsg.id, sessionId, role: 'user' },
  }).catch(() => undefined);
  const translated = this.translateLLMError(err, images.length > 0);
  throw translated;
}
```

判断依据是**内部那个 `abortController.signal.aborted`**：被 abort 的请求抛出的异常是 `AbortError`，此时不翻译、不回滚、不抛——直接 return。注意一个细节：**这里回滚的是"落库的用户消息"，不是流到一半的助手回答**——助手回答在流式结束（⑦）之前根本还没落库，不存在回滚问题；而用户消息在④就落库了，模型调用失败时它就成了"数据库里有、前端也显示、但永远不会有回答"的半截记录，必须删掉（理由见第七节）。

### 4.6 成功收尾：⑦ 落库助手消息 + token 用量 + 自动标题 + done

```ts
// 流式结束：落库助手消息 + 引用来源（知识库 + 网络）+ Token 用量
const sourcesJson = JSON.parse(
  sanitizeControlChars(JSON.stringify({ kb: kbSources, web: webSources })),
);
await this.prisma.chatMessage.create({
  data: {
    sessionId, role: 'assistant',
    content: sanitizeControlChars(answer),
    sources: sourcesJson,                     // 来源与回答同库：刷新后来源还在
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

1. **来源（sources）是跟随助手消息落库的**（`sources` Json 列）。`sources` 事件虽然早早就发给了前端，但数据库里它属于"这条回答"——刷新页面后重新拉消息，来源面板还在。落库前 `JSON.parse(sanitizeControlChars(JSON.stringify(...)))` 是为了把对象转成**纯 JSON**（兼容各版本 Prisma 客户端的 Json 类型，同时把可能的 NUL 洗掉）。
2. **token 用量随消息存库**：`usage` 来自流式最后一个 chunk（4.4 的 `include_usage`），落进 `promptTokens` / `completionTokens`——数据看板"消耗了多少 token"的数据源头就在这里。
3. **标题是"提问前 20 个字"**而不是调 LLM 生成：`question.replace(/\s+/g,'').slice(0,20)`。对第一问花一次模型调用生成标题太奢侈，截取问题本身既免费又足够表达主题。前端 `onDone` 里 `loadSessions()` 刷新列表，正是为了把这条新标题刷出来。

---

## 五、前端消费：为什么不能用原生 EventSource

后端吐得再漂亮，前端收不下来也是白搭。收 SSE 的"正统"API 是浏览器的 `EventSource`——但本项目用的是 **`@microsoft/fetch-event-source`**。为什么？

### 5.1 原生 `EventSource` 的三个死穴

| 需求 | 原生 `EventSource` | `fetch-event-source` |
|---|---|---|
| 用 **POST** 发请求体（问题内容、图片 data URL） | ✗ 只支持 GET | ✓ `method: 'POST'` + `body` |
| 带自定义 Header（`Authorization: Bearer …`） | ✗ 无法设置任何请求头 | ✓ 支持任意 headers |
| 可控的中止（AbortController） | ✗ 只有 `close()` | ✓ 传入 `signal`，与后端 abort 链路对接 |
| 断线行为 | 自动重连（这里反而是灾难，见 5.3） | `onerror` 里 `throw` 即可禁用重连 |

本项目鉴权走 **JWT：每个请求必须带 `Authorization` 头**，而且提问是 **POST + JSON body**（问题可以长达 40 万字符、还要带 9 张图的 data URL）——原生 `EventSource` 两条都不满足，直接出局。`fetch-event-source` 本质是"用 fetch 实现 SSE 帧解析"：它把 `text/event-stream` 的响应流按 `\n\n` 切帧、处理跨 TCP 包的多字节 UTF-8 分片，然后回调 `onmessage`。

### 5.2 `askQuestion` 逐段注释

```ts
export function askQuestion(
  sessionId: string,
  content: string,
  useWebSearch: boolean,
  signal: AbortSignal,
  callbacks: AskCallbacks,
  imageDataUrls?: string[],
): Promise<void> {
  return fetchEventSource(`/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('accessToken')}`,  // ★ JWT
    },
    body: JSON.stringify({
      content,
      useWebSearch,
      ...(imageDataUrls?.length ? { imageDataUrls } : {}),
    }),
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
        // fetch-event-source 在响应不是 SSE（如 400 JSON 校验错误）时抛 content-type 错，
        // 翻译成可操作的中文提示（真正的错误信息后端会通过 SSE error 事件送达）
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

1. **`onmessage` 里只有一个 `switch`**，对应第三节"单帧结构统一"的协议——后端发什么事件、前端就调哪个回调，类型收口在 `AskCallbacks` 上，`Chat.vue` 只需要提供四个回调。
2. **`onerror` 先判断 `signal.aborted`**：用户主动停止时 abort 会触发 error 回调，但那是"计划内的中断"不是错误，不该弹错误条（8.2 会看到停止后的 UI 逻辑）。
3. **`/Expected content-type/` 翻译**：`fetch-event-source` 收到**非 SSE 的响应**（比如后端在写 SSE 头之前抛了 400 DTO 校验错误、或 404 会话不存在，返回的是 JSON）会抛"Expected content-type"错。真正的错误信息此时在 JSON body 里但它读不到，所以翻译成一个笼统但可操作的中文提示（4.2 提过：校验错误在 SSE 头之前发生，走的就是这条路）。

### 5.3 为什么必须 `throw err` 终止重连

`EventSource` 规范内置**自动重连**：连接意外断开后浏览器会自动重新发起请求。对聊天场景，这是**双向灾难**：

- 如果断线发生在生成中途，自动重连等于**重新发一次提问**——后端会再检索、再落库、再调模型，用户会看到回答从头再流一遍，且历史里多出一条重复的用户消息；
- 更糟的是后端在断线时已经 abort 了原请求（4.5），重连的新请求是全新的第二次生成，**钱付了两份**。

所以 `onerror` 末尾的 `throw err` 是刻意的：**抛异常让 fetch-event-source 认为"这次流不可恢复"，放弃自动重连**。错误提示已经通过 `callbacks.onError` 送达，剩下的事交给用户（手动重试按钮，见第七节）。

---

## 六、渲染性能三板斧：为什么长回答不卡

流式回答对前端渲染的挑战是数学性的：假设模型每秒吐 30 个 token，一个 3000 字回答会触发几百次内容更新。如果每次更新都"把全文重新渲染一遍"，会发生什么？这一节讲三件配套的武器。

### 6.1 第零问题：为什么不能"每个 delta 全量渲染 markdown"

先看流式区是怎么渲染的（`Chat.vue` 模板）：

```html
<div v-else class="markdown-body px-1" @click="handleStreamClick"
     v-html="renderMarkdown(streamContent)" />
```

`v-html` 每次执行都要把**当前的完整文本**过一遍 `renderMarkdown`——而 `renderMarkdown` 背后是 `markdown-it` 全量解析 + `highlight.js` 对每个代码块高亮。如果每个 delta 都来一次，代价是三重：

1. **计算量是 O(n²) 的**：第 k 个 delta 到达时，要重新解析长达 k 段的全文；全部分片加起来，总工作量与"回答长度 × 分片数"成正比。3000 字的回答按每 token 一次算，等于把全文解析了几百遍。
2. **语法高亮会"闪烁"**：代码块刚写到 ```` ```ts ```` 时语法树还不完整，`highlight.js` 每帧都在对**半截代码**做高亮，视觉上是颜色反复跳动。
3. **markdown 结构会"跳动"**：列表符号、表格分隔线、代码围栏在未完成时渲染形态不稳定，用户会看到排版闪变。

结论：**流式期间渲染频率必须从"每个 token 一次"降到"每帧最多一次"**——这就是 rAF 节流。

### 6.2 第一板斧：rAF 节流——把 N 次渲染合并成每帧 1 次

`requestAnimationFrame`（rAF）是浏览器提供的"下一帧绘制前回调"，**与屏幕刷新率同步（通常 60Hz）**。用它做节流的意思是：token 来得再密，**一个 16ms 的帧里最多只刷新一次 DOM**。看 `sendPayload` 里的实现：

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
  if (!streamRaf) streamRaf = requestAnimationFrame(flushStream);  // ② 桶里第一次有货才排一帧
},
```

机制拆开看：

- `onDelta` 的职责被压缩到极致：**拼字符串 + 若本帧还没排过就排一个 rAF**。就算一帧里来了 20 个 delta，也只会在下一帧开始前执行一次 `flushStream`——20 次渲染被合并成 1 次。
- `streamRaf` 这个"有没有排队的帧"标记是关键：`requestAnimationFrame` 每帧最多回调一次，但 `onDelta` 每帧可能来几十次，必须靠这个标记避免一帧里重复排队（那会退化成每个 delta 都渲染）。
- **`flushStream` 里才写 `streamContent.value`**：所有对 Vue 响应式状态的写入都收敛在 rAF 回调里。为什么重要？`streamContent` 一变，模板里 `v-html="renderMarkdown(streamContent)"` 要重跑、自动滚动 watch 要触发（`watch([() => messages.value.length, streamContent], …)`）——这些昂贵副作用都应该"每帧最多一次"。

`onDone` 时的收尾（`Chat.vue`）同样照顾了节流边界：

```ts
onDone: () => {
  if (streamRaf) {                 // ★ 还有一帧没 flush？取消它，直接落最终值
    cancelAnimationFrame(streamRaf);
    streamRaf = 0;
    streamContent.value = pendingStream;
  }
  // 把流式内容转正为一条正式 assistant 消息
  messages.value.push({ id: `local-${Date.now()}-${++localMsgSeq}`, … content: streamContent.value, sources: streamSources.value, … });
  streamContent.value = '';
  streamSources.value = { kb: [], web: [] };
  loadSessions();
}
```

`done` 到达时可能恰好有一帧 `flushStream` 还没执行（`streamRaf ≠ 0`）——直接取消它并手动把 `pendingStream` 的最终值写入，保证"转正的消息内容 = 完整回答"，不丢最后几个字。

**类比**：自来水龙头（delta 流）往水池（`pendingStream`）放水，水位计（屏幕）每秒钟最多看 60 次——无论龙头开多大，抄表员不会更勤快。渲染成本被"抄表频率"锁死，和 token 速率解耦。

### 6.3 第二板斧：渲染缓存——内容不变，绝不重算

rAF 节流解决"流式过程中同一段内容反复渲染"，但还有一个问题：**回答转正后，消息列表每次因其他原因重渲染（滚动、切会话回来、别的状态变化）时，每条历史消息都要重新跑一遍 markdown-it + 高亮吗？** 不。`apps/web/src/utils/markdown.ts` 给 `renderMarkdown` 加了一层模块级缓存：

```ts
// 渲染结果缓存：AI 回答每条消息内容不变就不重复跑 markdown-it + 代码高亮
// （消息组件用 computed 调用本函数，父组件任何状态更新都不会导致已渲染消息重新高亮）
const renderCache = new Map<string, string>();
const RENDER_CACHE_MAX = 200;

export function renderMarkdown(text: string): string {
  const hit = renderCache.get(text);
  if (hit !== undefined) return hit;
  if (renderCache.size >= RENDER_CACHE_MAX) renderCache.clear();   // 简单的容量上限
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

配套在组件层（`ChatMessageItem.vue`）还有一个 **computed 缓存**：

```ts
// 渲染结果缓存：内容不变就不重跑 markdown-it + 代码高亮（父组件重渲染时不再全量重算）
const msgHtml = computed(() => renderMarkdown(props.msg.content));
```

两层缓存各管一段：

- **模块级 `renderCache`（Map）**：以"文本全文"为 key。两条消息内容相同（比如同一段代码被问了两次）第二次直接命中；容量 200 满了就整体清空——简单粗暴但有效，聊天场景的内容基数很小，不需要 LRU 那么精细。
- **组件级 `computed`**：Vue 的 computed 有自身的依赖追踪——只要 `props.msg.content` 没变，computed 不会重新求值，即使父组件（`Chat.vue` 的消息列表）因别的原因重渲染了。两个缓存叠加后：**历史消息的 markdown 解析在其生命周期里只发生一次**。

对照 6.1 的 O(n²) 问题：流式中的回答每帧渲染一次（内容在变，缓存帮不上），但**一旦转正成消息，它的 HTML 就被缓存**——之后滚动、切会话、KeepAlive 恢复，全部命中缓存零开销。缓存是"流结束后"的第二道闸。

### 6.4 第三板斧：事件委托 + 克制滚动，别让"附加工作"偷走帧

主渲染节流了还不够——一次渲染还要连带一堆"附加工作"，每样都可能偷走帧预算：

1. **代码复制按钮用事件委托而不是每块绑监听器**：`Chat.vue` 的流式回答块只有一个 `@click="handleStreamClick"`，靠 `classList.contains('code-copy')` 判断点没点中复制按钮（`ChatMessageItem` 同理）。如果每个代码块都绑一个监听器，几百次渲染就产生几百次监听器重建——事件委托让 DOM 无论多大都只有一层监听。顺带解决了流式期间按钮不可用的历史痛点（生成到一半的代码块也能复制，按钮的"复制"动作只依赖已完成的部分）。
2. **自动滚动只在"用户停在底部"时才生效**：`Chat.vue` 里 `autoScroll` 标志由滚动事件维护（`onMessageScroll`：距底小于 120px 视为"想跟着最新"，否则暂停）。用户翻历史时**绝不强制滚回底部**——这是流式页面最招人烦的行为之一，实现却只是"watch 到内容变化时先查 autoScroll 再决定滚不滚"。
3. **KeepAlive 恢复时的滚动位置恢复**：`savedChatScrollTop` 只在滚动/程序滚底时记录、绝不在地 `deactivated` 里保存（源码注释记录了一个真实事故：组件卸载后 DOM 已脱管，`scrollHeight` 读到 0 会覆盖掉正确值）。

### 6.5 三板斧组合：一段长回答的渲染账本

| 阶段 | 没有三板斧 | 有三板斧 |
|---|---|---|
| 流式 500 个 delta | 500 次全文 markdown 解析，O(n²)，长回答明显卡顿 | ≤ 60Hz 帧率次解析（rAF 合并），每帧最多一次 |
| 回答转正后滚动/切会话 | 每条历史消息重复全量解析 | 模块缓存 + computed 双重命中，零重算 |
| 代码块很多的长回答 | 每块独立监听器 + 每帧重建 | 事件委托，一层监听 |
| 用户翻历史时 | 被自动滚动反复拽回底部 | autoScroll 暂停，滚动自由 |

顺带说明：流式过程中每个 rAF 帧的 `renderMarkdown(streamContent)` 是**没有走缓存**的（内容每帧都变，Map 命中不了，反而会因缓存无限增长而白白占内存）。所以三板斧的分工是：**流式中靠 rAF 限制"解析次数"，转正后靠缓存消灭"重复解析"**——一个管频率，一个管重复。

---

## 七、乐观渲染与失败处理：先上屏，出错再收拾

### 7.1 为什么乐观渲染：聊天必须"零延迟反馈"

用户在输入框敲完回车，期待的是**自己的话立刻出现在对话里**。如果等后端把用户消息落库、甚至等完整轮回答结束才把用户消息画出来，输入与反馈之间会隔着一两秒的空窗——聊天产品里这是致命的"卡顿感"。

乐观渲染（Optimistic UI）的原则：**以本地状态为准先渲染，把"与服务器同步"变成后台职责**。`handleSend` 里用户消息是本地 `push` 出来的：

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
  const payloadImages = [...images];
  const payloadFiles = [...files];
  if (!currentSessionId.value) return;
  if (!isRetry) retryDraft.value = null;   // 新发送：清掉上次的失败草稿

  // 上传文件内容拼进消息（模型据此回答）
  const fileBlock = payloadFiles.length
    ? `\n\n【上传文件内容】\n${payloadFiles.map((f) => `--- ${f.name} ---\n${f.content}`).join('\n\n')}`
    : '';
  const content = question + fileBlock;

  input.value = ''; pendingImages.value = []; pendingFiles.value = [];
  error.value = '';
  streaming.value = true;
  streamContent.value = ''; streamSources.value = { kb: [], web: [] };
  startThinkingTimer();

  // 乐观渲染：用户消息立即上屏（id 唯一，防止与历史消息 key 撞车导致图片 DOM 复用堆叠）
  const optimisticId = `local-${Date.now()}-${++localMsgSeq}`;
  lastOptimisticMsgId.value = optimisticId;
  messages.value.push({
    id: optimisticId,
    sessionId: currentSessionId.value,
    role: 'user',
    content, imageDataUrl: payloadImages[0] ?? null,
    imageDataUrls: payloadImages.length ? payloadImages : null,
    sources: null,
    createdAt: new Date().toISOString(),
  });

  // 发送新问题时强制滚到新问题所在位置（即使用户刚才在翻历史，也要回到最新）
  autoScroll = true;
  await nextTick();
  const el = messageContainer.value;
  if (el) el.scrollTop = el.scrollHeight;

  abortController.value = new AbortController();
  const ac = abortController.value;   // ★ P1-3：局部持有本次请求的控制器
  … // rAF 节流的 pendingStream/flushStream（见 6.2）
  try {
    await askQuestion(currentSessionId.value, content, useWebSearch.value, ac.signal, { …回调… }, payloadImages.length ? payloadImages : undefined);
  } finally {
    stopThinkingTimer();
    // P1-3：Stop 后立刻重发时，旧请求的 finally 晚到不能清掉新流的控制器与状态——
    // 仅当 abortController.value 仍指向本次请求（ac）才复位
    if (abortController.value === ac) {
      streaming.value = false;
      abortController.value = null;
    }
  }
}
```

值得展开的两个设计：

1. **`local-` id 的唯一性不是玄学，是防 DOM 复用的**。模板里消息列表 `v-for="(msg, i) in messages" :key="msg.id"`。Vue 用 key 决定 DOM 复用/重建：**如果两条消息 id 相同，Vue 会以为它们是同一条，直接复用旧 DOM**——对普通文本问题不大，但带图片的消息（img 元素）会因此出现"图片叠在旧消息上、切走后残留"的诡异 bug。所以 `localMsgSeq` 是**模块级自增序号**（跨消息不重复），拼上 `Date.now()` 双保险；这就是源码注释里"保证 local- 消息 id 唯一（消息列表 key 用 id，id 相同会复用 DOM 导致图片堆叠）"的意思。
2. **`finally` 里的 `ac` 身份校验**是停止/重发竞态的保险：用户点停止后立刻再发一条，旧请求的 `finally` 会在新请求已经开始后才执行——如果它无脑复位 `streaming`/`abortController`，会把**新流**的状态清掉。`if (abortController.value === ac)` 保证"只有当我还是当前请求时才复位"。

### 7.3 失败三件套：错误条 + 草稿保留 + 乐观消息回滚

流式请求失败时（`onError`），前端要做三件事：

```ts
onError: (message) => {
  // P2-7：失败时保留本次内容供"重试"（后端已回滚未成功的用户消息，前端可安全重发）
  error.value = message;
  retryDraft.value = { question, images: payloadImages, files: payloadFiles };
},
```

1. **`error.value`**：模板里渲染一条红色错误条（`border-destructive/30`），上面显示翻译好的中文错误；
2. **`retryDraft`**：把这次的内容原样存起来，错误条上出现"重试 / 放弃"两个按钮——**用户辛苦打的字、贴的图、传的文件一个都不丢**；
3. **乐观用户消息的去留**由后端配合：后端在模型调用失败时**回滚了刚落库的用户消息**（4.5 的 `deleteMany`）。为什么必须回滚？试想不回滚：用户点"重试"，后端再落库一条同样的用户消息——刷新页面后历史里出现**两条相同提问**；回滚 + 前端移除乐观消息，重试就是干净的一次重发。

重试与放弃的代码对称：

```ts
/** 失败"重试"：移除失败的乐观用户消息（后端已回滚，不重复），用原内容重新发送 */
async function handleRetrySend() {
  const d = retryDraft.value;
  if (!d || streaming.value) return;
  // 移除失败的乐观用户消息——后端失败时已回滚该消息，不删会残留一条假消息
  if (lastOptimisticMsgId.value) {
    messages.value = messages.value.filter((m) => m.id !== lastOptimisticMsgId.value);
    lastOptimisticMsgId.value = null;
  }
  await sendPayload(d.question, d.images, d.files, true);   // isRetry=true
}

/** 失败"放弃"：清掉草稿与失败的乐观消息 */
function handleDiscardFailed() {
  retryDraft.value = null;
  if (lastOptimisticMsgId.value) {
    messages.value = messages.value.filter((m) => m.id !== lastOptimisticMsgId.value);
    lastOptimisticMsgId.value = null;
  }
  error.value = '';
}
```

注意 `lastOptimisticMsgId` 的引入时机：失败时**只记录 id、不移除消息**（错误条和用户消息同时显示，用户能看到"我说的这句话 + 它失败了"）；只有点"重试"或"放弃"时才移除。配合 4.5 的后端回滚，两端形成一个闭环：

```
失败闭环（重试路径）
前端: onError → 保留 retryDraft + 记录 lastOptimisticMsgId
后端: LLM 调用失败 → deleteMany 回滚用户消息（防刷新后重复）
用户: 点"重试" → 前端移除乐观消息 → sendPayload(…, isRetry=true) 重新走全链路
结果: 无论刷新与否，历史里都只有一条用户提问 + 一次回答
```

### 7.4 一个边界：失败发生在"用户消息还没落库"的阶段怎么办

回滚的注释写得很清楚：

```
// P2-7：模型调用失败 → 回滚刚落库的用户消息（回答没生成，留着会让前端"重试"重复落库）
// 检索阶段失败时用户消息还没建，无需处理；此处只在 LLM 阶段失败时回滚。
```

如果失败发生在检索阶段（④ 落库之前），用户消息**根本还没创建**，前端移除乐观消息即可，后端无事可做；只有 ④ 之后、⑥ 流式阶段失败才需要回滚。这个"回滚点精确对应落库点"的注释，是整段代码最容易读懂的工程说明——**回滚只针对"已经落库但流程没走完"的记录**。

---

## 八、停止生成：AbortController 的完整链路与部分内容保留

### 8.1 从按钮到上游的整条 abort 链

用户点"停止"（输入框的 Stop 按钮）时，前端只有一行：

```ts
function handleStop() {
  abortController.value?.abort();
  …
}
```

这一行 `abort()` 会沿着一整条链条传导（每段都在前面见过，这里串起来）：

```
用户点停止
  → abortController.value.abort()            Chat.vue handleStop
  → fetch-event-source 收到 signal.abort     api/chat.ts askQuestion（传入同一 signal）
  → 浏览器中止 fetch，关闭连接                （HTTP 层）
  → Node 触发 res 的 close 事件               chat.controller.ts
  → controller 的 abort()                     （res.on('close')）
  → service 监听的外部 signal 变为 aborted    chat.service.ts askAndStream
  → abortController.abort()                   （service 内部控制器）
  → OpenAI SDK 向上游平台发取消请求           （不再计费后续 token）
```

**为什么需要两级 AbortController？** 看 4.4 的代码：service 内部 `new AbortController()` 并把自己的监听器挂在传入的 `signal` 上。外部 signal（来自 controller 的 `res.on('close')`）是"连接断开"的抽象，内部 controller 是"取消这次 OpenAI 请求"的抽象——**两层之间用 `addEventListener` 解耦**：将来如果取消原因不止"连接断开"一种（比如管理员强制停止、超时自动取消），只需在外部多触发几次 abort，内部逻辑零改动。

### 8.2 停止后：部分内容保留，但"不落库"

`handleStop` 的完整逻辑：

```ts
function handleStop() {
  abortController.value?.abort();
  // 保留已生成的部分回答：停止后把流式累积的内容落成一条 assistant 消息
  // （否则中止时 onDone 不触发，回答到一半的内容就丢了）
  if (streamContent.value.trim()) {
    messages.value.push({
      id: `local-${Date.now()}-${++localMsgSeq}`,
      sessionId: currentSessionId.value!,
      role: 'assistant',
      content: streamContent.value,      // ★ 已经流出来的部分
      sources: streamSources.value,      // 来源也一并保留
      createdAt: new Date().toISOString(),
    });
    streamContent.value = '';
    streamSources.value = { kb: [], web: [] };
  }
  streaming.value = false;
  stopThinkingTimer();
}
```

三个行为值得逐条理解：

1. **`streamContent` 非空就把部分内容转正成一条 assistant 消息**。为什么要手动转正？因为正常流程里"流式内容转正"发生在 `onDone`（6.2）——而 abort 后 `onDone` **永远不会触发**（后端在中止分支直接 return，不发 done，见 4.5）。不手动处理的话，用户看到的就是"回答消失，只剩自己的问题"——生成了 500 字全白费。所以停止 = **保留已经吐出来的部分**。
2. **这条"半截消息"只存在于前端**。后端在中止分支静默 return，**没有落库任何 assistant 消息**（4.5）。这是刻意的取舍：落库一条"被用户中途打断的不完整回答"，会污染历史数据的完整性（将来重新加载会话时它没有对应的 sources 关联、也没有完整的 token 统计）。代价是：**刷新页面后，这半截回答会消失**——用户消息还在（④ 早已落库），半截回答不在。这是"本地保留 partial、服务器不留半成品"的清晰分工。
3. **`streaming.value = false`** 让输入框恢复可发送状态。而 7.2 的 `finally` 里 `abortController.value === ac` 的身份校验保证：停止后立刻发新消息时，旧请求的收尾不会误清新请求的状态。

### 8.3 离页自动中止：别让后台继续烧 token

`Chat.vue` 在组件真正卸载时（登出/退出）也会 abort：

```ts
// 真正卸载（登出/退出）：中止进行中的 SSE，避免后台继续消耗 token（P1-4）
onBeforeUnmount(() => {
  stopThinkingTimer();
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  abortController.value?.abort();
  abortController.value = null;
});
```

这不是"顺手清理"，而是 **BYO 成本纪律**的延伸：用户离开页面（切到别的路由、登出）时若不断开流，后端会继续生成直到回答结束——在用户自己的 Key 计费模型下，这是**用户的钱在后台悄悄烧**。离页 abort 让"用户不看了 = 不生成 = 不扣费"成为默认行为。

---

## 九、多轮上下文管理：只带最近 3 轮，多了装不下也聊不精

### 9.1 为什么不能把全部历史塞给模型

一个会话可能聊了几十轮、几千字。如果把全部历史都塞进每次请求：

- **token 成本随轮数线性上涨**：聊到第 50 轮时，每问一句都要把前 50 轮的全文重新发给模型一次——在 BYO 场景是用户的账单在涨；
- **上下文窗口有硬上限**：终有一天 `context length exceeded`，整个对话不可用；
- **注意力被稀释**：模型读 50 轮旧账后再回答第 51 个问题，反而抓不住重点。

真实产品通常做**滑动窗口**：只保留最近的 N 轮。本项目把 N 定为 **3 轮（6 条消息）**，常量在 `chat.service.ts` 顶部一行注释讲清：

```ts
const HISTORY_ROUNDS = 6; // 历史对话最多保留最近 3 轮（6 条）
```

### 9.2 取历史的正确姿势：倒序 take 再反转

源码注释记录了最容易写错的地方：

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

直觉上"按时间正序取前 N 条"很自然——但 SQL 里 `ORDER BY createdAt ASC LIMIT 6` 取的是**整个会话最早的 6 条**！消息表是只追加的，最早的记录永远不变——于是聊得越久，这个查询返回的越是开场白，模型永远看不到最近的对话。必须先 `DESC` 拿到最新的 6 条（数据库只需要扫一个倒序索引），再在内存里 `reverse()` 回正序。**方向错了，整个多轮对话就废了。**

### 9.3 同一份历史的两种用法：改写"截断"，Prompt"全量"

历史在 `askAndStream` 里有**两个下游消费者**，截断策略不同：

| 消费者 | 用途 | 截断策略 |
|---|---|---|
| `rewriteQuery(question, history, target)` | 生成独立检索查询（指代消解） | 每条消息 `content.slice(0, 200)`，只取前 200 字符（第 04 章 §7.2） |
| `buildPrompt(…)` 的 `【历史对话】` 段 | 让模型"记得前面聊了什么"再回答 | 最近 6 条**全量**拼接 |

为什么改写要截断到 200 字符而 Prompt 不截？**职责不同**：改写只需要"上一轮在聊什么主题"这种粗粒度信息，200 字符足够消解"它指什么"，截断省一次小调用的 token；而 Prompt 里模型要真正"读"历史来保持对话连贯，截到 200 字符可能丢掉上一轮回答的实质内容。两条路各自按需裁剪，不搞一刀切。

上下文总量的"软上限"来自三层叠加：

```
历史：最近 3 轮（6 条）           ← 轮数上限，硬性
改写历史：每条再截 200 字符       ← 改写专用
单条用户输入：AskDto 上限 40 万字符 ← 防单条撑爆
单文件提取：30k 字符截断（第 10 节） ← 防文件撑爆
```

即便有这些软上限，仍可能超窗口（比如上一轮的助手回答本身就有 1 万字，3 轮历史 + 新问题超了模型的窗口）——此时由 `translateLLMError` 的 context 分支兜底翻译成中文提示（第十二节），引导用户精简问题或换长上下文模型。**项目没有做"按 token 动态裁剪历史"的精确预算**，而是用"轮数上限 + 出错提示"的组合拳——对多数对话够用，且实现简单、行为可预期。

### 9.4 一个值得注意的结构：历史是"文字段"而不是"多轮消息"

看 `buildPrompt` 里历史与当前问题的拼装方式：

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

const messages = [
  imageDataUrls.length > 0
    ? { role: 'user', content: [ {type:'text', text: userPrompt}, …imageDataUrls.map(u => ({ type: 'image_url', image_url: { url: u } })) ] }
    : { role: 'user', content: userPrompt },
];
```

注意：**最终发给模型的 `messages` 数组里只有一条 user 消息**——历史不是作为多条独立的 OpenAI 消息传入，而是被格式化成一个"文字段"（`用户：…\n助手：…`）嵌在 `【历史对话】` 小节里，与 `【参考资料】`、`【用户问题】` 并列。这是刻意的简化：

- 优点：请求结构固定（system + 单条 user），历史对模型而言是"上下文材料"而非"需要逐轮回应的对话流"，模型不会对旧消息产生额外的"回复冲动"；截图级可复现，也方便调试（一整块文本肉眼可读）；
- 代价：牺牲了 OpenAI API 原生的多轮消息语义（role 轮换能让模型更精确理解"最后一句是用户说的"）。对"参考历史 + 回答当前问题"的 RAG 场景，文字段方案够用且更可控——这是一种**用结构换简单**的工程取舍。

---

## 十、多模态：多图传 data URL，文件提取成文本

### 10.1 图片链路：粘贴/上传 → 压缩 → data URL → JSON body

图片从用户剪贴板/文件选择器到模型，前端在 `Chat.vue` 里做四步：

1. **收集**：`onPasteImage` 读剪贴板里所有 `image/*` 项、`onPickImage` 接收文件选择器结果，都先去重上限 `MAX_IMAGES_PER_MESSAGE = 9`（定义在 `apps/web/src/types/chat.ts`，`Chat.vue` 与输入组件共用，避免硬编码漂移）；
2. **压缩**：`compressImage` 用 canvas 把图片最长边缩到 **1024px**、以 **JPEG 0.8** 质量重新编码，输出 **data URL**（`canvas.toDataURL('image/jpeg', 0.8)`）。

```ts
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1024;
      const scale = Math.min(1, max / Math.max(img.width, img.height));   // 等比缩放
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

**为什么必须压缩？** 三个理由：① **传输**——`AskDto` 单图上限 6,000,000 字符，原始手机照片的 base64（体积再膨胀 ~33%）轻松超限；② **成本**——视觉模型按图像分辨率/token 计费，4K 原图和 1024px 图对"看懂内容"没差别，对账单差别很大；③ **性能**——9 张原图 data URL 会让请求体和消息列表双双臃肿。压缩到 1024px/JPEG 是在"看得清"与"传得起"之间的经验折中。

3. **随消息发送**：`sendPayload` 把 data URL 数组传进 `askQuestion`，最终出现在 POST body 里：

```ts
// api/chat.ts
body: JSON.stringify({ content, useWebSearch, ...(imageDataUrls?.length ? { imageDataUrls } : {}) }),
```

4. **后端 DTO 校验**（`apps/server/src/modules/chat/dto/ask.dto.ts`）：这是数据进业务前的最后一道闸，注意字段的可选性与上限：

```ts
export class AskDto {
  @IsOptional() @IsString({ message: '问题必须是字符串' })
  @MaxLength(400_000, { message: '内容过长' })
  content?: string;                    // 可只发图不带字

  @IsOptional() @IsBoolean({ message: 'useWebSearch 必须是布尔值' })
  useWebSearch?: boolean;

  @IsOptional() @IsString({ message: '图片必须是字符串' })
  @MaxLength(6_000_000, { message: '图片过大' })
  imageDataUrl?: string;               // 单图（兼容旧客户端）

  @IsOptional() @IsArray({ message: '图片必须是数组' })
  @ArrayMaxSize(9, { message: '一次最多 9 张图片' })
  @IsString({ each: true })
  @MaxLength(6_000_000, { each: true, message: '单张图片过大' })
  imageDataUrls?: string[];            // 多图数组
}
```

注意"新旧兼容"的痕迹：`imageDataUrl`（单图）是历史字段，新客户端传 `imageDataUrls`（数组）；controller 里 `dto.imageDataUrls ?? (dto.imageDataUrl ? [dto.imageDataUrl] : undefined)` 做了归一化——**向后兼容旧客户端而不必让它们立即升级**。

### 10.2 视觉模型自动路由：发图时悄悄换模型，文本对话不变

图片能发出去是一回事，**当前模型能不能"看懂"是另一回事**。纯文本模型收到 `image_url` 消息会直接报错（"not a VLM"之类）。本项目的解法是**自动路由**：发图时如果当前模型不支持视觉，就自动换用用户配置里的视觉模型——只在**这一次调用**生效，不改变会话绑定（`chat.service.ts`）：

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

配套的两个"视觉模型判定"实现（注意前后端各有一份正则，启发式一致）：

```ts
// 后端（model-config.service.ts）：模型名含 vision/VL/4V/Omni 等即视为视觉模型
export function isVisionModelName(model: string): boolean {
  return /vision|[-/]vl\b|vl[-.\d]|4v|omni|glm-4v|internvl|minicpm/i.test(model);
}
```

```ts
// 前端（Chat.vue，用于发图前提示）：与后端一致
const VISION_RE = /vision|[-/]vl\b|vl[-.\d]|4v|omni|glm-4v|internvl|minicpm/i;
```

而 `resolveVisionForUser` 的搜索策略是"遍历用户全部配置 × 每配置的模型列表，命中视觉关键字即返回，默认配置优先"——模型名是用户自己填的（BYO），系统只能靠命名启发式猜哪个能看图，猜错也没关系：路由失败时 `translateLLMError` 的图片分支会把上游报错翻译成"请切换到支持视觉的模型"（第十二节）。

前端在发图前还有一个**预报 toast**（`sendPayload` 开头）：

```ts
// 发图提示：当前模型不支持视觉但用户配置里有视觉模型 → 后端会自动路由
if (payloadImages.length > 0 && activeModelId.value && !VISION_RE.test(activeModelId.value)) {
  const v = modelConfigs.value.find((c) => VISION_RE.test(c.model));
  if (v) toast.info(`图片将自动使用视觉模型 ${v.model} 识别，文字对话仍用当前模型`);
}
```

用户在点发送的瞬间就知道"图片走视觉模型、文字走原模型"——**自动路由不能是黑盒**，否则用户会困惑"为什么这次的回答风格/模型变了"。

### 10.3 视觉消息的 OpenAI 格式 & 只发图时的兜底指令

`buildPrompt` 里图片消息用 OpenAI 兼容协议的**视觉消息格式**：`content` 不再是字符串，而是一个数组（文字 + 多张 `image_url`）：

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

两个细节：① data URL（`data:image/jpeg;base64,…`）本身就是合法的 `image_url`，**不需要额外上传到对象存储**——图片跟消息同生共死，随请求体走，删了消息图片也没了，无孤儿文件；② 用户**只发图不带文字**时，`【用户问题】` 小节是空的，若不兜底，模型会收到一个空标题然后一脸茫然——所以补了一句明确指令：

```ts
(question ?? '').trim() ||
  (imageDataUrls.length > 1 ? '请描述这些图片的内容' : '请描述这张图片的内容'),
```

### 10.4 文件上传：提取成文本，拼进问题，随消息走

图片走"视觉通道"，普通文件（txt/代码/PDF/Word）走另一条路：**先在后端提取文本，再把文本拼进消息内容**。后端入口是独立的 `POST /chat/extract-file`（不在提问端点里，因为上传是 multipart 而提问是 JSON）：

```ts
@Post('extract-file')
@UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
@ApiOperation({ summary: '提取上传文件文本（文本/代码/PDF/Word，供对话上下文）' })
extractFile(@UploadedFile() file: Express.Multer.File) {
  return this.chatService.extractFile(file);
}
```

`chat.service.ts` 的 `extractFile` 核心逻辑：

```ts
async extractFile(file: Express.Multer.File | undefined) {
  if (!file) throw new BadRequestException('未收到文件（multipart 字段名应为 file）');
  if (file.size === 0) throw new BadRequestException('文件内容为空');
  // 修复 multipart 中文文件名乱码（busboy 按 latin1 解码，与知识库上传同一处理）
  const filename = fixMojibakeFilename(file.originalname);
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

这条链复用了**第 03 章文档入库的解析工具**（`document-parser` 的 `detectFileType` / `extractText` / `cleanText`）——同一个 PDF 解析器，知识库入库用、对话传文件也用，一处实现处处受益。文件被提取后：

- 前端（`Chat.vue` 的 `onPickFile`）**先做 20MB 本地预检**（与后端 `FileInterceptor` 限制一致，超限直接 toast 拒绝、不走网络），再调 `extractFileText(f)`（60 秒超时），拿到 `{ filename, content, truncated }`；
- `truncated` 为真时 toast 告知"已截断（仅保留前 3 万字符）"——**明确告知截断，避免用户误以为模型看到了全文**；
- 发送时文件内容拼进消息文本（`sendPayload`）：

```ts
const fileBlock = payloadFiles.length
  ? `\n\n【上传文件内容】\n${payloadFiles.map((f) => `--- ${f.name} ---\n${f.content}`).join('\n\n')}`
  : '';
const content = question + fileBlock;
```

`【上传文件内容】` 这个标记不是给人看的格式，是给**前后端切分逻辑**用的协议：发送时前端把文件块拼在问题后面；渲染时 `ChatMessageItem.vue` 用 `content.indexOf('【上传文件内容】')` 把消息切成"问题正文"和"文件块"两段——问题显示在气泡里、文件块渲染成可点击的 file chip（点击在右侧打开内容预览），**绝不把几十 KB 文件内容整屏铺在对话里**；"分支"（基于某条回答开新会话）时则把文件块从 seed 消息里剥掉，避免污染新会话。

### 10.5 一条消息里的三种内容，如何各归其位

把 10.1~10.4 收拢，一条用户消息在 UI 上可能同时包含三种内容，`ChatMessageItem.vue` 的模板展示了它们的渲染分工：

| 内容 | 传输形态 | 渲染 |
|---|---|---|
| 图片 | `imageDataUrls`（data URL 数组，落库 JSON 列） | 网格缩略图（单图 / 多图两列），点击可看原图 |
| 上传文件 | 提取文本拼进 `content` 的 `【上传文件内容】` 段 | 解析出 `{name, content}` 列表 → file chip → 右侧预览抽屉 |
| 文字问题 | `content` 的开头部分（`msgHead` 切片） | 普通气泡文本 |

渲染前还有一道**防御性解析**（`ChatMessageItem.vue` 的 `imgList`）：`imageDataUrls` 在旧数据/未更新后端时可能是 **JSON 字符串**而不是数组——直接 `v-for` 一个字符串会把字符串**按字符拆成无数张"图片"**（源码注释：图片叠满屏幕）。统一 `Array.isArray` 检查 + 失败兜底空数组，新旧数据通吃。

---

## 十一、联网双来源与"未检索到资料"的诚实披露

### 11.1 开关与 Tavily：锦上添花必须"可降级"

联网检索的开关在输入框上（`useWebSearch`），状态用 `localStorage` 持久化（`kb-use-web-search`），默认关。它控制 `AskDto.useWebSearch`，一路传到 `askAndStream`。

后端实现 `web-search.service.ts` 只有 100 行，选型与降级哲学写在类注释里：

```ts
/**
 * 为什么选 Tavily：
 * - 专为 LLM/Agent 设计的搜索 API，返回干净的"标题+URL+内容摘要"，不需要自己解析 HTML
 * - 免费额度 1000 次/月，学生项目够用
 * - 对比：自己抓 DuckDuckGo/Bing 不稳定且可能被反爬
 *
 * 设计：key 在 .env 的 TAVILY_API_KEY 配置；
 * 未配置 key 时 search() 返回空数组，问答自动退化为"纯知识库检索"，不影响主流程
 */
```

`search` 的实现延续了第 04 章反复出现的"**锦上添花型组件必须可降级**"哲学：

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
      .filter((r) => r.title && r.url && r.content)   // 缺字段的条目直接丢
      .map((r) => ({ title: r.title!, url: r.url!, content: r.content!, score: r.score }));
  } catch (err) {
    this.logger.warn(`联网搜索异常: ${(err as Error).message}`);
    return [];                        // 任何异常 → 空数组，绝不阻断问答
  }
}
```

Tavily 的返回值是"标题 + URL + 干净摘要"而不是原始 HTML——**搜完就能直接喂 Prompt，不用自己解析网页**，这是它被选中的核心原因（对比自建爬虫要处理反爬、页面结构漂移、正文提取质量）。类里还有一个 `extract(url)` 方法（Tavily Extract API）供**自主研究 Agent 精读网页正文**用，第 06 章会再见到它。

注意 `WebSource` 的字段与知识库来源完全不同：`{ title, url, content, score? }`——它有 URL，因为网络资料要**可点击核实**；它没有 `chunkIndex`/`documentId`，因为网页没有"第几段"的概念。

### 11.2 双来源如何同屏：一个 sources 事件，两套展示

前端收到 `sources` 事件后，来源数据进入 `streamSources = { kb, web }`。生成期间的小字提示（`Chat.vue` 模板）：

```html
<div v-if="streamSources.kb.length || streamSources.web.length" class="mt-2 text-xs text-muted-foreground">
  已检索到知识库 {{ streamSources.kb.length }} 条
  <template v-if="streamSources.web.length"> + 网络 {{ streamSources.web.length }} 条</template>
  ，正在生成回答
</div>
```

回答完成后来源随消息转正，由 `ChatSourcePanel.vue` 渲染成一个可折叠面板（`<details>`）：标题是"引用来源（知识库 X 条 · 网络 Y 条）"，内部上下两段——**📚 知识库**（每条显示文件名 + 相似度 + 内容预览，点击触发 `open-source` 事件 → 打开 `DocPreviewDrawer` 定位到文档原文第 N 段）和 **🌐 网络**（每条是带链接的标题，点击新标签页打开原始网页）。

```html
<summary class="cursor-pointer font-medium text-muted-foreground">
  引用来源（知识库 {{ sourcesKb(props.sources).length }} 条
  <template v-if="sourcesWeb(props.sources).length"> · 网络 {{ sourcesWeb(props.sources).length }} 条</template>）
</summary>
```

相似度的显示有一个与第 04 章呼应的细节——`similarity: null`（符号/全文来源）显示"相关"而不是百分比：

```ts
function similarityPercent(s: number | null): string {
  return s == null ? '相关' : `${Math.round(s * 100)}%`;
}
```

新旧数据兼容也在展示层兜底：`ChatSourcePanel` 和 `ChatMessageItem` 都写了 `sourcesKb()`——旧消息的 `sources` 是**纯数组**（早期只有知识库），新消息是 `{ kb, web }` 对象，`Array.isArray(s) ? s : s.kb` 一行兼容两个时代。

**为什么双来源不合并成一个列表？** 因为两者的"核实路径"不同：知识库来源是私有资料，点击跳回**文档原文段落**（`DocPreviewDrawer` 按 `documentId + chunkIndex` 定位）；网络来源是公开网页，点击跳到**外链网页**。混在一个列表里会让"点击去哪"的预期混乱——分栏展示，各点各的。

### 11.3 "未检索到知识库资料"的三层诚实披露（本节的灵魂）

第 04 章 §10.2 讲过"无资料兜底"的防线一（Prompt 层）与防线二（前端层），本章从"对话引擎全链路"的角度把它串完，因为**这套披露正好横跨本章讲过的所有环节**——检索结果（sources 事件）、Prompt 组装（buildPrompt）、落库（sources 列）、渲染（ChatMessageItem）。

后端 `buildPrompt` 按四种模式切系统提示词，每种模式都有对应的"引用纪律"：

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

三处都指向同一个核心纪律：**可以基于任何可得资料回答，但引用必须实名（[来源N] 与资料一一对应），没有资料时不许假装有**。

系统提示词之外，**有资料才写 `【参考资料】` 小节**（`kbText` / `webText` 的组装），完全没检索到就整个省略——"不写这一节"本身就是一种诚实：不给模型任何"假装有资料可引"的由头。资料条目的标签也有讲究：

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

模型据此在正文里写 `[来源1]`，读者顺着编号回来源面板看是**哪一段**——`chunkIndex + 1` 的 +1 是因为库里的段序号从 0 开始而人类从 1 开始数。

双保险披露的最后一块在 UI（`ChatMessageItem.vue`）：当一条助手消息**用了知识库模式、sources 非空、但 kb 与 web 都是 0 条**时，渲染一个虚线提示框，把"这回答没有资料支撑"钉在屏幕上：

```html
<p v-if="props.msg.role === 'assistant' && props.msg.sources &&
          sourcesKb(props.msg.sources).length === 0 &&
          !hasWebSources(props.msg.sources) && props.useKnowledgeBase"
   class="mt-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
  ⚠️ 未检索到知识库资料，以上回答基于模型自身知识（可在知识库补充相关文档后重问）
</p>
```

三层防线各管一件事：

| 层 | 位置 | 手段 | 管什么 |
|---|---|---|---|
| 第一层：Prompt 纪律 | `buildPrompt` 系统提示词 | 允许基于自身知识回答 + 必须开头标注 + 严禁编造 [来源N] | 约束模型"嘴上"诚实 |
| 第二层：UI 兜底 | `ChatMessageItem` 虚线框 | 0 引用时钉一句"未检索到知识库资料，以上回答基于模型自身知识" | 即使模型忘了标注，用户也分得清 |
| 第三层：引用纪律 | `【参考资料】` 组装 | 有资料才写参考资料节、资料里没有的明确说"未找到相关内容" | 有资料也不许超范围编造 |

这套披露与第 04 章的门控是一枚硬币的两面：**门控负责"不让不可靠的资料进 Prompt"，披露负责"让没有资料这件事本身可见"**——用户永远不会把"模型自由发挥"误认成"有出处的回答"。

---

## 十二、错误翻译：把上游英文错误变成中文行动指南

### 12.1 为什么必须翻译：用户不该看到 SDK 的报错原文

对话链路里出错最多的环节是**调模型那一下**——而 OpenAI 兼容 SDK 抛出的错误长这样：

```
400 Model does not exist: 'deepseek-chat-extra'. ...
429 Too Many Requests ...
```

用户是中文产品用户，看到英文堆栈只会困惑；更要命的是很多错误**不是用户能修的**（比如模型名与平台不匹配），需要告诉用户**去哪改**。所以 `chat.service.ts` 的 `translateLLMError` 不只是翻译，而是把错误**映射成可操作的中文行动指南**。

### 12.2 translateLLMError 分类表与逐段代码

先归一化：把状态码和 body 文本拼成小写串，方便统一正则匹配：

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

分类逻辑（顺序很重要，**特例在前、泛例在后**）：

| 匹配条件 | 翻译结果 | 用户该做什么 |
|---|---|---|
| 带图 + `400/422` 或含 `not a vlm / vision language model / image` | 当前模型不支持图片…请切换到支持视觉的模型 | 换视觉模型 / 检查模型名与平台匹配 |
| `401` 或含 `invalid api key / authentication / unauthorized` | API Key 无效或已失效 | 到「模型配置」检查 Key 或重新绑定 |
| `402` 或含 `insufficient / balance / quota / payment` | 账户余额不足 | 去对应平台充值 |
| `429` 或含 `rate limit / too many requests` | 请求过于频繁（限流） | 稍等几秒再试 |
| 含 `model does not exist / no such model / invalid model` | 模型名不存在：平台和模型名必须配套 | 修正模型名（附平台模型名示例） |
| 含 `context / too long / maximum length / token.*limit` | 对话内容超出模型上下文长度 | 精简问题 / 减少历史 / 换长上下文模型 |
| 含 `expected content-type` 且非 500 | 带出上游 JSON 错误原文 | 看具体错误 |
| 其余 | 通用兜底（含 HTTP 状态码） | 检查 Key / 模型名 / 余额 / 视觉模型 |

对应代码（注意每个分支都命中后立刻 return，把"最可能的原因"排在前面）：

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

两个值得学习的细节：

1. **正则匹配比只信状态码更稳**。很多上游（尤其走代理网关时）状态码不标准（400 也可能是 Key 错），所以每个分支都是"状态码 **或** 文本命中"双保险；`raw` 统一 `toLowerCase()` 防止大小写漏网。
2. **兜底不是空泛的"服务器错误"**，而是"HTTP 状态码 + 常见原因清单 + 截断到 300 字符的原始信息"——宁可让用户看到一条长但信息完整的提示，也不给一句查不了原因的废话。

### 12.3 错误翻译的完整链路：三层各守一段

把错误翻译在整个链路里串起来（每个环节都在前面出现过，这里是全景）：

```
第 1 层：service 的 translateLLMError
    流式 catch → 非 abort 异常 → 翻译成中文 BadRequestException → throw
第 2 层：controller 的 catch
    翻译过的直接透传；漏网的英文再用正则兜底翻一次 → write('error', { message }) → res.end()
第 3 层：前端 askQuestion 的 onerror（content-type 翻译）
    后端在写 SSE 头之前抛的错误（DTO 校验 400 / 会话 404）返回 JSON → fetch-event-source
    抛 "Expected content-type" → 翻译成"请求未正常建立（响应格式异常）…"
```

第 2 层的正则（`/Expected content-type|not a VLM|Model does not exist|invalid api key|insufficient.*balance/`）是 service 翻译的**补网**：万一有路径漏过 `translateLLMError`，controller 保证 `error` 事件里绝不出现英文。三层翻译的最终效果是：**无论错误发生在 SSE 头之前还是之后、无论被哪一层接住，用户看到的永远是中文、可操作、指向「模型配置」的提示**。

---

## 动手实验

> 先决条件：项目在本机跑通（第 00 章步骤），已绑定可用的大模型 Key，知识库里至少有一篇文档。本章实验全部在**浏览器 DevTools** 里完成，不需要改代码。

### 实验 A：在 Network 面板里"逐帧"看 SSE 事件流

1. 打开对话页，F12 打开 DevTools → Network 面板，勾选 Filter 输入 `messages`（或直接找 `/api/chat/sessions/` 那条请求）；
2. 清空面板，发一个问题（建议带上"开启联网"或问一个知识库问题，这样 `sources` 会有内容）；
3. 点击这条请求，切到 **Response** 标签（Chrome 新版对 SSE 有专门的 EventStream 视图；没有的话看原始 Response）。你会看到响应体**持续追加**，顺序应严格是：
   - 第一个事件 `"event":"sources"`，data 里有 `kb`（或 `web`）数组和 `mode`——**先于任何正文到达**；
   - 然后是一长串 `"event":"delta"`，每个 data.content 只有一小段增量文字；
   - 最后 `"event":"done"`；
4. 对照第三节 3.4 的报文格式，确认每个事件之间有空行（`\n\n` 帧分隔）；
5. **观察首帧时序**：记下 `sources` 到达的时间戳，再记下第一个 `delta` 的时间戳——两者之间隔着的就是"检索完成后、模型 prefill"的时间，这正是"来源先行"设计让用户不干等的时段；
6. 再看请求的 **Headers**：确认响应头里有 `Content-Type: text/event-stream`、`Cache-Control: no-cache`、`X-Accel-Buffering: no`，状态码是 200（而不是 NestJS 默认的 201）——验证 2.2 讲的四个头。

### 实验 B：F12 打断点，看 rAF 节流把 N 次 delta 合并成 1 次渲染

1. Sources 面板里打开 `apps/web/src/views/Chat.vue`（源码映射可用时直接定位；否则在 `flushStream` 函数体那一行下断点，可用 Ctrl+P 搜文件名）；
2. 在 `flushStream` 里 `streamContent.value = pendingStream` 那行**打断点**，同时在 `onDelta` 回调里 `pendingStream += delta` 那行也打断点；
3. 发一个长问题（让模型输出几百字）。观察调用规律：
   - `onDelta` 的断点**一帧内会被命中很多次**（token 密集到达）；
   - 而 `flushStream` 的断点**每帧最多命中一次**（60Hz 上限）；
   - 数一下：比如一秒钟内 `onDelta` 命中了 30 次，`flushStream` 只命中约 60 次以内（实际取决于生成速度），**渲染次数被锁死在帧率，与 token 速率解耦**；
4. 临时验证"如果不节流会怎样"：把 `onDelta` 里改成直接 `streamContent.value += delta`（去掉 rAF 合并），再发一次长回答，观察回答生成期间页面是否明显变卡、代码块高亮是否闪烁——然后改回来。**对比是理解"为什么不能每 token 全量渲染"最好的方式**；
5. 附带观察：把断点下在 `ChatMessageItem.vue` 的 `msgHtml` computed 上，回答转正后**反复滚动、切换会话再切回来**，`renderMarkdown` 不会对同一内容二次执行（模块级缓存命中）——验证 6.3。

### 实验 C：回答到一半点停止，观察整条 abort 链

1. 后端终端保持可见（`pnpm --filter @app/server start:dev` 的日志窗口）；
2. 发一个长问题，回答流到一半时点输入框的**停止**按钮；
3. 观察三个现象：
   - 前端：已经生成的部分文字**留在屏幕上**并转正为一条助手消息（没有消失），输入框恢复可发送——验证 8.2；
   - 后端日志：出现 `会话 <id> 被客户端中止`（`chat.service.ts` 里 abort 分支的 logger）——验证"客户端断开被识别为主动中止而不是错误"；
   - 刷新页面：这条**半截回答消失**（后端没落库），但你的**问题还在**（用户消息在生成前就落库了）——验证 8.2 说的"半截回答只存在于前端"；
4. 再试"停止后立刻重新发一条"：确认新回答正常流式、旧请求的收尾没有把新请求的状态清掉（7.2 的 `ac` 身份校验在起作用——如果清掉了，新流的停止按钮会失灵）；
5. 最后试一次**开着回答直接刷新/切走页面**：后端日志同样出现"被客户端中止"（`onBeforeUnmount` 的离页 abort，8.3）——确认"用户不看了 = 不生成 = 不扣费"。

---

## 本章自测

1. 为什么"流式回答"用 SSE 而不是 WebSocket？部署到 Nginx 时如果不做任何配置会发生什么，`X-Accel-Buffering: no` 解决了什么？（🎯 面试必背）
2. 前端为什么不用原生 `EventSource` 而是 `fetch-event-source`？`onerror` 末尾的 `throw err` 为什么是刻意的？
3. SSE 协议里四个事件 `sources` / `delta` / `done` / `error` 分别在什么时候发出？为什么"检索结果（sources）要先于正文（delta）"送达？（🎯 面试必背）
4. 流式渲染的"三板斧"是哪三件？为什么不能每个 delta 都全量跑一遍 markdown-it + 代码高亮？（提示：从计算量 O(n²)、语法高亮闪烁、markdown 结构跳动三个角度答）
5. 后端在流式失败时为什么要回滚"刚落库的用户消息"？停止生成（abort）时为什么**不回滚**它、也**不落库**半截回答？前端停止后如何保证部分内容不丢？
6. 用户只发图片（不带文字）时，后端做了哪几件事让请求能成功？（提示：视觉模型自动路由、Prompt 兜底指令、DTO 的 content 可选）；如果用户没配置视觉模型，错误会怎么被翻译、提示用户做什么？

---

## 本章小结

现在你应该能完整画出"一条回答是怎么流出来的"：**POST 进来 → controller 校验归属、写好四个 SSE 头 → service 解析 BYO 目标、取 3 轮历史、改写查询 → 检索知识库（可并行联网）→ `sources` 事件先行 → 落库用户消息 → `buildPrompt` 把"参考资料 + 历史 + 当前问题"组装成一条消息 → OpenAI `stream: true` + `for await` 把每个增量块转成 `delta` 事件 → 客户端断开时 abort 不浪费 token → 流完落库助手消息 + 来源 + token 用量 → `done` → 前端 rAF 节流 + 渲染缓存把它流畅画出来**。

这一章反复出现的几条设计主线值得记住：**单向流用 SSE、双向才用 WebSocket**（协议选型看方向）；**事件协议要简单统一**（`{event, data}` 单帧结构）；**断线 = 中止 = 不扣费**（AbortController 全链路）；**渲染成本要锁在帧率上**（rAF）+ **锁在缓存上**（Map + computed）；**乐观渲染必须配后端回滚**（两端对账才不会重复）；以及贯穿全书的**诚实披露**——模型可以说"没检索到资料"，但绝不许假装引用了资料。

下一章，我们把"回答"升级成"研究报告"：当用户丢给系统一个主题、需要拆解成多个子问题逐一检索撰写时，几秒钟的 SSE 流就撑不住了——那是第 06 章 BullMQ 长任务编排的舞台。
