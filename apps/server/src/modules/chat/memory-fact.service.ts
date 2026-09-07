import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import OpenAI from 'openai';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ModelConfigService } from '../models/model-config.service';

const QUEUE_NAME = 'memory-facts';
/** 游标后至少新增这么多条消息才值得抽一次（正常每轮新增 2 条 = 一轮问答） */
const MIN_NEW_MSGS = 2;
/** 抽取输入只取最近这么多条（越久远的事实越可能已被覆盖，且控制 token） */
const RECENT_MSGS = 6;
/** 单条消息截断与输入总量上限 */
const MSG_CHAR_CAP = 1000;
const INPUT_CHAR_CAP = 6000;
/** 单条记忆内容上限（字）——注入与手写共用同一上限，保证提示词里每条约等长 */
export const FACT_CHAR_CAP = 120;
/** 每人记忆条数上限（超出后停止新增；防事实库无限膨胀） */
export const MAX_FACTS = 50;
/** 合法分类 */
export const FACT_CATEGORIES = ['general', 'preference', 'background', 'goal'] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

interface ExtractedFact {
  category: FactCategory;
  content: string;
}

/**
 * 记忆模块 B：跨会话用户事实记忆（异步，不阻塞回答链路）。
 * - 触发：每轮回答落库后 schedule 一个 job（同会话同 jobId，进行中不重复入队）；
 * - worker：抽取"上次游标之后"的新消息 → LLM JSON 抽取用户持久事实
 *   （身份/背景/偏好/目标/决定），精确去重（content 相同不重复存）+ 每人上限 50 条；
 * - 游标：抽取成功后把 memory_extract_at 推进到最后一条被处理的消息（失败不推进 → 下轮自动重试）；
 * - 注入：chat.service buildPrompt 把最近 top-3 事实放【用户记忆】块置顶注入；
 * - 管理：GET/POST/DELETE /api/user-memories（跨会话查看/手写/删除）。
 * 抽取失败静默（消息原文全量在库里不丢，只少记一批事实）。
 */
