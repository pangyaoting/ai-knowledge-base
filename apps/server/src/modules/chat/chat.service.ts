import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RagService, RetrievalSource } from './rag.service';
import { WebSearchService, WebSource } from './web-search.service';
import { ModelConfigService, ChatTarget, isVisionModelName } from '../models/model-config.service';
import {
  cleanText,
  detectFileType,
  extractText,
  sanitizeControlChars,
  type DocType,
} from '../knowledge/utils/document-parser';
import { CreateSessionDto } from './dto/create-session.dto';

interface StreamWriter {
  (event: 'sources' | 'delta' | 'done' | 'error', data: unknown): void;
}

/** 把数据库里的图片 JSON 字符串安全解析成数组（坏数据回退空数组） */
function parseImageUrls(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as string[]) : null;
  } catch {
    return null;
  }
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
    private configService: ConfigService,
  ) {}

  /** 全文模式字符上限（.env 可配 FULLTEXT_MAX_CHARS，默认 40000 ≈ 安全落在模型上下文内） */
  private get fulltextMaxChars(): number {
    const v = Number(this.configService.get<string>('FULLTEXT_MAX_CHARS', '40000'));
    return Number.isFinite(v) && v > 0 ? v : 40000;
  }

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
      const target = await this.modelConfigService.resolveForChat(
        userId,
        dto.modelConfigId,
        dto.model,
      );
      if (!target) throw new NotFoundException('模型配置不存在');
      modelConfigId = dto.modelConfigId;
    }
    return this.prisma.chatSession.create({
      data: {
        ownerId: userId,
        title: dto.title || '新对话',
        useKnowledgeBase,
        modelConfigId,
        // 会话选中的模型名（同一配置多模型；null = 用配置默认 model）
        ...(dto.model ? { model: dto.model } : {}),
        // 分支功能：把之前的对话作为历史消息注入新会话（LLM 回答时能读到前文）
        ...(dto.seedMessages?.length
          ? {
              messages: {
                create: dto.seedMessages.map((m) => ({
                  role: m.role,
                  content: m.content,
                })),
              },
            }
          : {}),
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

  /** 修改会话绑定的模型配置与具体模型名（null = 回退系统默认） */
  async updateSessionModel(
    userId: string,
    sessionId: string,
    modelConfigId?: string | null,
    model?: string | null,
    reasoningEffort?: string | null,
  ) {
    await this.getSession(userId, sessionId);
    let next: string | null = null;
    let nextModel: string | null = null;
    if (modelConfigId != null) {
      // 绑定了配置：解析有效模型名（同一配置内切换模型；非法名回落默认 model）
      const target = await this.modelConfigService.resolveForChat(userId, modelConfigId, model);
      if (!target) throw new NotFoundException('模型配置不存在');
      next = modelConfigId;
      nextModel = target.model;
    }
    return this.prisma.chatSession.update({
      where: { id: sessionId },
      data: {
        modelConfigId: next,
        // model 一并写：绑定配置时写解析后的模型名；清空配置时置 null（不留残留）
        ...(modelConfigId !== undefined ? { model: nextModel } : {}),
        // reasoningEffort 传了才更新（null = 清空回默认；undefined = 不修改）
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      },
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
    const msgs = await this.prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
    // image_data_urls 是 JSON 字符串列，返回时解析成数组——
    // 否则前端把字符串当数组遍历会按字符拆出无数张废图（图片叠满屏幕）
    return msgs.map((m) => ({
      ...m,
      imageDataUrls: parseImageUrls(m.imageDataUrls),
    }));
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

  /** 提取上传文件的文本（对话文件上传用）：文本/代码直接读，PDF/Word 提取文字 */
  async extractFile(file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException('未收到文件（multipart 字段名应为 file）');
    }
    if (file.size === 0) {
      throw new BadRequestException('文件内容为空');
    }
    // 修复 multipart 中文文件名乱码（busboy 按 latin1 解码，与知识库上传同一处理）
    const filename = fixMojibakeFilename(file.originalname);
    const fileType = detectFileType(filename);
    if (!fileType) {
      throw new BadRequestException('不支持该文件类型：仅支持文本/代码/PDF/Word 等可读取的文件');
    }
    const raw = await extractText(file.buffer, fileType as DocType);
    const content = cleanText(raw);
    if (!content) {
      throw new BadRequestException('未能从文件中提取到文本（可能是扫描件或图片型 PDF）');
    }
    // 防止超大文本撑爆模型上下文：单文件截断到 3 万字符（3 个文件 ≈ 9 万字符，模型上下文内）
    const MAX_FILE_CHARS = 30_000;
    const truncated = content.length > MAX_FILE_CHARS;
    return {
      filename,
      content: truncated ? `${content.slice(0, MAX_FILE_CHARS)}\n…（文件过长，已截断）` : content,
      truncated,
    };
  }

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
    imageDataUrls?: string[],
  ) {
    const session = await this.getSession(userId, sessionId);
    const images = (imageDataUrls ?? []).filter((u) => !!u && u.length > 0);
    // 只发图片（不带文字）也允许：content 为空但有图片
    if (!(question ?? '').trim() && images.length === 0) {
      throw new BadRequestException('请填写问题或粘贴/上传图片');
    }
    // 是否使用知识库（false = 纯对话模式，不检索知识库）
    const useKnowledgeBase = session.useKnowledgeBase !== false; // 兼容旧数据（列默认 true）
    // 会话绑定的知识库 id 列表（空 = 检索该用户全部知识库）
    const kbIds = session.knowledgeBases.map((k) => k.knowledgeBaseId);

    // 模型目标（BYO 强依赖）：会话绑定的配置（含选中的模型名）→ 用户的默认配置 → 都没有则提示先绑定 Key。
    // 所有 token 消耗由用户自己的 Key 承担，系统不提供兜底模型。
    const target =
      (await this.modelConfigService.resolveForChat(
        userId,
        session.modelConfigId,
        session.model,
      )) ?? (await this.modelConfigService.resolveDefaultForUser(userId));
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
    if (images.length > 0 && !isVisionModelName(target.model)) {
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

    // ③ 全文/检索自动分流（P0）：绑定了明确知识库且文档总量 ≤ 阈值 → 全文模式
    //    （看完整文档类任务：逐行解析/全文总结，检索只给片段必然答不全）；
    //    文档海量或未绑定知识库 → 检索模式（向量+关键词混合）。联网搜索并行。
    const kbScope = kbIds.length ? kbIds : undefined;
    // 只发图片（无文字）时不做知识库/联网检索（空查询没有意义，还会触发空嵌入报错）
    const canRetrieve = question.trim().length > 0;
    let kbSources: RetrievalSource[] = [];
    let retrievalMode: 'fulltext' | 'retrieval' | 'none' = 'none';
    if (useKnowledgeBase && canRetrieve) {
      if (kbIds.length) {
        // 绑定明确知识库：先试全文（总量小 = 全文喂模型比检索片段完整）
        const ft = await this.ragService.loadFulltext(userId, kbIds, this.fulltextMaxChars);
        if (ft.sources.length > 0) {
          kbSources = ft.sources;
          retrievalMode = 'fulltext';
          this.logger.log(
            `会话 ${sessionId} 全文模式：${ft.totalChars} 字符 ≤ 阈值 ${this.fulltextMaxChars}，注入 ${ft.sources.length} 个文档`,
          );
        } else {
          // 检索模式；首次被相关性门控全滤（0 条）时用 HyDE 假设文档兜底重检（P3）
          kbSources = await this.retrieveWithHyde(userId, searchQuery, kbScope, target, sessionId);
          retrievalMode = 'retrieval';
          this.logger.log(
            `会话 ${sessionId} 检索模式：KB 总字符 ${ft.totalChars} > 阈值 ${this.fulltextMaxChars}，走混合检索`,
          );
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

    // ④ 保存用户消息（含图片 data URL 数组；单图兼容字段存第一张）
    // content 可能来自粘贴/外部文本而夹带 \u0000 → 落库前清洗（PG text 禁止 NUL）
    await this.prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'user',
        content: sanitizeControlChars(question),
        imageDataUrl: images[0] ?? null,
        imageDataUrls: images.length ? JSON.stringify(images) : null,
      },
    });

    // ⑤ 组装 Prompt（知识库资料 + 网络资料一起注入；LLM 看到的是用户原问题）
    const { system, messages } = this.buildPrompt(
      question,
      kbSources,
      webSources,
      history,
      useKnowledgeBase,
      images,
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
          // 会话推理等级（low=关闭/高/max）→ 透传给支持 reasoning_effort 的模型（DeepSeek V4 等）
          ...(session.reasoningEffort ? { reasoning_effort: session.reasoningEffort } : {}),
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
      const translated = this.translateLLMError(err, images.length > 0);
      this.logger.warn(
        `会话 ${sessionId} LLM 调用失败: ${(err as Error).message} → ${translated.message}`,
      );
      throw translated;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    // ⑥ 流式结束：落库助手消息 + 引用来源（知识库 + 网络）+ Token 用量
    // 兜底清洗：模型输出或检索片段偶发夹带 \u0000 时，防止 PG 22P05 崩溃（源头已清洗，这是最后防线）
    const sourcesJson = JSON.parse(
      sanitizeControlChars(JSON.stringify({ kb: kbSources, web: webSources })),
    );
    await this.prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content: sanitizeControlChars(answer),
        // JSON.parse(JSON.stringify()) 转成纯 JSON，兼容各版本 Prisma 客户端类型
        sources: sourcesJson,
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
    imageDataUrls: string[],
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
    // similarity === null 的块是全文模式注入的完整文档（显示"全文"）；检索命中的显示"第 N 段"
    const kbText =
      useKnowledgeBase && kbSources.length
        ? kbSources
            .map((s) => {
              number += 1;
              const label =
                s.similarity === null
                  ? `[${number}]（文档《${s.filename}》全文）`
                  : `[${number}]（来自文档《${s.filename}》第 ${s.chunkIndex + 1} 段）`;
              return `${label}\n${s.content}`;
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
      (question ?? '').trim() ||
        (imageDataUrls.length > 1 ? '请描述这些图片的内容' : '请描述这张图片的内容'),
    ]
      .filter((s) => s !== '')
      .join('\n');

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      // 有图片 → OpenAI 视觉消息格式（content 数组：文字 + 多张 image_url）
      // 注意：需要支持视觉的模型（如 deepseek-v4-flash-vision-exp、Qwen-VL）才能识别；
      // 纯文本模型会报错（自动路由会优先换视觉模型）
      imageDataUrls.length > 0
        ? {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              ...imageDataUrls.map((url) => ({
                type: 'image_url' as const,
                image_url: { url },
              })),
            ],
          }
        : { role: 'user', content: userPrompt },
    ];
    return { system, messages };
  }

  /**
   * 检索（C 符号命中 → 混合检索 → HyDE 兜底）：
   * 1. 问题点名符号（函数/类/组件名）→ 直接返回该符号实现源码（最精准）
   * 2. 否则正常混合检索；若被相关性门控全滤（0 条）→ HyDE 假设文档再检一次
   * 成本可控：符号查询零成本；HyDE 只在 0 结果时触发一次 LLM 调用，失败静默回退。
   */
  private async retrieveWithHyde(
    userId: string,
    query: string,
    kbScope: string[] | undefined,
    target: ChatTarget,
    sessionId: string,
  ): Promise<RetrievalSource[]> {
    // C 符号命中优先：问题点名符号 → 返回实现源码，跳过语义检索
    const symbolHits = await this.ragService.symbolLookup(userId, query, kbScope);
    if (symbolHits.length > 0) {
      this.logger.log(`会话 ${sessionId} 符号命中 ${symbolHits.length} 条（问题包含符号名）`);
      return symbolHits;
    }

    // A 档案锁定：中文问题先语义定位文件（最多 3 个），把检索范围从"全库"缩到"命中文件"
    const locked = await this.ragService.profileLookup(userId, query, kbScope, 3);
    const docIds = locked.map((d) => d.documentId);
    if (locked.length > 0) {
      this.logger.log(
        `会话 ${sessionId} 档案锁定 ${locked.length} 个文档: ${locked.map((d) => d.filename).join(', ')}`,
      );
    }

    // A+C 联动：档案命中文件 → 拉该文件真实符号实现（函数体），
    // 避免大文件里 script 实现区被模板片段挤掉 topK 导致模型脑补
    if (docIds.length > 0) {
      const symbolSources = await this.ragService.symbolsForDocs(userId, docIds, 8);
      if (symbolSources.length > 0) {
        // 文件内语义检索补齐（符号优先，片段补充，总量 cap 到 8）
        const fileSources = await this.ragService.retrieve(userId, query, kbScope, 5, docIds);
        const seen = new Set(symbolSources.map((s) => s.chunkId));
        for (const s of fileSources) {
          if (symbolSources.length >= 8) break;
          if (!seen.has(s.chunkId)) symbolSources.push(s);
        }
        this.logger.log(
          `会话 ${sessionId} A+C 联动：符号注入 ${symbolSources.length} 条（含文件内片段补充）`,
        );
        return symbolSources;
      }
    }

    // 文件内检索（锁定文档范围内）
    const sources = await this.ragService.retrieve(
      userId,
      query,
      kbScope,
      5,
      docIds.length > 0 ? docIds : undefined,
    );
    if (sources.length > 0) {
      return sources;
    }

    // 档案锁定但文件内 0 条（如问的是跨文件的一般概念）→ 放宽到全库再检一次
    if (locked.length > 0) {
      const wide = await this.ragService.retrieve(userId, query, kbScope, 5);
      if (wide.length > 0) {
        return wide;
      }
    }

    // P3 HyDE 兜底：仍 0 条 → 假设文档扩写后全库重检
    if (!this.hydeEnabled) {
      return sources;
    }
    const hydeQuery = await this.hydeExpand(query, target);
    if (hydeQuery === query) {
      return sources;
    }
    const retry = await this.ragService.retrieve(userId, hydeQuery, kbScope, 5);
    if (retry.length > 0) {
      this.logger.log(
        `会话 ${sessionId} HyDE 兜底命中 ${retry.length} 条（原检索 0 条，扩写后命中）`,
      );
    }
    return retry;
  }

  /** HyDE 开关（.env 可配 HYDE_ENABLED，默认开启） */
  private get hydeEnabled(): boolean {
    return this.configService.get<string>('HYDE_ENABLED', 'true') !== 'false';
  }

  /**
   * HyDE 假设文档生成：把问题扩写成一段"知识库里如果存着答案，内容大概长什么样"的陈述文本。
   * 用这段文本做向量检索（而非原问题），语义重合度更高。失败回退原问题。
   */
  private async hydeExpand(question: string, target: ChatTarget): Promise<string> {
    try {
      const client = new OpenAI({ apiKey: target.apiKey, baseURL: target.baseURL });
      const res = await client.chat.completions.create({
        model: target.model,
        messages: [
          {
            role: 'system',
            content:
              '你是检索增强助手。用户给一个问题，请写一段 150 字以内的"假设的知识库文档内容"：用陈述句直接描述，如果知识库里存有该问题的答案，内容大概会怎么写（包含关键名词、概念、步骤）。只输出这段内容本身，不要任何解释、不要以"根据""假设"开头、不要提问句式。',
          },
          { role: 'user', content: question },
        ],
        max_tokens: 250,
        temperature: 0.3,
      });
      const text = res.choices[0]?.message?.content?.trim();
      return text && text.length >= 20 && text.length <= 500 ? text : question;
    } catch (err) {
      this.logger.warn(`HyDE 扩写失败，回退原问题: ${(err as Error).message}`);
      return question;
    }
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

/**
 * 修复 multipart 上传中文文件名乱码（与知识库上传同一逻辑）：
 * busboy（multer 底层）默认把文件名按 latin1 解码，UTF-8 字节变成乱码字符（如 新→æ°）。
 * latin1 字符还原成字节再按 UTF-8 解码；已是正确 UTF-8 的文件名会还原出替换符，保持原样。
 */
function fixMojibakeFilename(name: string): string {
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  if (decoded.includes('\uFFFD')) {
    return name;
  }
  return decoded;
}
