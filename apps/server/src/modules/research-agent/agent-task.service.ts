import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AgentQueueService } from './agent-queue.service';
import { CreateAgentTaskDto } from './dto/create-agent-task.dto';
import { ExtendAgentTaskDto } from './dto/extend-agent-task.dto';

/** 预算 → 预估研究时长（分钟）：10万≈40 分钟，线性外推，封顶 6 小时 */
export function estimateMinutes(tokenBudget: number): number {
  return Math.min(360, Math.round((tokenBudget / 100_000) * 40));
}

/** 任务总预算上限（含续时追加）：100 万 token */
const AGENT_TOTAL_BUDGET_MAX = 1_000_000;

/** 给前端的任务结构（progress 只暴露方向元信息，内部断点不外泄） */
export interface PublicAgentTask {
  id: string;
  mode: 'targeted' | 'open';
  goal: string | null;
  startAt: Date;
  endAt: Date;
  tokenBudget: number;
  tokensUsed: number;
  searchRounds: number;
  pagesRead: number;
  status: string;
  stopReason: string | null;
  directions: Array<{ title: string; question: string; status: string; rounds: number }>;
  report: string | null;
  summary: string | null;
  sources: Array<{ number: number; title: string; url: string }>;
  error: string | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 自主研究任务服务：创建（校验时间窗/预算/目标 → 建 pending → 入队）、
 * 列表、详情（轮询进度）、手动停止、续时/加预算（从断点续跑）、删除。
 * 实际研究逻辑在 AgentRunner（队列 worker 后台执行）。
 */
@Injectable()
export class AgentTaskService {
  constructor(
    private prisma: PrismaService,
    private queue: AgentQueueService,
  ) {}

  private toPublic(task: {
    id: string;
    mode: string;
    goal: string | null;
    startAt: Date;
    endAt: Date;
    tokenBudget: number;
    tokensUsed: number;
    searchRounds: number;
    pagesRead: number;
    status: string;
    stopReason: string | null;
    progress: unknown;
    report: string | null;
    summary: string | null;
    sources: unknown;
    error: string | null;
    finishedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): PublicAgentTask {
    const progress = (task.progress ?? {}) as { directions?: unknown };
    const directions = Array.isArray(progress.directions)
      ? (
          progress.directions as Array<{
            title: string;
            question: string;
            status: string;
            rounds: number;
          }>
        ).map((d) => ({
          title: d.title,
          question: d.question,
          status: d.status,
          rounds: d.rounds,
        }))
      : [];
    return {
      id: task.id,
      mode: task.mode === 'open' ? 'open' : 'targeted',
      goal: task.goal,
      startAt: task.startAt,
      endAt: task.endAt,
      tokenBudget: task.tokenBudget,
      tokensUsed: task.tokensUsed,
      searchRounds: task.searchRounds,
      pagesRead: task.pagesRead,
      status: task.status,
      stopReason: task.stopReason,
      directions,
      report: task.report,
      summary: task.summary,
      sources: (task.sources as PublicAgentTask['sources']) ?? [],
      error: task.error,
      finishedAt: task.finishedAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  /** 创建自主研究任务（立即返回 pending） */
  async create(userId: string, dto: CreateAgentTaskDto) {
    // 定向研究必须有目标；开放探索可省略
    if (dto.mode === 'targeted' && !dto.goal?.trim()) {
      throw new BadRequestException('定向研究需要填写研究目标');
    }
    const now = new Date();
    const startAt = dto.startAt ? new Date(dto.startAt) : now;
    // 未传结束时间 → 按预算预估时长预填（用户始终可以在前端改；停止以用户设定时间为准）
    const endAt = dto.endAt
      ? new Date(dto.endAt)
      : new Date(startAt.getTime() + estimateMinutes(dto.tokenBudget) * 60_000);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new BadRequestException('时间格式不正确');
    }
    if (endAt.getTime() <= startAt.getTime()) {
      throw new BadRequestException('结束时间必须晚于开始时间');
    }
    const task = await this.prisma.agentTask.create({
      data: {
        ownerId: userId,
        mode: dto.mode,
        goal: dto.goal?.trim() || null,
        startAt,
        endAt,
        tokenBudget: dto.tokenBudget,
      },
    });
    // startAt 在未来 → 延迟入队，到点自动开跑
    const delay = Math.max(0, startAt.getTime() - Date.now());
    await this.queue.addAgentJob({ userId, taskId: task.id }, delay);
    return this.toPublic(task);
  }

  /** 我的任务列表（倒序） */
  async list(userId: string): Promise<PublicAgentTask[]> {
    const tasks = await this.prisma.agentTask.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
    });
    return tasks.map((t) => this.toPublic(t));
  }

