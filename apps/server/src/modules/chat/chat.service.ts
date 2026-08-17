import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RagService, RetrievalSource } from './rag.service';
import { WebSearchService, WebSource } from './web-search.service';
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
  private client: OpenAI;

  constructor(
    private prisma: PrismaService,
    private ragService: RagService,
    private webSearchService: WebSearchService,
    private configService: ConfigService,
  ) {
    this.client = new OpenAI({
      apiKey: this.configService.get<string>('DEEPSEEK_API_KEY'),
      baseURL: this.configService.get<string>('DEEPSEEK_BASE_URL'),
    });
  }

  // ==================== 会话管理 ====================

  async createSession(userId: string, dto: CreateSessionDto) {
    return this.prisma.chatSession.create({
      data: {
        ownerId: userId,
        title: dto.title || '新对话',
        knowledgeBaseId: dto.knowledgeBaseId || null,
      },
    });
  }

  /** 我的会话列表（带消息数和最后一条消息预览） */
  async listSessions(userId: string) {
    const sessions = await this.prisma.chatSession.findMany({
      where: { ownerId: userId },
      include: {
        _count: { select: { messages: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return sessions;
  }

  /** 获取会话并校验归属 */
  async getSession(userId: string, sessionId: string) {
    const session = await this.prisma.chatSession.findFirst({
      where: { id: sessionId, ownerId: userId },
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
  ) {
    const session = await this.getSession(userId, sessionId);

    // ① 双路检索（并行）：知识库向量检索 + 可选联网搜索
    const [kbSources, webSources] = await Promise.all([
      this.ragService.retrieve(userId, question, session.knowledgeBaseId ?? undefined),
      useWebSearch ? this.webSearchService.search(question) : Promise.resolve([]),
    ]);
    writer('sources', { kb: kbSources, web: webSources });

    // ② 保存用户消息
    await this.prisma.chatMessage.create({
      data: { sessionId, role: 'user', content: question },
    });

    // ③ 历史对话（最近 3 轮）：先按时间倒序取最近 N 条，再反转回时间正序
    //（注意：不能 orderBy asc + take，那会取到【最早】的 N 条——上下文会越聊越旧）
    const history = await this.prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_ROUNDS,
    });
    history.reverse();

    // ④ 组装 Prompt（知识库资料 + 网络资料一起注入）
    const { system, messages } = this.buildPrompt(question, kbSources, webSources, history);

    // ⑤ DeepSeek 流式生成，逐字转发为 SSE delta 事件
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    let answer = '';
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.configService.get<string>('DEEPSEEK_MODEL', 'deepseek-chat'),
          messages: [{ role: 'system', content: system }, ...messages],
          stream: true,
        },
        { signal: abortController.signal }, // 客户端断开时中止生成，不浪费 token
      );

      for await (const part of stream) {
        const delta = part.choices[0]?.delta?.content;
        if (delta) {
          answer += delta;
          writer('delta', { content: delta });
        }
      }
    } catch (err) {
      // 客户端主动断开 → 静默停止，不扣后续 token
      if (abortController.signal.aborted) {
        this.logger.log(`会话 ${sessionId} 被客户端中止`);
        return;
      }
      throw err;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    // ⑥ 流式结束：落库助手消息 + 引用来源（知识库 + 网络）
    await this.prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content: answer,
        // JSON.parse(JSON.stringify()) 转成纯 JSON，兼容各版本 Prisma 客户端类型
        sources: JSON.parse(JSON.stringify({ kb: kbSources, web: webSources })),
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
  ): { system: string; messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] } {
    const system = [
      '你是一个严谨的 AI 问答助手，具备两个知识来源：私有知识库资料和联网搜索到的网络资料。',
      '回答时请结合两者：优先以【参考资料】中的知识库内容为准；知识库没有的、但【网络资料】中有的事实，可以引用网络资料。',
      '如果两类资料都没有相关信息，请明确说明"未找到相关内容"，不要编造。',
      '回答中引用资料时请标注 [来源1]、[来源2] 等编号（编号与资料一致），网络资料请附上对应链接。',
      '回答使用简洁、结构化的中文。',
    ].join('\n');

    let number = 0;
    // 知识库检索到的资料
    const kbText = kbSources.length
      ? kbSources
          .map((s) => {
            number += 1;
            return `[${number}]（来自文档《${s.filename}》第 ${s.chunkIndex + 1} 段）\n${s.content}`;
          })
          .join('\n\n')
      : '（知识库中没有检索到相关资料）';

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
      '【参考资料】',
      sourceText,
      '',
      history.length ? `【历史对话】\n${historyText}` : '',
      '',
      '【用户问题】',
      question,
    ]
      .filter((s) => s !== '')
      .join('\n');

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'user', content: userPrompt },
    ];
    return { system, messages };
  }
}
