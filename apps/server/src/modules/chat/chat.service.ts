import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import OpenAI from 'openai';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RagService, RetrievalSource } from './rag.service';
import { WebSearchService, WebSource } from './web-search.service';
import { ModelConfigService, ChatTarget, isVisionModelName } from '../models/model-config.service';
import { CreateSessionDto } from './dto/create-session.dto';

interface StreamWriter {
  (event: 'sources' | 'delta' | 'done' | 'error', data: unknown): void;
}

const HISTORY_ROUNDS = 6; // 历史对话最多保留最近 3 轮（6 条）

/**
 * 对话服务：会话管理 + RAG 问答编排
 * 流程：检索 → 组装 Prompt → DeepSeek 流式 → 通过 writer 输出 SSE 事件
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private prisma: PrismaService,
    private ragService: RagService,
    private webSearchService: WebSearchService,
    private modelConfigService: ModelConfigService,
  ) {}

  // ==================== 会话管理 ====================

  async createSession(userId: string, dto: CreateSessionDto) {
    const kbIds = dto.knowledgeBaseIds?.length ? dto.knowledgeBaseIds : undefined;
    const useKnowledgeBase = dto.useKnowledgeBase ?? true; // 默认使用知识库
    // 校验归属：绑定的知识库必须都属于当前用户（防止绑定他人知识库），否则 404
    if (kbIds) {
      const owned = await this.prisma.knowledgeBase.findMany({
        where: { id: { in: kbIds }, ownerId: userId },
        select: { id: true },
      });
      if (owned.length !== new Set(kbIds).size) {
        throw new NotFoundException('知识库不存在');
      }
    }
    // 模型配置归属校验（BYO key：只能用自己的配置）
    let modelConfigId: string | null = null;
    if (dto.modelConfigId) {
      const target = await this.modelConfigService.resolveForChat(userId, dto.modelConfigId);
      if (!target) throw new NotFoundException('模型配置不存在');
      modelConfigId = dto.modelConfigId;
    }
    return this.prisma.chatSession.create({
      data: {
        ownerId: userId,
        title: dto.title || '新对话',
        useKnowledgeBase,
        modelConfigId,
        ...(kbIds
          ? { knowledgeBases: { create: kbIds.map((id) => ({ knowledgeBaseId: id })) } }
          : {}),
      },
      include: {
        knowledgeBases: { select: { knowledgeBase: { select: { id: true, name: true } } } },
        modelConfig: { select: { id: true, name: true, model: true, baseURL: true } },
      },
    });
  }

  /** 修改会话绑定的模型配置（null = 回退系统默认） */
  async updateSessionModel(userId: string, sessionId: string, modelConfigId?: string | null) {
    await this.getSession(userId, sessionId);
    let next: string | null = null;
    if (modelConfigId) {
      const target = await this.modelConfigService.resolveForChat(userId, modelConfigId);
      if (!target) throw new NotFoundException('模型配置不存在');
      next = modelConfigId;
    }
    return this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { modelConfigId: next },
      include: {
        knowledgeBases: { select: { knowledgeBase: { select: { id: true, name: true } } } },
        modelConfig: { select: { id: true, name: true, model: true, baseURL: true } },
      },
    });
  }

  /** 我的会话列表（带消息数、最后一条消息预览、绑定的知识库）；q 时按标题/消息内容全文检索 */
  async listSessions(userId: string, q?: string) {
    const keyword = q?.trim();
    const sessions = await this.prisma.chatSession.findMany({
      where: keyword
        ? {
            ownerId: userId,
            OR: [
              { title: { contains: keyword, mode: 'insensitive' } },
              // 消息内容命中：检索该用户所有会话的消息（chat_messages.content 有 pg_trgm GIN 索引）
              { messages: { some: { content: { contains: keyword, mode: 'insensitive' } } } },
            ],
          }
        : { ownerId: userId },
      include: {
        _count: { select: { messages: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true } },
        knowledgeBases: { select: { knowledgeBase: { select: { id: true, name: true } } } },
        modelConfig: { select: { id: true, name: true, model: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: keyword ? 50 : undefined, // 搜索结果限定条数，避免超大列表
    });
    return sessions;
  }

  /** 获取会话并校验归属（带绑定的知识库 id，供检索范围使用） */
  async getSession(userId: string, sessionId: string) {
    const session = await this.prisma.chatSession.findFirst({
      where: { id: sessionId, ownerId: userId },
      include: { knowledgeBases: { select: { knowledgeBaseId: true } } },
    });
    if (!session) {
      throw new NotFoundException('会话不存在');
    }
    return session;
  }

  async getMessages(userId: string, sessionId: string) {
    await this.getSession(userId, sessionId);
    return this.prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async removeSession(userId: string, sessionId: string) {
    await this.getSession(userId, sessionId);
    await this.prisma.chatSession.delete({ where: { id: sessionId } });
    return { success: true };
  }

  /** 修改会话绑定的知识库（问答范围）：先删旧绑定，再写新绑定（全量替换） */
  async updateSessionKnowledgeBases(
    userId: string,
    sessionId: string,
    knowledgeBaseIds: string[],
    useKnowledgeBase = true,
  ) {
    await this.getSession(userId, sessionId);
    const kbIds = [...new Set(knowledgeBaseIds)]; // 去重
    if (kbIds.length) {
      const owned = await this.prisma.knowledgeBase.findMany({
        where: { id: { in: kbIds }, ownerId: userId },
        select: { id: true },
      });
      if (owned.length !== kbIds.length) {
        throw new NotFoundException('知识库不存在');
      }
    }
    await this.prisma.$transaction([
      // 同时更新"是否使用知识库"开关（false = 纯对话）
      this.prisma.chatSession.update({
        where: { id: sessionId },
        data: { useKnowledgeBase },
      }),
      this.prisma.sessionKnowledgeBase.deleteMany({ where: { sessionId } }),
      ...(kbIds.length
        ? [
            this.prisma.sessionKnowledgeBase.createMany({
              data: kbIds.map((knowledgeBaseId) => ({ sessionId, knowledgeBaseId })),
            }),
          ]
        : []),
    ]);
    return this.getSession(userId, sessionId);
  }

  // ==================== RAG 问答（SSE 流式） ====================

  /**
   * 提问并流式回答
   * @param useWebSearch 是否启用联网检索（并行搜知识库 + 搜网页）
   * @param writer 回调：把事件写进 SSE 响应
   * @param signal 客户端断开时 abort（不浪费 token）
   */
  async askAndStream(
    userId: string,
    sessionId: string,
    question: string,
    useWebSearch: boolean,
    writer: StreamWriter,
    signal: AbortSignal,
    imageDataUrl?: string,
  ) {
    const session = await this.getSession(userId, sessionId);
    // 只发图片（不带文字）也允许：content 为空但有图片
    if (!(question ?? '').trim() && !imageDataUrl) {
      throw new BadRequestException('请填写问题或粘贴图片');
    }
    // 是否使用知识库（false = 纯对话模式，不检索知识库）
    const useKnowledgeBase = session.useKnowledgeBase !== false; // 兼容旧数据（列默认 true）
    // 会话绑定的知识库 id 列表（空 = 检索该用户全部知识库）
    const kbIds = session.knowledgeBases.map((k) => k.knowledgeBaseId);

    // 模型目标（BYO 强依赖）：会话绑定的配置 → 用户的默认配置 → 都没有则提示先绑定 Key。
    // 所有 token 消耗由用户自己的 Key 承担，系统不提供兜底模型。
    const target =
      (await this.modelConfigService.resolveForChat(userId, session.modelConfigId)) ??
      (await this.modelConfigService.resolveDefaultForUser(userId));
    if (!target) {
      writer('error', {
        message:
          '使用前请先在「模型配置」里绑定你自己的大模型 API Key（设置 → 模型配置，或对话页右上角「模型」入口）。绑定后本会话所有 AI 消耗都由你的 Key 承担。',
      });
      return;
    }
    // 带图自动路由：当前模型不支持视觉时，自动换用用户配置里的视觉模型
    // （如 deepseek-v4-flash-vision-exp、Qwen3-VL）——文本对话仍用会话/默认模型，
    // 两个模型各司其职，不用手动切换；没有视觉配置则保持原模型（报错会提示切换）
    if (imageDataUrl && !isVisionModelName(target.model)) {
      const visionTarget = await this.modelConfigService.resolveVisionForUser(userId);
      if (visionTarget) {
        this.logger.log(
          `会话 ${sessionId} 图片路由: ${target.model} → ${visionTarget.model}（识别图片）`,
        );
        // 只改这一次调用的目标，不改变会话绑定
        target.model = visionTarget.model;
        target.baseURL = visionTarget.baseURL;
        target.apiKey = visionTarget.apiKey;
      }
    }

    // ① 历史对话（最近 3 轮）：先按时间倒序取最近 N 条，再反转回时间正序
    //（注意：不能 orderBy asc + take，那会取到【最早】的 N 条——上下文会越聊越旧）
    const history = await this.prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_ROUNDS,
    });
    history.reverse();

    // ② 多轮查询改写（指代消解）：有历史时，先把问题改写为"独立完整"的问法再检索。
    //    例如第二问"它的原理是什么" → "【上一轮主题】的原理是什么"。
    //    改写只影响【检索】，回答仍用用户的原问题（不改变对话语义）。
    //    纯对话模式（不用知识库也不联网）不需要检索 → 跳过改写，省一次 LLM 调用。
    const needRetrieval = useKnowledgeBase || useWebSearch;
    const searchQuery =
      history.length && needRetrieval && question.trim()
        ? await this.rewriteQuery(question, history, target)
        : question;

    // ③ 检索（并行）：知识库向量+关键词混合检索（纯对话模式跳过）+ 可选联网搜索（用改写后的查询）
    const kbScope = kbIds.length ? kbIds : undefined;
    // 只发图片（无文字）时不做知识库/联网检索（空查询没有意义，还会触发空嵌入报错）
    const canRetrieve = question.trim().length > 0;
    const [retrieved, webSources] = await Promise.all([
      useKnowledgeBase && canRetrieve
        ? this.ragService.retrieve(userId, searchQuery, kbScope, 5)
        : Promise.resolve([] as RetrievalSource[]),
      useWebSearch && canRetrieve ? this.webSearchService.search(searchQuery) : Promise.resolve([]),
    ]);
    const kbSources: RetrievalSource[] = retrieved;
    writer('sources', { kb: kbSources, web: webSources });

    // ④ 保存用户消息（含粘贴图片 data URL）
    await this.prisma.chatMessage.create({
      data: { sessionId, role: 'user', content: question, imageDataUrl: imageDataUrl ?? null },
    });

    // ⑤ 组装 Prompt（知识库资料 + 网络资料一起注入；LLM 看到的是用户原问题）
    const { system, messages } = this.buildPrompt(
      question,
      kbSources,
      webSources,
      history,
      useKnowledgeBase,
      imageDataUrl,
    );

    // ⑤ DeepSeek 流式生成，逐字转发为 SSE delta 事件
    // 模型目标已在开头解析（会话绑定 → 用户默认配置），token 全部由用户自己的 Key 承担。
    const answerClient = new OpenAI({ apiKey: target.apiKey, baseURL: target.baseURL });
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    let answer = '';
    // 流式 usage（stream_options.include_usage）：最后一个 chunk 携带本次请求的 token 用量
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    try {
      const stream = await answerClient.chat.completions.create(
        {
          model: target.model,
          messages: [{ role: 'system', content: system }, ...messages],
          stream: true,
          stream_options: { include_usage: true }, // 数据看板的 Token 统计依赖它
        },
        { signal: abortController.signal }, // 客户端断开时中止生成，不浪费 token
      );

      for await (const part of stream) {
        const delta = part.choices[0]?.delta?.content;
        if (delta) {
          answer += delta;
          writer('delta', { content: delta });
        }
        if (part.usage) {
          usage = part.usage; // 流式结束时的 usage chunk
        }
      }
    } catch (err) {
      // 客户端主动断开 → 静默停止，不扣后续 token
      if (abortController.signal.aborted) {
        this.logger.log(`会话 ${sessionId} 被客户端中止`);
        return;
      }
      const translated = this.translateLLMError(err, !!imageDataUrl);
      this.logger.warn(
        `会话 ${sessionId} LLM 调用失败: ${(err as Error).message} → ${translated.message}`,
      );
      throw translated;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    // ⑥ 流式结束：落库助手消息 + 引用来源（知识库 + 网络）+ Token 用量
    await this.prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content: answer,
        // JSON.parse(JSON.stringify()) 转成纯 JSON，兼容各版本 Prisma 客户端类型
        sources: JSON.parse(JSON.stringify({ kb: kbSources, web: webSources })),
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
      },
    });

    // ⑦ 第一条提问时自动生成会话标题
    if (session.title === '新对话') {
      const title = question.replace(/\s+/g, '').slice(0, 20);
      await this.prisma.chatSession.update({
        where: { id: sessionId },
        data: { title: title || '新对话' },
      });
    }

    writer('done', { messageId: undefined });
    this.logger.log(`会话 ${sessionId} 回答完成，长度 ${answer.length}`);
  }

  // ==================== Prompt 组装 ====================

  private buildPrompt(
    question: string,
    kbSources: RetrievalSource[],
    webSources: WebSource[],
    history: Array<{ role: string; content: string }>,
    useKnowledgeBase: boolean,
    imageDataUrl?: string,
  ): { system: string; messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] } {
    // 按模式切换系统提示词：
    // - 使用知识库：强调以知识库资料为准，标注 [来源N]
    // - 使用知识库但完全没检索到资料：允许用自身知识回答，但必须明确披露，不许假装有资料可引
    // - 纯对话 + 联网：只允许引用网络资料
    // - 纯对话：普通助手
    const systemParts: string[] = [];
    if (useKnowledgeBase) {
      systemParts.push(
        '你是一个严谨的 AI 问答助手，具备两个知识来源：私有知识库资料和联网搜索到的网络资料。',
        '回答时请结合两者：优先以【参考资料】中的知识库内容为准；知识库没有的、但【网络资料】中有的事实，可以引用网络资料。',
        '回答中引用资料时请标注 [来源1]、[来源2] 等编号（编号与资料一致），网络资料请附上对应链接。',
      );
      if (kbSources.length === 0 && webSources.length === 0) {
        systemParts.push(
          '本次未检索到任何知识库与网络资料：你可以基于自身知识回答，但必须在回答开头明确标注"（未检索到知识库资料，以下为模型自身知识）"。',
          '严禁编造来源编号或假装引用了资料。',
        );
      } else {
        systemParts.push('如果【参考资料】中没有相关信息，请明确说明"未找到相关内容"，不要编造。');
      }
    } else if (webSources.length) {
      systemParts.push(
        '你是一个严谨的中文 AI 助手。',
        '回答可以引用【网络资料】中的内容，引用时标注 [来源N] 并附上链接。',
        '网络资料没有的信息请如实说明，不要编造。',
      );
    } else {
      systemParts.push('你是一个友善、严谨的中文 AI 助手。');
    }
    systemParts.push('回答使用简洁、结构化的中文。');
    const system = systemParts.join('\n');

    let number = 0;
    // 有资料才写【参考资料】；完全没检索到就不写这一节（避免"假装有资料"的观感）
    const kbText =
      useKnowledgeBase && kbSources.length
        ? kbSources
            .map((s) => {
              number += 1;
              return `[${number}]（来自文档《${s.filename}》第 ${s.chunkIndex + 1} 段）\n${s.content}`;
            })
            .join('\n\n')
        : '';

    // 联网搜索到的网页资料
    const webText = webSources.length
      ? webSources
          .map((w) => {
            number += 1;
            return `[${number}]（来自网页：${w.title}\n链接：${w.url}）\n${w.content}`;
          })
          .join('\n\n')
      : '';

    const sourceText = [kbText, webText].filter(Boolean).join('\n\n');

    // 历史对话（最近几轮）
    const historyText = history
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
      .join('\n');

    const userPrompt = [
      sourceText ? `【参考资料】\n${sourceText}` : '',
      history.length ? `【历史对话】\n${historyText}` : '',
      '【用户问题】',
      // 只发图片时没有文字问题 → 给模型一个明确指令（否则模型只看到"【用户问题】"空标题）
      (question ?? '').trim() || '请描述这张图片的内容',
    ]
      .filter((s) => s !== '')
      .join('\n');

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      // 有粘贴图片 → 用 OpenAI 视觉消息格式（content 数组：文字 + image_url）
      // 注意：需要支持视觉的模型（如 Qwen-VL）才能识别；DeepSeek 等纯文本模型会报错
      imageDataUrl
        ? {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          }
        : { role: 'user', content: userPrompt },
    ];
    return { system, messages };
  }

  /**
   * 多轮查询改写：把含指代/省略的最新提问，改写为独立完整的检索查询。
   * 只用于检索（召回更准），不改变用户看到的问题。
   * 改写失败时回退原问题，不阻塞主流程。
   */
  private async rewriteQuery(
    question: string,
    history: Array<{ role: string; content: string }>,
    target: ChatTarget,
  ): Promise<string> {
    try {
      const client = new OpenAI({ apiKey: target.apiKey, baseURL: target.baseURL });
      const res = await client.chat.completions.create({
        model: target.model,
        messages: [
          {
            role: 'system',
            content:
              '你是查询改写助手。根据对话历史，把用户最新提问改写为一个独立、完整、无指代的检索查询（例如"它的原理是什么"→"【主题】的原理是什么"）。只输出改写后的查询本身，不要任何解释或前缀。若无需改写则原样输出。',
          },
          {
            role: 'user',
            content: `历史对话：\n${history
              .slice(-6)
              .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, 200)}`)
              .join('\n')}\n\n最新提问：${question}`,
          },
        ],
        max_tokens: 100,
        temperature: 0,
      });
      const rewritten = res.choices[0]?.message?.content?.trim();
      return rewritten && rewritten.length > 0 && rewritten.length < 200 ? rewritten : question;
    } catch (err) {
      this.logger.warn(`查询改写失败，使用原问题: ${(err as Error).message}`);
      return question;
    }
  }

  /**
   * 把上游 LLM API 的原始错误（SDK 英文/JSON 错误）翻译成中文可操作提示。
   * 常见场景：模型不支持图片（not a VLM）、模型名与平台不匹配（Model does not exist）、
   * key 无效、余额不足、限流。翻译不了就保留原始信息兜底。
   */
  private translateLLMError(err: unknown, hasImage: boolean): BadRequestException {
    const e = err as {
      status?: number;
      message?: string;
      body?: unknown;
      code?: string | number;
    };
    const status = e.status ?? 500;
    const bodyText =
      typeof e.body === 'string' ? e.body : JSON.stringify(e.body ?? e.message ?? '');
    const raw = `${e.message ?? ''} ${bodyText}`.toLowerCase();

    // 带图请求被上游拒绝（400/422/无 body）→ 优先提示模型不支持图片
    if (
      hasImage &&
      (status === 400 || status === 422 || /not a vlm|vision language model|image/i.test(raw))
    ) {
      return new BadRequestException(
        '当前模型不支持图片：请在该会话右上角切换到支持视觉的模型（如 deepseek-v4-flash-vision-exp、Qwen/Qwen3-VL 等），或在「模型配置」检查模型名与平台是否匹配。',
      );
    }
    if (status === 401 || /invalid api key|authentication|unauthorized/i.test(raw)) {
      return new BadRequestException(
        '大模型 API Key 无效或已失效：请到「模型配置」检查该配置的 Key，或删掉重新绑定。',
      );
    }
    if (status === 402 || /insufficient|balance|quota|payment/i.test(raw)) {
      return new BadRequestException(
        '大模型账户余额不足：请到对应平台（DeepSeek / SiliconFlow 等）充值后重试。',
      );
    }
    if (status === 429 || /rate.?limit|too many requests/i.test(raw)) {
      return new BadRequestException('请求过于频繁（触发限流），请稍等几秒再试。');
    }
    if (/model does not exist|model not found|no such model|invalid model/i.test(raw)) {
      return new BadRequestException(
        '模型名不存在：平台和模型名必须配套（DeepSeek 官方 API 用 deepseek-v4-flash 等；SiliconFlow 用 deepseek-ai/DeepSeek-V4-Flash 等）。请到「模型配置」修正模型名。',
      );
    }
    if (/context|too long|maximum length|token.*limit/i.test(raw)) {
      return new BadRequestException(
        '对话内容超出模型上下文长度：请精简问题、减少历史或切换更长上下文的模型。',
      );
    }
    // 兜底：把上游 JSON 错误的关键信息带出来，而不是只给 SDK 的 content-type 报错
    if (/expected content-type/i.test(raw) && status !== 500) {
      return new BadRequestException(
        `大模型接口调用失败（HTTP ${status}）：${(e.body ?? e.message ?? '未知错误').toString().slice(0, 200)}`,
      );
    }
    return new BadRequestException(
      `大模型调用失败（HTTP ${status}）：请检查「模型配置」的 Key / 模型名 / 余额，或切换到支持图片的视觉模型。${e.message ?? ''}`.slice(
        0,
        300,
      ),
    );
  }

  /** 导出会话为 Markdown（含引用来源），供下载/复制 */
  async exportSession(userId: string, sessionId: string) {
    const session = await this.prisma.chatSession.findFirst({
      where: { id: sessionId, ownerId: userId },
      include: {
        knowledgeBases: { select: { knowledgeBase: { select: { name: true } } } },
      },
    });
    if (!session) {
      throw new NotFoundException('会话不存在');
    }
    const messages = await this.prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });

    const lines: string[] = [
      `# ${session.title}`,
      '',
      `> 导出时间：${new Date().toLocaleString('zh-CN')}`,
      `> 问答范围：${
        session.useKnowledgeBase === false
          ? '不使用知识库（纯对话）'
          : session.knowledgeBases.length
            ? session.knowledgeBases.map((k) => k.knowledgeBase.name).join('、')
            : '全部知识库'
      }`,
      '',
      '---',
      '',
    ];
    for (const m of messages) {
      if (m.role === 'user') {
        lines.push(`## 🙋 ${m.content}`, '');
      } else {
        lines.push('### 🤖 回答', '', m.content, '');
        const sources = (m.sources ?? null) as {
          kb?: Array<{ filename: string; similarity: number | null }>;
          web?: Array<{ title: string; url: string }>;
        } | null;
        if (sources && (sources.kb?.length || sources.web?.length)) {
          lines.push('**引用来源：**', '');
          sources.kb?.forEach((s, i) => {
            lines.push(
              `- 📚 来源${i + 1}：《${s.filename}》（${
                s.similarity != null ? `相似度 ${(s.similarity * 100).toFixed(0)}%` : '知识图谱关联'
              }）`,
            );
          });
          sources.web?.forEach((w) => {
            lines.push(`- 🌐 [${w.title}](${w.url})`);
          });
          lines.push('');
        }
        lines.push('---', '');
      }
    }
    return { filename: `${session.title}.md`, content: lines.join('\n') };
  }
}