  /** 单任务详情（轮询进度用；归属校验，他人 404） */
  async findOne(userId: string, id: string): Promise<PublicAgentTask> {
    const task = await this.prisma.agentTask.findFirst({ where: { id, ownerId: userId } });
    if (!task) throw new NotFoundException('研究任务不存在');
    return this.toPublic(task);
  }

  /**
   * 手动停止：置为 stopped（runner 会在下一个检查点收尾并补写阶段成果）。
   * 任务尚未开始（pending 排队中 / awaiting_confirm 待确认）时停止 = 取消：
   * runner 不在跑，不会产出报告，用 stopReason=cancelled 标记（前端据此停止轮询）。
   */
  async stop(userId: string, id: string): Promise<PublicAgentTask> {
    const task = await this.findOne(userId, id);
    if (!['pending', 'running', 'awaiting_confirm'].includes(task.status)) {
      throw new BadRequestException('任务已结束，无法停止');
    }
    const notStarted = task.status === 'pending' || task.status === 'awaiting_confirm';
    await this.prisma.agentTask.update({
      where: { id },
      data: {
        status: 'stopped',
        stopReason: notStarted ? 'cancelled' : 'user_stopped',
        finishedAt: new Date(),
      },
    });
    return this.findOne(userId, id);
  }

  /** 确认方向并开始研究（awaiting_confirm → pending 重新入队，runner 从断点续跑） */
  async confirm(userId: string, id: string): Promise<PublicAgentTask> {
    const task = await this.findOne(userId, id);
    if (task.status !== 'awaiting_confirm') {
      throw new BadRequestException('任务不在「待确认」状态，无法开始');
    }
    if (new Date(task.endAt).getTime() <= Date.now()) {
      throw new BadRequestException('已过结束时间，无法开始；请先续时或删除后重建');
    }
    await this.prisma.agentTask.update({
      where: { id },
      data: { status: 'pending', stopReason: null, error: null },
    });
    await this.queue.addAgentJob({ userId, taskId: id });
    return this.findOne(userId, id);
  }

  /** 重新拆解方向（仅限待确认任务）：清空断点重新入队，runner 重新拆解 */
  async redecompose(userId: string, id: string): Promise<PublicAgentTask> {
    const task = await this.findOne(userId, id);
    if (task.status !== 'awaiting_confirm') {
      throw new BadRequestException('只有待确认的任务可以重新拆解');
    }
    await this.prisma.agentTask.update({
      where: { id },
      data: {
        status: 'pending',
        progress: Prisma.DbNull,
        directions: Prisma.DbNull,
        searchRounds: 0,
        pagesRead: 0,
        stopReason: null,
        error: null,
      },
    });
    await this.queue.addAgentJob({ userId, taskId: id });
    return this.findOne(userId, id);
  }

  /**
   * 续时 / 加预算：仅限已停止的任务（预算用尽 / 时间到 / 手动停止）。
   * 追加 token 和/或分钟 → status 回到 pending 重新入队，从断点续跑。
   */
  async extend(userId: string, id: string, dto: ExtendAgentTaskDto): Promise<PublicAgentTask> {
    const task = await this.findOne(userId, id);
    if (task.status !== 'stopped') {
      throw new BadRequestException('只有已停止的任务才能续时/加预算');
    }
    if (task.stopReason === 'completed' || task.stopReason === 'error') {
      throw new BadRequestException('已完成或失败的任务不能续时');
    }
    const extraTokens = dto.extraTokens ?? 0;
    const extraMinutes = dto.extraMinutes ?? 0;
    if (extraTokens <= 0 && extraMinutes <= 0) {
      throw new BadRequestException('请至少追加 token 预算或续时');
    }
    const newBudget = Math.min(task.tokenBudget + extraTokens, AGENT_TOTAL_BUDGET_MAX);
    const newEndAt = new Date(new Date(task.endAt).getTime() + extraMinutes * 60_000);
    await this.prisma.agentTask.update({
      where: { id },
      data: {
        tokenBudget: newBudget,
        endAt: newEndAt,
        status: 'pending',
        stopReason: null,
        finishedAt: null,
        error: null,
      },
    });
    await this.queue.addAgentJob({ userId, taskId: id });
    return this.findOne(userId, id);
  }

  async remove(userId: string, id: string) {
    await this.findOne(userId, id);
    await this.prisma.agentTask.delete({ where: { id } });
    return { success: true };
  }
}
