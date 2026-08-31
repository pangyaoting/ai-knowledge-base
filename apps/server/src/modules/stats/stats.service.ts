import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface DailyStat {
  day: string; // YYYY-MM-DD
  questions: number;
  tokens: number; // 对话 token
  researchTokens: number; // 研究报告 + 自主研究 token
}

/**
 * 数据看板统计服务：全部按当前用户隔离（ownerId）
 * 问题数 = 该用户的 user 消息数；Token = assistant 消息上记录的流式 usage 汇总
 */
@Injectable()
export class StatsService {
  constructor(private prisma: PrismaService) {}

  async overview(userId: string) {
    const [
      kbs,
      documents,
      chunks,
      messages,
      tokenAgg,
      questionsToday,
      dailyRows,
      topKbs,
      reports,
      agentTasksDone,
      reportTokenAgg,
      agentTaskTokenAgg,
      researchDailyRows,
    ] = await Promise.all([
      this.prisma.knowledgeBase.count({ where: { ownerId: userId } }),
      this.prisma.document.count({ where: { knowledgeBase: { ownerId: userId } } }),
      this.prisma.chunk.count({ where: { document: { knowledgeBase: { ownerId: userId } } } }),
      this.prisma.chatMessage.count({ where: { session: { ownerId: userId } } }),
      this.prisma.chatMessage.aggregate({
        where: { session: { ownerId: userId }, role: 'assistant' },
        _sum: { promptTokens: true, completionTokens: true },
      }),
      this.prisma.chatMessage.count({
        where: {
          session: { ownerId: userId },
          role: 'user',
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
      this.prisma.$queryRaw<Array<{ day: Date; questions: bigint; tokens: bigint | null }>>`
          SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
                 COUNT(*) FILTER (WHERE role = 'user') AS questions,
                 SUM(prompt_tokens + completion_tokens) FILTER (WHERE role = 'assistant') AS tokens
          FROM chat_messages
          WHERE session_id IN (SELECT id FROM chat_sessions WHERE owner_id = ${userId})
            AND created_at >= now() - interval '6 days'
          GROUP BY day
          ORDER BY day
        `,
      this.prisma.knowledgeBase.findMany({
        where: { ownerId: userId },
        include: { _count: { select: { documents: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 5,
      }),
      this.prisma.report.count({ where: { ownerId: userId, status: 'done' } }),
      this.prisma.agentTask.count({ where: { ownerId: userId, status: 'done' } }),
      this.prisma.report.aggregate({
        where: { ownerId: userId },
        _sum: { tokensUsed: true },
      }),
      this.prisma.agentTask.aggregate({
        where: { ownerId: userId },
        _sum: { tokensUsed: true },
      }),
      // 研究类 token 按天聚合（研究报告 + 自主研究），供"近 7 日 Token"图表单独画一条线
      this.prisma.$queryRaw<Array<{ day: Date; tokens: bigint | null }>>`
          SELECT day, SUM(tokens) AS tokens FROM (
            SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day, tokens_used AS tokens
            FROM reports WHERE owner_id = ${userId} AND created_at >= now() - interval '6 days'
            UNION ALL
            SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day, tokens_used AS tokens
            FROM agent_tasks WHERE owner_id = ${userId} AND created_at >= now() - interval '6 days'
          ) t GROUP BY day
        `,
    ]);

    const promptTotal = tokenAgg._sum.promptTokens ?? 0;
    const completionTotal = tokenAgg._sum.completionTokens ?? 0;
    const reportTokens = reportTokenAgg._sum.tokensUsed ?? 0;
    const agentTaskTokens = agentTaskTokenAgg._sum.tokensUsed ?? 0;

    return {
      counts: {
        kbs,
        documents,
        chunks,
        messages,
        questionsToday,
        reports,
        agentTasks: agentTasksDone,
      },
      tokens: {
        // 总消耗 = 对话 + 研究报告 + 自主研究（卡片顶部展示全量）
        total: promptTotal + completionTotal + reportTokens + agentTaskTokens,
        promptTotal,
        completionTotal,
        // 研究报告 / 自主研究 消耗的 token（与对话 token 分开统计）
        reportTokens,
        agentTaskTokens,
      },
      daily: this.fillLast7Days(
        dailyRows.map((r) => ({
          day: r.day,
          questions: Number(r.questions),
          tokens: Number(r.tokens ?? 0),
        })),
        new Map(researchDailyRows.map((r) => [this.fmt(r.day), Number(r.tokens ?? 0)])),
      ),
      topKbs: topKbs.map((kb) => ({
        id: kb.id,
        name: kb.name,
        documents: kb._count.documents,
      })),
    };
  }

  /** 补全最近 7 天（没有数据的日期补 0，保证图表连续） */
  private fillLast7Days(
    rows: Array<{ day: Date; questions: number; tokens: number }>,
    researchMap: Map<string, number>,
  ): DailyStat[] {
    const map = new Map(rows.map((r) => [this.fmt(r.day), r]));
    const out: DailyStat[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const key = this.fmt(d);
      out.push({
        day: key,
        questions: map.get(key)?.questions ?? 0,
        tokens: map.get(key)?.tokens ?? 0,
        researchTokens: researchMap.get(key) ?? 0,
      });
    }
    return out;
  }

  private fmt(d: Date): string {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }
}
