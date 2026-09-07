import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import OpenAI from 'openai';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ModelConfigService } from '../models/model-config.service';

const QUEUE_NAME = 'memory-summarize';
/** 至少这么多条"被挤出窗口"的新消息才值得折叠一次 */
const MIN_FOLD_MSGS = 4;
/** 折叠用消息单条截断与总量上限（防 token 失控） */
const MSG_CHAR_CAP = 1200;
const FOLD_CHAR_CAP = 7000;
/** 摘要输出上限（字），生成后兜底截断 */
const SUMMARY_CHAR_CAP = 800;

/**
 * 记忆模块 A：会话内滚动摘要（异步，不阻塞回答链路）。
 * - 触发：每轮回答落库后 schedule 一个 job（同 sessionId 同 jobId，天然去重堆积）；
 * - worker：把"被挤出原文窗口、且上次折叠之后"的消息，增量合并进 session.summary，
 *   用乐观锁（summaryAt 匹配才写回）防并发重复折叠；
 * - 注入：chat.service buildPrompt 把 summary 放在【历史对话】之前。
 * 摘要失败静默（消息原文全量在库里不丢，只是少折叠一批）。
 */
@Injectable()
export class MemorySummaryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MemorySummaryService.name);
  private queue!: Queue;
  private worker!: Worker;

  constructor(
    private prisma: PrismaService,
    private modelConfigService: ModelConfigService,
    private configService: ConfigService,
  ) {}

  private get connection() {
    return {
      host: this.configService.get<string>('REDIS_HOST', 'localhost'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
      password: this.configService.get<string>('REDIS_PASSWORD') || undefined,
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => Math.min(times * 500, 5000),
    };
  }

  /** 原文窗口（轮数，.env MEMORY_ROUNDS 可调；默认 3 轮 = 6 条原文） */
  private get memoryRounds(): number {
    const v = Number(this.configService.get<string>('MEMORY_ROUNDS', '3'));
    return Number.isFinite(v) && v >= 1 && v <= 10 ? Math.floor(v) : 3;
  }

  onApplicationBootstrap() {
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const sessionId = job.data.sessionId as string;
        await this.processSession(sessionId);
      },
      { connection: this.connection, concurrency: 1 }, // 串行：同会话折叠天然互斥
    );
    this.worker.on('completed', (job) => this.logger.log(`记忆折叠完成: ${job.id}`));
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`记忆折叠失败(将重试): ${job?.id} → ${err.message}`),
    );
    this.logger.log('记忆摘要队列已启动（BullMQ + Redis）');
  }

  /** 每轮回答落库后调用：投递折叠任务（同会话同 jobId，进行中不重复入队） */
  async schedule(sessionId: string): Promise<void> {
    try {
      await this.queue.add(
        'summarize',
        { sessionId },
        {
          jobId: `sum-${sessionId}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          // 失败即移除：同 jobId 入队会命中"已存在"的失败 job 而不新建（BullMQ 去重语义），
          // 若保留失败 job，一次模型报错后该会话的摘要折叠将永久停摆（历史修复）。
          removeOnFail: true,
        },
      );
    } catch (err) {
      this.logger.warn(`记忆折叠入队失败(忽略): ${(err as Error).message}`);
    }
  }

  /** 折叠主流程：窗口外且上次折叠后的消息 ≥ 阈值 → 增量合并摘要 */
  private async processSession(sessionId: string): Promise<void> {
    // 注：summary/summaryAt 为新加列，本地 prisma client 未重生成时类型缺失 → 用 any 兼容；
    // CI/部署端 prisma generate 后字段真实存在，any 同样成立。
    const prisma = this.prisma as any;
    const session = await prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        ownerId: true,
        modelConfigId: true,
        model: true,
        summary: true,
        summaryAt: true,
      },
    });
    if (!session) return;

    const msgs = await this.prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, createdAt: true },
    });
    // 保留最近 N 轮原文；其余是折叠候选（仅取上次折叠之后新增的部分）
    const keepCount = this.memoryRounds * 2;
    const foldMsgs = msgs.filter((m: { createdAt: Date }, i: number) => {
      if (i >= msgs.length - keepCount) return false;
      if (!session.summaryAt) return true; // 首次折叠：窗口外全部
      return new Date(m.createdAt) > new Date(session.summaryAt);
    });
    if (foldMsgs.length < MIN_FOLD_MSGS) return;

    const oldAt = session.summaryAt;
    // 增量压缩：已有摘要 + 新增消息 → 新摘要
    const newText = foldMsgs
      .map(
        (m: { role: string; content: string }) =>
          `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, MSG_CHAR_CAP)}`,
      )
      .join('\n')
      .slice(0, FOLD_CHAR_CAP);

    const target =
      (await this.modelConfigService.resolveForChat(
        session.ownerId,
        session.modelConfigId,
        session.model,
      )) ?? (await this.modelConfigService.resolveDefaultForUser(session.ownerId));
    if (!target) return; // 无可用模型配置 → 跳过（用户没绑 key，本来也没法答）

    const client = new OpenAI({ apiKey: target.apiKey, baseURL: target.baseURL });
    const res = await client.chat.completions.create({
      model: target.model,
      messages: [
        {
          role: 'system',
          content:
            '你是对话记忆压缩器。把【已有摘要】与【新增对话】合并成一份更精简的会话摘要。' +
            '只保留影响后续对话的事实：用户做出的决定/约定、提到的文件路径与函数名、' +
            '技术选型与偏好、进行中的任务、未解决的问题。丢弃寒暄与细节。' +
            '用中文，条目化，不超过 300 字，直接输出摘要正文，不要任何开场白。',
        },
        {
          role: 'user',
          content: `【已有摘要】\n${session.summary || '（无）'}\n\n【新增对话】\n${newText}`,
        },
      ],
      max_tokens: 500,
      temperature: 0.3,
    });
    const summary = (res.choices[0]?.message?.content ?? '').trim().slice(0, SUMMARY_CHAR_CAP);
    if (!summary) return;

    // 乐观锁写回：summaryAt 仍为旧值才允许覆盖（另一并发 job 已折叠则放弃）
    const updated = await prisma.chatSession.updateMany({
      where: { id: sessionId, summaryAt: oldAt ?? null },
      data: { summary, summaryAt: new Date() },
    });
    if (updated.count > 0) {
      this.logger.log(
        `会话 ${sessionId} 摘要折叠：合并 ${foldMsgs.length} 条消息 → ${summary.length} 字`,
      );
    }
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
  }
}