@Injectable()
export class MemoryFactService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MemoryFactService.name);
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

  onApplicationBootstrap() {
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const sessionId = job.data.sessionId as string;
        await this.processSession(sessionId);
      },
      { connection: this.connection, concurrency: 1 }, // 串行：同用户写库天然互斥
    );
    this.worker.on('completed', (job) => this.logger.log(`用户事实抽取完成: ${job.id}`));
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`用户事实抽取失败(将重试): ${job?.id} → ${err.message}`),
    );
    this.logger.log('用户事实记忆队列已启动（BullMQ + Redis）');
  }

  /** 每轮回答落库后调用：投递抽取任务（同会话同 jobId，进行中不重复入队） */
  async schedule(sessionId: string): Promise<void> {
    try {
      await this.queue.add(
        'extract',
        { sessionId },
        {
          jobId: `fact-${sessionId}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          // 失败即移除：同 jobId 入队会命中"已存在"的失败 job 而不新建（BullMQ 去重语义），
          // 若保留失败 job，一次 LLM 报错后该会话的事实抽取将永久停摆。
          removeOnFail: true,
        },
      );
    } catch (err) {
      this.logger.warn(`用户事实抽取入队失败(忽略): ${(err as Error).message}`);
    }
  }

  /** 抽取主流程：游标后的新消息 → LLM JSON 抽取 → 去重入库 → 推进游标 */
  private async processSession(sessionId: string): Promise<void> {
    // 注：userMemory / memoryExtractAt 为本地 prisma client 未重生成的模型/列 → 用 any 兼容；
    // CI/部署端 prisma generate 后字段真实存在，any 同样成立。
    const prisma = this.prisma as any;
    const session = (await prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        ownerId: true,
        modelConfigId: true,
        model: true,
        memoryEnabled: true,
        memoryExtractAt: true,
      },
    })) as {
      id: string;
      ownerId: string;
      modelConfigId: string | null;
      model: string | null;
      memoryEnabled: boolean | null;
      memoryExtractAt: Date | null;
    } | null;
    if (!session) return;
    if (session.memoryEnabled === false) return; // 用户停用记忆 → 本会话不再抽取

    const msgs = await this.prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, createdAt: true },
    });
    const cursor = session.memoryExtractAt ? new Date(session.memoryExtractAt) : null;
    // 游标后的新消息（首次 = 全部）；不足一轮（<2 条）不抽
    const newMsgs = msgs.filter(
      (m: { createdAt: Date }) => !cursor || new Date(m.createdAt) > cursor,
    );
    if (newMsgs.length < MIN_NEW_MSGS) return;
    const inputMsgs = newMsgs.slice(-RECENT_MSGS);
    const lastMinedAt = (newMsgs[newMsgs.length - 1] as { createdAt: Date }).createdAt;

    const target =
      (await this.modelConfigService.resolveForChat(
        session.ownerId,
        session.modelConfigId,
        session.model,
      )) ?? (await this.modelConfigService.resolveDefaultForUser(session.ownerId));
    if (!target) return; // 无可用模型配置 → 跳过（用户没绑 key，本来也没法答）

    const inputText = inputMsgs
      .map(
        (m: { role: string; content: string }) =>
          `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, MSG_CHAR_CAP)}`,
      )
      .join('\n')
      .slice(0, INPUT_CHAR_CAP);

    const client = new OpenAI({ apiKey: target.apiKey, baseURL: target.baseURL });
    const res = await client.chat.completions.create({
      model: target.model,
      messages: [
        {
          role: 'system',
          content:
            '你是用户档案抽取器。从【对话】中抽取【关于用户本人的持久事实】——跨会话还记得住才有价值：' +
            '身份/背景（年级、专业、职业阶段、项目背景、时间线）、偏好（技术栈/风格/工具/回答格式）、' +
            '正在推进的目标、做出的重要决定。' +
            '输出严格的 JSON 数组，元素形如 {"category":"background","content":"..."}；' +
            `category 只能是 ${FACT_CATEGORIES.join('/')}。` +
            '规则：只抽取用户明确说出或强烈暗示的事实；丢弃寒暄、一次性提问与代码细节；同义重复合并为一条；' +
            `content 用中文一句话（≤${FACT_CHAR_CAP} 字），自带关键限定（时间/程度/对象/范围）；没有事实就输出 []。` +
            '只输出 JSON 数组，禁止任何其他文字或 markdown 围栏。',
        },
        { role: 'user', content: `【对话】\n${inputText}` },
      ],
      max_tokens: 400,
      temperature: 0.2,
    });
    const raw = (res.choices[0]?.message?.content ?? '').trim();
    const facts = this.parseFacts(raw);

    // 去重（content 精确匹配）+ 上限 50 → 入库
    const existingRows = await prisma.userMemory.findMany({
      where: { ownerId: session.ownerId },
      select: { content: true },
    });
    const seen = new Set<string>(
      (existingRows as Array<{ content: string }>).map((r) => r.content),
    );
    const toAdd: Array<{
      ownerId: string;
      content: string;
      category: FactCategory;
      sourceSessionId: string;
    }> = [];
    for (const f of facts) {
      if (seen.has(f.content)) continue;
      if (seen.size >= MAX_FACTS) {
        this.logger.warn(
          `用户 ${session.ownerId} 记忆已达上限 ${MAX_FACTS} 条，本次新增被截断（共发现 ${facts.length} 条候选）`,
        );
        break;
      }
      seen.add(f.content);
      toAdd.push({
        ownerId: session.ownerId,
        content: f.content,
        category: f.category,
        sourceSessionId: session.id,
      });
    }

    if (toAdd.length > 0) {
      await prisma.userMemory.createMany({ data: toAdd });
      this.logger.log(
        `会话 ${sessionId} 用户事实抽取：新增 ${toAdd.length} 条（输入 ${inputMsgs.length} 条消息）`,
      );
    } else {
      this.logger.log(`会话 ${sessionId} 用户事实抽取：无可新增事实（候选 ${facts.length} 条）`);
    }
    // 推进游标（只有走到这里——LLM 成功返回——才推进；失败抛错则不推进，下轮重试）
    await prisma.chatSession.update({
      where: { id: sessionId },
      data: { memoryExtractAt: lastMinedAt },
    });
  }

  /** 解析 LLM 输出为事实数组（容忍 ```json 围栏与 {"facts":[...]} 包装；坏数据静默丢弃） */
  private parseFacts(raw: string): ExtractedFact[] {
    let text = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    if (!text) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { facts?: unknown }).facts)
        ? (parsed as { facts: unknown[] }).facts
        : null;
    if (!arr) return [];

    const out: ExtractedFact[] = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as { content?: unknown; category?: unknown };
      const content =
        typeof obj.content === 'string' ? obj.content.trim().slice(0, FACT_CHAR_CAP) : '';
      if (!content) continue;
      const category =
        typeof obj.category === 'string' &&
        (FACT_CATEGORIES as readonly string[]).includes(obj.category)
          ? (obj.category as FactCategory)
          : 'general';
      out.push({ category, content });
    }
    return out;
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
  }
}
