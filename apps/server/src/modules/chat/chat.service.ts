import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { RagService, RetrievalSource } from './rag.service';
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
   * @param writer 回调：把事件写进 SSE 响应
   * @param signal 客户端断开时 abort（不浪费 token）
   */
  async askAndStream(
    userId: string,
    sessionId: string,
    question: string,
    writer: StreamWriter,
    signal: AbortSignal,
  ) {
    const session = await this.getSession(userId, sessionId);

    // ① 检索：问题向量化 → Top-K 来源片段
    const sources = await this.ragService.retrieve(
      userId,
      question,
      session.knowledgeBaseId ?? undefined,
    );
    writer('sources', sources);

    // ② 保存用户消息
    await this.prisma.chatMessage.create({
      data: { sessionId, role: 'user', content: question },
    });

    // ③ 历史对话（最近 3 轮）
    const history = await this.prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      take: HISTORY_ROUNDS,
    });

    // ④ 组装 Prompt
    const { system, messages } = this.buildPrompt(question, sources, history);

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

    // ⑥ 流式结束：落库助手消息 + 引用来源
    await this.prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content: answer,
        sources: sources as unknown as Prisma.InputJsonValue,
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
    sources: RetrievalSource[],
    history: Array<{ role: string; content: string }>,
  ): { system: string; messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] } {
    const system = [
      '你是一个严谨的 AI 知识库问答助手。',
      '请仅根据提供的【参考资料】回答用户问题。',
      '如果参考资料中没有相关信息，请明确说明"资料库中未找到相关内容"，不要编造。',
      '回答中引用资料时请标注 [来源1]、[来源2] 等编号（编号与参考资料一致）。',
      '回答使用简洁、结构化的中文。',
    ].join('\n');

    // 检索到的资料（带编号和文档来源）
    const sourceText = sources.length
      ? sources
          .map(
            (s, i) =>
              `[${i + 1}]（来自文档《${s.filename}》第 ${s.chunkIndex + 1} 段）\n${s.content}`,
          )
          .join('\n\n')
      : '（本次没有检索到任何资料）';

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
