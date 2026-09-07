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
import { extractSymbols } from '../knowledge/utils/code-indexer';
import { MemorySummaryService } from './memory-summary.service';

/** 给代码文本加行号（1-based；解析时让模型引用真实行号，避免"未标行号"） */
function numberLines(content: string, startLine = 1): string {
  return content
    .split('\n')
    .map((l, i) => `${i + startLine}: ${l}`)
    .join('\n');
}

/** 剥掉代码分块时插入的"文件: xxx"块头行——它们不是真实源码行，
 *  会让 AST 行号与注入文本整体偏移（实测总览/深挖行号 +3 且混入分页标记）。 */
function stripChunkHeaders(content: string): string {
  return content
    .split('\n')
    .filter((l) => !/^\s*文件:\s*\S/.test(l))
    .join('\n');
}

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

/** 截断标记：finish_reason=length 时追加到回答尾部；历史带此标记 + 用户回复"继续" → 续写模式 */
const TRUNCATION_HINT = '已达输出上限';

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
    private memorySummaryService: MemorySummaryService,
  ) {}

  /** 历史原文窗口（轮数，.env MEMORY_ROUNDS 可调，默认 3 轮 = 6 条；更早的靠滚动摘要兜底） */
  private get memoryRounds(): number {
    const v = Number(this.configService.get<string>('MEMORY_ROUNDS', '3'));
    return Number.isFinite(v) && v >= 1 && v <= 10 ? Math.floor(v) : 3;
  }

  /** 全文模式字符上限（.env 可配 FULLTEXT_MAX_CHARS，默认 40000 ≈ 安全落在模型上下文内） */
  private get fulltextMaxChars(): number {
    const v = Number(this.configService.get<string>('FULLTEXT_MAX_CHARS', '40000'));
    return Number.isFinite(v) && v > 0 ? v : 40000;
  }

  /** 解析类输出总上限（.env 可配 PARSE_MAX_TOKENS，默认 16000）。
   *  实测 v4-flash 高档思考会烧 7000+ token：上限给足（16000），思考+正文都够用，
   *  避免"思考吃光额度、正文被截"（早前 6000/8000 上限下正文只剩 300~800 字）。 */
  private get parseMaxTokens(): number {
    const v = Number(this.configService.get<string>('PARSE_MAX_TOKENS', '16000'));
    return Number.isFinite(v) && v > 0 ? v : 16000;
  }

  /** "继续"续写轮的输出上限（.env 可配 PARSE_CONTINUE_MAX_TOKENS，默认 20000） */
  private get continueMaxTokens(): number {
    const v = Number(this.configService.get<string>('PARSE_CONTINUE_MAX_TOKENS', '20000'));
    return Number.isFinite(v) && v > 0 ? v : 20000;
  }

  /** 总览快通道输出上限（.env 可配 PARSE_OVERVIEW_MAX_TOKENS，默认 4000——总览只需函数地图级篇幅） */
  private get overviewMaxTokens(): number {
    const v = Number(this.configService.get<string>('PARSE_OVERVIEW_MAX_TOKENS', '4000'));
    return Number.isFinite(v) && v > 0 ? v : 4000;
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
      take: this.memoryRounds * 2, // 最近 N 轮原文；更早内容折叠进 session.summary 兜底
    });
    history.reverse();

    // ② 多轮查询改写（指代消解）：有历史时，先把问题改写为"独立完整"的问法再检索。
    //    例如第二问"它的原理是什么" → "【上一轮主题】的原理是什么"。
    //    改写只影响【检索】，回答仍用用户的原问题（不改变对话语义）。
    //    纯对话模式（不用知识库也不联网）不需要检索 → 跳过改写，省一次 LLM 调用。
    // 代码解析类判定提前（影响：跳过改写/跳过联网/检索收窄/思考预算与输出上限）
    const wantsCodeWalkthrough = ChatService.wantsCodeWalkthrough(question);
    const namedFile = ChatService.namedCodeFile(question);
    // "继续"续写模式：用户回复 继续/接着写 且上一轮回答因截断带上了标记（见 TRUNCATION_HINT）
    const isPureContinue = /^\s*(继续|接着(写|讲|说|解析)?|continue)\s*$/i.test(question.trim());
    const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
    const isContinuation = isPureContinue && !!lastAssistant?.content.includes(TRUNCATION_HINT);
    // 含"内部符号名 + 实现/调用意图"的问题（如"updateBlackHole 在哪被调用"）→ 联网帮不上忙，
    // 反而会召回 DeleteBlackhole(阿里云 DDoS) 这类同名噪音 → 这类问题不联网
    const symbolAskNoWeb =
      /(定义|调用|实现|函数|方法|源码|在哪|哪里|作用|干什么|做什么|逻辑)/.test(question) &&
      (question.match(/[A-Za-z_$][A-Za-z0-9_$]{4,}/g) ?? []).some(
        (t) => /[a-z]/.test(t) && /[A-Z]/.test(t),
      );

    // 解析类/续写类不查询改写：文件名问法自包含，改写只会搅乱文件名；"继续"改写无意义
    // （省一次串行 LLM 调用 3~10s）
    const needRetrieval = useKnowledgeBase || useWebSearch;
    const searchQuery =
      history.length && needRetrieval && question.trim() && !wantsCodeWalkthrough && !isContinuation
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
    // 解析类/续写类/符号问答/点名文件默认不联网——答案在代码/知识库里，联网只会添乱拖慢
    const webSources =
      useWebSearch &&
      canRetrieve &&
      !wantsCodeWalkthrough &&
      !isContinuation &&
      !symbolAskNoWeb &&
      !namedFile
        ? await this.webSearchService.search(searchQuery)
        : [];

    // 批1-4：解析类未点名文件 → 检索资料只是辅助上下文（解析对象应在历史/上传内容里），
    // 收窄注入量并 code 优先：深度由 A+C 档案/符号定位保证，这里只减噪音防思考发散
    if (
      wantsCodeWalkthrough &&
      !namedFile &&
      retrievalMode === 'retrieval' &&
      kbSources.length > 6
    ) {
      const codeFirst = (fn: string) =>
        /\.(ts|js|vue|tsx|jsx|py|go|rs|java|c|cpp|cs|sh|sql)$/i.test(fn);
      const codeSrc = kbSources.filter((s) => codeFirst(s.filename));
      const docSrc = kbSources.filter((s) => !codeFirst(s.filename));
      kbSources = [...codeSrc, ...docSrc].slice(0, 6);
      this.logger.log(
        `会话 ${sessionId} 解析类未点名文件：注入收窄至 ${kbSources.length} 条（code 优先）`,
      );
    }

    // ── A+B：代码解析三级模式 ─────────────────────────────────────────
    // 大文件(>300 行)首问 → 总览（函数地图，快）；追问"逐行讲解 XX" → 单函数深挖；
    // 小文件 → 整篇深解析。全程用 AST 符号表给真实行号，不再让模型"对着无行号全文瞎写"。
    let parseMode: 'overview' | 'deep' | 'full' = 'full';
    // 用户显式要"完整/每行/整个文件"时，跳过总览直接整篇逐行（尊重显式意图）
    let wholeFileExplicit = false;
    if (wantsCodeWalkthrough) {
      // 目标全文字档：优先问题点名文件（单文件全文通道产物 similarity===null）；
      // 未点名但带函数名追问 → 从上一轮助手内容里推断它解析的文件
      let docSrc = kbSources.find(
        (s) =>
          s.similarity === null &&
          namedFile &&
          s.filename.toLowerCase().endsWith(namedFile.toLowerCase()),
      );
      if (!docSrc) docSrc = kbSources.find((s) => s.similarity === null && s.chunkIndex === -1);
      const nameTokens = (question.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).map((t) =>
        t.toLowerCase(),
      );
      const deepIntent =
        /逐行|详细|展开|深挖|讲讲|讲清楚|具体|细节|为什么|怎么实现|如何实现|接着解析/.test(
          question,
        );
      if (!docSrc && deepIntent && nameTokens.length > 0) {
        const histFile = lastAssistant?.content.match(
          /([A-Za-z0-9_\-]+\.(?:vue|ts|js|tsx|jsx|py|go|rs|java|c|cpp|cs|sh|sql))/i,
        )?.[1];
        if (histFile) {
          const ft = await this.ragService.loadDocumentByNameFulltext(
            userId,
            histFile,
            kbScope,
            10_000_000, // 深挖需要按真实行号切函数体，不限注入上限（切片后注入量很小）
          );
          docSrc = ft.sources.find((s) => s.similarity === null && s.chunkIndex === -1);
          if (docSrc) {
            kbSources = ft.sources;
            retrievalMode = 'fulltext';
            this.logger.log(`解析深挖：从历史推断目标文件 ${histFile}`);
          }
        }
      }
      // 只有"代码文件整篇"才走 A+B 三级模式；md/无目标 → 维持原样（full 或检索片段）
      if (
        docSrc &&
        /\.(ts|js|vue|tsx|jsx|py|go|rs|java|c|cpp|cs|sh|sql)$/i.test(docSrc.filename) &&
        docSrc.content
      ) {
        // 剥掉分块块头行（"文件: xxx"）再定位行号——否则行号整体偏移、文本混入分页标记
        const fileContent = stripChunkHeaders(docSrc.content);
        const lineCount = fileContent.split('\n').length;
        wholeFileExplicit =
          /完整|整个文件|全文|全部行|全部代码|每一行|每行/.test(question) &&
          fileContent.length <= 200_000; // 超大文件显式整篇会撑爆上下文 → 仍走总览
        const symbols = extractSymbols(docSrc.filename, fileContent);
        const target = symbols.find((s) => nameTokens.includes(s.name.toLowerCase())) ?? null;
        if (target && deepIntent) {
          // 深挖：注入带行号的完整函数体 + 文件内其它出现位置（调用点）
          parseMode = 'deep';
          const lines = fileContent.split('\n');
          const body = lines.slice(target.startLine - 1, target.endLine).join('\n');
          const elsewhere = lines
            .map((l, i) => ({ l, i: i + 1 }))
            .filter(
              ({ l, i }) =>
                (i < target.startLine || i > target.endLine) && l.includes(`${target.name}(`),
            )
            .slice(0, 12)
            .map(({ l, i }) => `L${i}: ${l.trim()}`);
          const head = numberLines(lines.slice(0, 8).join('\n'));
          kbSources = [
            {
              chunkId: `${docSrc.documentId}:${target.name}`,
              content: [
                `文件：${docSrc.filename}（共 ${lineCount} 行）`,
                head,
                `\n## ${target.name} 完整源码（L${target.startLine}-${target.endLine}）`,
                numberLines(body, target.startLine),
                elsewhere.length ? `\n## 文件内其它出现位置\n${elsewhere.join('\n')}` : '',
              ].join('\n'),
              chunkIndex: target.startLine - 1,
              documentId: docSrc.documentId,
              filename: docSrc.filename,
              similarity: null,
            },
          ];
          this.logger.log(
            `解析深挖：${docSrc.filename} ${target.name}（L${target.startLine}-${target.endLine}）`,
          );
        } else if (lineCount > 300 && !wholeFileExplicit) {
          // 大文件首问 → 总览：只给函数地图 + 头部注释，引导追问深挖
          // （用户显式要求完整/每行时跳过总览，走下方整篇逐行）
          parseMode = 'overview';
          const head = numberLines(fileContent.split('\n').slice(0, 40).join('\n'));
          const map = symbols
            .map(
              (s) =>
                `- L${s.startLine}-${s.endLine} ${s.kind} ${s.name}: ${s.signature
                  .replace(
                    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|class|interface|type|enum)\s*/,
                    '',
                  )
                  .slice(0, 90)}`,
            )
            .join('\n');
          kbSources = [
            {
              chunkId: `${docSrc.documentId}:overview`,
              content: `文件：${docSrc.filename}（共 ${lineCount} 行）\n\n## 符号表（AST 提取，行号为真实行号）\n${map || '（未提取到符号）'}\n\n## 文件头部（前 40 行）\n${head}`,
              chunkIndex: -1,
              documentId: docSrc.documentId,
              filename: docSrc.filename,
              similarity: null,
            },
          ];
          this.logger.log(`解析总览：${docSrc.filename}（${lineCount} 行 > 300，转总览模式）`);
        } else {
          // 整篇：带行号注入（小文件一轮深解析；大文件 + 显式"完整/每行" → 逐行输出，可分批继续）
          parseMode = 'full';
          kbSources = [
            {
              chunkId: docSrc.documentId,
              content: numberLines(fileContent),
              chunkIndex: -1,
              documentId: docSrc.documentId,
              filename: docSrc.filename,
              similarity: null,
            },
          ];
          this.logger.log(
            `解析整篇：${docSrc.filename}（${lineCount} 行${wholeFileExplicit ? '，显式整篇逐行' : ''}）`,
          );
        }
      }
    }

    writer('sources', { kb: kbSources, web: webSources, mode: retrievalMode });

    // ④ 保存用户消息（含图片 data URL 数组；单图兼容字段存第一张）
    // content 可能来自粘贴/外部文本而夹带 \u0000 → 落库前清洗（PG text 禁止 NUL）
    const savedUserMsg = await this.prisma.chatMessage.create({
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
      {
        walkthrough: wantsCodeWalkthrough,
        continuation: isContinuation,
        parseMode,
        lineByLine: parseMode === 'full' && wholeFileExplicit,
        summary: (session as { summary?: string | null }).summary ?? undefined,
      },
    );

    // ⑤ DeepSeek 流式生成，逐字转发为 SSE delta 事件
    // 模型目标已在开头解析（会话绑定 → 用户默认配置），token 全部由用户自己的 Key 承担。
    // 思考策略（方案 B，2026-09 实测修正）：v4-flash 对 thinking.budget_tokens 参数是"接受但
    // 静默忽略"（实测思考仍烧 7000+ token），无法靠"思考预算"约束 → 删掉该假参数，
    // 回到"会话档位说了算"（high/max=深度思考，low=关闭，默认=模型默认），
    // 用大输出上限（16000）保证思考后正文仍有充足额度，避免截断。
    const answerClient = new OpenAI({ apiKey: target.apiKey, baseURL: target.baseURL });
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    // 输出上限：续写轮 = PARSE_CONTINUE_MAX_TOKENS（20000）；总览快通道 = PARSE_OVERVIEW_MAX_TOKENS（4000）；
    // 深挖/整篇 = PARSE_MAX_TOKENS（16000）；普通问答不设限。
    const maxTokens = isContinuation
      ? this.continueMaxTokens
      : parseMode === 'overview'
        ? this.overviewMaxTokens
        : wantsCodeWalkthrough
          ? this.parseMaxTokens
          : undefined;

    // 每次尝试的附加参数；attempts[0] = 主尝试，附加参数被上游拒绝时 attempts[1] 去参重试
    type ExtraParams = { reasoning_effort?: string };
    const extras: ExtraParams = {};
    if (parseMode === 'overview') {
      // 总览只是把符号表整理成"函数地图"，不需要深度思考 → 强制 low 快通道（40 秒级）
      extras.reasoning_effort = 'low';
    } else if (session.reasoningEffort) {
      // 深挖/整篇/普通问答：思考深度跟随会话档位（low=关闭 / high/max=深度思考）
      extras.reasoning_effort = session.reasoningEffort;
    }
    const attempts: ExtraParams[] = Object.keys(extras).length ? [extras, {}] : [{}];

    let answer = '';
    // 流式 usage（stream_options.include_usage）：最后一个 chunk 携带本次请求的 token 用量
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    let finishReason: string | null | undefined;
    let lastErr: unknown = null;
    try {
      // 单次生成尝试：创建流并逐字转发为 SSE delta；返回本次正文与终止原因
      const runAttempt = async (extra: ExtraParams) => {
        const stream = await answerClient.chat.completions.create(
          {
            model: target.model,
            messages: [{ role: 'system', content: system }, ...messages],
            stream: true,
            stream_options: { include_usage: true }, // 数据看板的 Token 统计依赖它
            ...(maxTokens ? { max_tokens: maxTokens } : {}),
            // 会话推理档位（low=关闭/高/最高）透传；模型不支持时 attempts 去参重试
            ...(extra.reasoning_effort ? { reasoning_effort: extra.reasoning_effort } : {}),
          },
          { signal: abortController.signal }, // 客户端断开时中止生成，不浪费 token
        );
        const out = { text: '', reason: undefined as string | null | undefined };
        for await (const part of stream) {
          const delta = part.choices[0]?.delta?.content;
          if (delta) {
            out.text += delta;
            writer('delta', { content: delta });
          }
          if (part.choices[0]?.finish_reason) out.reason = part.choices[0].finish_reason;
          if (part.usage) usage = part.usage; // 流式结束时的 usage chunk
        }
        return out;
      };

      // 主尝试：成功出正文即收；成功但为空且有下一组参数 → 换参数再试
      for (let i = 0; i < attempts.length; i++) {
        try {
          const out = await runAttempt(attempts[i]);
          answer = out.text;
          finishReason = out.reason;
          if (answer.trim() || i === attempts.length - 1) break;
          this.logger.warn(`会话 ${sessionId} 第 ${i + 1} 次生成为空，尝试去掉附加参数再试`);
        } catch (err) {
          // 客户端主动断开 → 静默停止，不扣后续 token
          if (abortController.signal.aborted) {
            this.logger.log(`会话 ${sessionId} 被客户端中止`);
            return;
          }
          lastErr = err;
          const raw = `${(err as Error).message ?? ''}`.toLowerCase();
          // 附加参数（thinking/reasoning_effort）被上游拒绝（模型/网关不支持）→ 去参重试一次；
          // 其他错误不重试，跳出循环统一按失败处理
          const paramRejected =
            attempts.length > 1 &&
            i === 0 &&
            /reasoning_effort|thinking|budget_tokens|unsupported parameter|unknown parameter|not support|invalid parameter/i.test(
              raw,
            );
          if (!paramRejected) break;
          this.logger.warn(
            `会话 ${sessionId} 附加参数被上游拒绝，去掉后重试: ${(err as Error).message}`,
          );
        }
      }

      // 批1-8：仍为空 → 关闭思考自动降级重试一次（正文必须有，思考不是必要环节）
      if (!lastErr && !answer.trim()) {
        this.logger.warn(`会话 ${sessionId} 生成结果为空，关闭思考自动重试一次`);
        try {
          const out = await runAttempt({ reasoning_effort: 'low' });
          answer = out.text;
          finishReason = out.reason;
        } catch (err) {
          if (abortController.signal.aborted) {
            this.logger.log(`会话 ${sessionId} 被客户端中止`);
            return;
          }
          lastErr = err;
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    // 流式失败（非客户端中止）→ 回滚刚落库的用户消息并抛错（controller 转 SSE error 事件）
    // P2-7：回答没生成，留着会让前端"重试"重复落库。检索阶段失败时用户消息还没建，无需处理。
    if (lastErr) {
      await this.prisma.chatMessage
        .deleteMany({
          where: { id: savedUserMsg.id, sessionId, role: 'user' },
        })
        .catch(() => undefined);
      const translated = this.translateLLMError(lastErr, images.length > 0);
      this.logger.warn(
        `会话 ${sessionId} LLM 调用失败: ${(lastErr as Error).message} → ${translated.message}`,
      );
      throw translated;
    }

    // 模型两次生成都为空（思考抢占上限 / 上游异常）→ 不落库空消息：
    // 回滚用户消息并给可操作提示，而不是静默给一条只有引用来源的空回答
    if (!answer.trim()) {
      await this.prisma.chatMessage
        .deleteMany({
          where: { id: savedUserMsg.id, sessionId, role: 'user' },
        })
        .catch(() => undefined);
      const translated = new BadRequestException(
        '模型两次生成都未返回内容（可能是上游异常，或思考过程占满了输出额度）。请点击「重试」再试一次；若反复出现，请把该会话的推理等级设为「关闭」，或检查「模型配置」的模型名与平台是否匹配。',
      );
      this.logger.warn(
        `会话 ${sessionId} 模型返回空内容（finish_reason=${finishReason ?? '未知'}）`,
      );
      throw translated;
    }

    // 批1-3：截断不静默——finish_reason=length 时在回答尾部附标记。
    // 历史里带此标记 + 用户回复"继续" → 走续写模式（放宽上限 + 提示接着写，见 buildPrompt）
    if (finishReason === 'length' && answer.trim()) {
      answer = `${answer.replace(/\s+$/, '')}\n\n> ${TRUNCATION_HINT}：回复「继续」可接着输出。`;
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

    // 记忆模块 A：回答落库后投递"滚动摘要折叠"任务（异步，不阻塞本轮响应）
    await this.memorySummaryService.schedule(sessionId);

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

  /**
   * 是否"代码解析/讲解"类问题（点名代码文件名，或含解析意图词）。
   * 影响：① buildPrompt 注入代码排版规范；② 流式调用设 max_tokens 上限防超时。
   */
  /** 问题点名的代码文件名（含扩展名）；未点名返回 null */
  private static namedCodeFile(question: string): string | null {
    return (
      question.match(
        /([A-Za-z0-9_\-]+\.(?:vue|ts|js|tsx|jsx|py|go|rs|java|c|cpp|cs|sh|sql))/i,
      )?.[1] ?? null
    );
  }

  private static wantsCodeWalkthrough(question: string): boolean {
    return (
      !!ChatService.namedCodeFile(question) ||
      /解析|逐行|讲解|每一行|怎么(写|做|实现|来的)|如何(实现|工作)|源码/.test(question)
    );
  }

  private buildPrompt(
    question: string,
    kbSources: RetrievalSource[],
    webSources: WebSource[],
    history: Array<{ role: string; content: string }>,
    useKnowledgeBase: boolean,
    imageDataUrls: string[],
    opts?: {
      walkthrough?: boolean;
      continuation?: boolean;
      parseMode?: 'overview' | 'deep' | 'full';
      lineByLine?: boolean;
      summary?: string; // 会话内滚动摘要（记忆模块 A）：早期对话浓缩，注入在历史原文之前
    },
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
    // 批1-3：续写模式（上一轮回答被截断并带标记，用户回复"继续"）
    if (opts?.continuation) {
      systemParts.push(
        '上一轮回答因长度上限被截断，用户回复「继续」：请严格接着上一轮末尾的内容继续输出（从断点续写），保持上一轮的回答排版风格，不要重复已经写过的内容，不要重新开头。',
      );
    }
    // 代码解析格式规范：A+B 三级模式各自一套（总览/深挖/整篇）。
    // A 标准（三模式通用）：贴出的代码必须完整（禁省略号跳过）、讲解必须落到行号与具体行为、禁空话凑数。
    const wantsCodeWalkthrough = opts?.walkthrough ?? ChatService.wantsCodeWalkthrough(question);
    const parseMode = opts?.parseMode ?? 'full';
    // 续写轮不重新注入排版规范（接着上一轮风格写即可），避免"从头再来"
    if (wantsCodeWalkthrough && !opts?.continuation) {
      if (parseMode === 'overview') {
        systemParts.push(
          '用户要求解析一个大文件（>300 行）。本次只输出【总览】，不要尝试逐函数深讲：',
          '1. 开头：`**[文件名]** 代码总览` + 一句话说明该文件做什么、用什么技术栈；',
          '2. 用表格列出主要函数/模块：`| 行号 | 函数/模块 | 干什么 | 关键技术点 |`——作用必须具体到真实行为，禁止"处理相关逻辑""实现相应功能"这类空话；',
          '3. 用 3-5 句话讲清文件整体流程（谁调用谁、每帧/事件触发顺序）；',
          '4. 结尾固定一句引导：`想深入哪个函数，回复「逐行讲解 <函数名>」。`',
        );
      } else if (parseMode === 'deep') {
        systemParts.push(
          '用户要逐行/详细深挖一个具体函数（已注入该函数带行号的完整源码）。要求：',
          '1. 直接对着行号逐段讲解，格式：`**L237-L242 鼠标引力源**` 标题 + 对应代码行 + 讲清「这行在算什么、为什么这么写、不这么写会怎样」；',
          '2. 贴出的代码必须与资料一致且完整，严禁用省略号跳过任何真实逻辑；',
          '3. 公式/算法（如开普勒、多普勒、插值）要讲清数学含义与数值来源；',
          '4. 若用户问的是具体行为（如"遮挡顺序""怎么工作"），先直接回答行为，再用行号佐证；',
          '5. 结尾给 2-3 条小结（这个函数的精髓/坑），不要大表格。',
        );
      } else if (opts?.lineByLine) {
        // 用户显式要求"每行代码 + 注释"的完整逐行输出（大文件也会整篇注入）
        systemParts.push(
          '用户要求把整个文件逐行输出并加注释。要求：',
          '1. 格式：按文件顺序逐行/每 10-20 行一组，代码块内为 `行号: 真实代码`，每组代码块下方写对应行的注释（这一行在做什么/为什么/注意点）；',
          '2. 必须覆盖到当前能够输出的最末尾，严禁用省略号/“跳过”省略任何行的代码与注释；',
          '3. 行号与代码必须与资料完全一致（资料已带真实行号），不得自编行号或代码；',
          '4. 开头一句话说明总行数与本次覆盖范围；若一次到输出上限还没写完，结尾写「已达输出上限，回复 继续 从断点接着输出」的提示（系统会自动附加），不要自行总结收尾。',
        );
      } else {
        systemParts.push(
          '用户要求解析代码（整篇/片段）。按以下要求输出（格式要求，非内容要求）：',
          '1. 开头：`**[文件名]** 完整解析` + `---`；按逻辑模块分段，每段 `##`/`###` 标题 + 真实行号范围 + 完整代码块；',
          '2. 贴出的代码必须与资料一致且完整，严禁用省略号跳过真实逻辑；',
          '3. 讲解必须落到具体代码与行号：每个关键语句讲清「在做什么、为什么这样写」，严禁用空话（如"实现相关功能""进行相应处理"）凑数；',
          '4. 每段后可按需给：**功能说明**（一句话）、**技术实现**（技术/API+关键点）、**设计意图**、**注意事项**（⚠️）；',
          '5. 变量/函数名用反引号、文件名用**文件名**、模块间用 `---` 分隔；',
          '6. 结尾必须有总结表格：`| 功能模块 | 核心变量/函数 | 主要作用 | 关键技术点 |`；',
          '7. 篇幅控制：超长内容优先讲清 核心结构与整体流程，宁可精简次要模块也要保证已讲部分真实、表格完整。',
        );
      }
      // 批1-5：本次没检索到任何代码、历史里也没有用户贴的代码 → 老实要代码，别硬编
      if (kbSources.length === 0) {
        systemParts.push(
          '注意：本次未检索到任何代码文件内容。若【历史对话】里也没有用户贴出的代码，请先在回答开头明确告诉用户：' +
            '"未找到可解析的代码——请点名要解析的文件名（如 HomeCosmos.vue），或直接把代码贴进对话。"' +
            '不要凭空编造对不存在代码的分析。',
        );
      }
    }
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

    // 记忆模块 A：早期对话的滚动摘要（放在历史原文前，时间线：梗概 → 近几轮原文 → 问题）
    const memoryText = opts?.summary
      ? `【历史摘要（早期对话浓缩；最新几轮的原文见下方）】\n${opts.summary}`
      : '';

    const userPrompt = [
      sourceText ? `【参考资料】\n${sourceText}` : '',
      memoryText,
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
    // 单文件按名直查（最高优先）：问题点名代码文件名 → 直接按文件名取该文件。
    // 不再要求"通读意图"——实测教训：问"chat.service.ts 有哪些方法"这类非解析问法，
    // 只靠向量召回会漏掉大部分 chunk（只命中 import 头块答非所问），文件名本身是最强信号。
    // 只问单个文件时走此通道；同时点名两个文件（对比类）→ 跳过，交给后续多路检索。
    const namedFileMatches = query.match(
      /([A-Za-z0-9_\-]+\.(?:vue|ts|js|tsx|jsx|py|go|rs|java|c|cpp|cs|sh|sql))/gi,
    );
    const namedFile = namedFileMatches?.[0] ?? null;
    if (namedFile && (namedFileMatches?.length ?? 0) === 1) {
      // 不限上限取回全文（供行号/符号定位用；是否整篇注入由大小决定）
      const ft = await this.ragService.loadDocumentByNameFulltext(
        userId,
        namedFile,
        kbScope,
        10_000_000,
      );
      const doc = ft.sources[0];
      if (doc) {
        const clean = stripChunkHeaders(doc.content);
        if (clean.length <= this.fulltextMaxChars) {
          this.logger.log(
            `会话 ${sessionId} 单文件按名直查：${namedFile}（${clean.length} 字符 ≤ 阈值，整篇注入）`,
          );
          return [
            {
              chunkId: doc.chunkId,
              content: clean,
              chunkIndex: -1,
              documentId: doc.documentId,
              filename: doc.filename,
              similarity: null,
            },
          ];
        }
        // 大文件：AST 现场解析符号清单 + 文件头（答"有哪些方法/函数/结构"足够，不撑爆上下文；
        // 不依赖 DB 符号表——服务器 code_symbols 曾为 0 行）
        const symbols = extractSymbols(doc.filename, clean);
        const lines = clean.split('\n');
        const head = numberLines(lines.slice(0, 30).join('\n'));
        const map = symbols
          .map(
            (s) =>
              `- L${s.startLine}-${s.endLine} ${s.kind} ${s.name}: ${s.signature
                .replace(
                  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|class|interface|type|enum)\s*/,
                  '',
                )
                .slice(0, 100)}`,
          )
          .join('\n');
        this.logger.log(
          `会话 ${sessionId} 单文件大文件按名直查：${namedFile}（${clean.length} 字符 > 阈值，注入符号清单 ${symbols.length} 个）`,
        );
        return [
          {
            chunkId: `${doc.documentId}:${namedFile}:map`,
            content: `文件：${doc.filename}（共 ${lines.length} 行，超过单次注入上限，已转为符号清单）\n\n## 符号清单（AST 现场解析）\n${map || '（未提取到符号）'}\n\n## 文件头部\n${head}`,
            chunkIndex: -1,
            documentId: doc.documentId,
            filename: doc.filename,
            similarity: null,
          },
        ];
      }
    }

    // C 符号命中：问题点名符号 → 返回实现源码。
    // 不只给符号实现：并做片段检索补充上下文（cap 8）——
    // 用户问"updateBlackHole 在哪被调用""rrfMerge 和 aggregateFulltext 区别"时，
    // 纯符号函数体答不了调用点/对比，需要片段提供上下文。
    // 片段先限定在符号所在文档内找（同文件上下文最相关），0 条再放宽全库。
    const symbolHits = await this.ragService.symbolLookup(userId, query, kbScope);
    if (symbolHits.length > 0) {
      const symDocIds = [...new Set(symbolHits.map((s) => s.documentId))];
      let ctx = await this.ragService.retrieve(userId, query, kbScope, 5, symDocIds);
      if (ctx.length === 0) {
        ctx = await this.ragService.retrieve(userId, query, kbScope, 5);
      }
      if (ctx.length > 0) {
        const seen = new Set(symbolHits.map((s) => s.chunkId));
        for (const s of ctx) {
          if (symbolHits.length >= 8) break;
          if (!seen.has(s.chunkId)) symbolHits.push(s);
        }
        this.logger.log(
          `会话 ${sessionId} 符号命中 ${symbolHits.length} 条（实现 + 片段上下文补充）`,
        );
        return symbolHits;
      }
      this.logger.log(`会话 ${sessionId} 符号命中 ${symbolHits.length} 条（问题包含符号名）`);
      return symbolHits;
    }

    // A 档案锁定：中文问题先语义定位文件，把检索范围从"全库"缩到"命中文件"。
    // topDocs 取 6 而非 3：问"黑洞特效"时 docs/24、35（标题含黑洞）必然排前二，
    // 若只锁 3 个，同主题代码文件（HomeCosmos.vue，档案含中文注释）可能被挤出锁定集。
    // 双路召回：
    //  1) 语义路：档案向量检索 top6（可能被教程文档占满——docs/03/36 语义超匹配"怎么实现"）；
    //  2) 关键词路：问题含业务词（登录/上传/报告…）时按模块路径确定性补召真实代码文件
    //     （auth.service.ts 这类无中文头注释的代码文件，语义路匹配不上"登录"，必须靠路径兜底）。
    // 合并去重（按 documentId），code 文件优先排前，教程文档靠后——避免"问实现给教程"。
    const locked = await this.ragService.profileLookup(userId, query, kbScope, 6);
    const keywordDocs = await this.ragService.profileLookupByKeyword(userId, query, kbScope, 4);
    const isCode = (fn: string) => /\.(ts|js|vue|tsx|jsx|py|go|rs|java|c|cpp|cs|sh|sql)$/i.test(fn);
    const seen = new Set<string>();
    const finalLocked: Array<{ documentId: string; filename: string }> = [];
    const push = (d: { documentId: string; filename: string }) => {
      if (!seen.has(d.documentId)) {
        seen.add(d.documentId);
        finalLocked.push(d);
      }
    };
    // 顺序：语义路 code → 关键词路 code → 语义路 md（教程等）
    for (const d of locked) if (isCode(d.filename)) push(d);
    for (const d of keywordDocs) if (isCode(d.filename)) push(d);
    for (const d of locked) if (!isCode(d.filename)) push(d);
    for (const d of keywordDocs) if (!isCode(d.filename)) push(d);
    const finalLockedTrim = finalLocked.slice(0, 8);
    const finalDocIds = finalLockedTrim.map((d) => d.documentId);
    if (finalLockedTrim.length > 0) {
      this.logger.log(
        `会话 ${sessionId} 档案锁定 ${finalLockedTrim.length} 个文档: ${finalLockedTrim.map((d) => d.filename).join(', ')}`,
      );
    }

    // A+C 联动：档案命中文件 → 拉该文件真实符号实现（函数体），
    // 避免大文件里 script 实现区被模板片段挤掉 topK 导致模型脑补
    if (finalDocIds.length > 0) {
      const symbolSources = await this.ragService.symbolsForDocs(userId, finalDocIds, 8);
      if (symbolSources.length > 0) {
        // 文件内语义检索补齐（符号优先，片段补充，总量 cap 到 8）
        const fileSources = await this.ragService.retrieve(userId, query, kbScope, 5, finalDocIds);
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
      finalDocIds.length > 0 ? finalDocIds : undefined,
    );
    if (sources.length > 0) {
      return sources;
    }

    // 档案锁定但文件内 0 条（如问的是跨文件的一般概念）→ 放宽到全库再检一次
    if (finalLockedTrim.length > 0) {
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
