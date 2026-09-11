import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

/** 时间范围：近 7 天 / 近 30 天 / 全部（按月分桶） */
export type StatsRange = '7' | '30' | 'all';

/** Asia/Shanghai 固定 +08:00（无夏令时）——所有分桶统一按此时区，避免服务器 TZ=UTC 时跨零点串天 */
const SH_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

interface BucketRow {
  bucket: string;
  questions: bigint;
  tokens: bigint | null;
}

interface ResearchBucketRow {
  bucket: string;
  report: bigint | null;
  agent: bigint | null;
}

interface ModelRow {
  model: string | null;
  calls: bigint;
  tokens: bigint | null;
}

interface HourRow {
  hour: number;
  questions: bigint;
}

interface SessionRow {
  session_id: string;
  title: string;
  session_model: string | null;
  tokens: bigint | null;
  msgs: bigint;
}

interface CitedRow {
  filename: string | null;
  kb_name: string | null;
  hits: bigint;
}

interface KbRow {
  id: string;
  name: string;
  updated_at: Date;
  docs: bigint;
  chunks: bigint;
  cited: bigint;
}

/**
 * 数据看板统计服务（全部按当前用户 ownerId 隔离）。
 * 口径：
 * - 提问数 = 该用户的 user 消息数；对话 token = assistant 消息记录的流式 usage 汇总；
 * - 研究 token = reports.tokensUsed + agent_tasks.tokensUsed；
 * - 模型归因只统计「记录模型名之后」的回答（历史为 NULL → 不计入，不做"未记录"桶）；
 * - 所有日期/小时分桶统一按 Asia/Shanghai。
 */
@Injectable()
export class StatsService {
  constructor(private prisma: PrismaService) {}

  async overview(userId: string, range: StatsRange = '7') {
    const granularity: 'day' | 'month' = range === 'all' ? 'month' : 'day';
    const start = this.windowStart(range);
    const prevStart =
      range === 'all' ? null : new Date(start.getTime() - this.periodDays(range) * DAY_MS);
    const buckets = this.buckets(range);
    const bucketFmt = granularity === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';

    // 注：summary / userMemories / chatMessage.model 为较新的列与模型，
    // 本地 prisma client 未重生成时类型缺失 → 用 any 兼容（CI/部署端 generate 后真实存在）
    const prismaAny = this.prisma as any;

    const [
      kbCount,
      docCount,
      chunkCount,
      sessionCount,
      memoryCount,
      memoryRows,
      summarySessions,
      docStatusRows,
      rows,
      researchRows,
      hourRows,
      modelRows,
      prevModelRows,
      sessionRows,
      citedRows,
      kbRows,
      reportRows,
      agentRows,
      periodChatTokens,
      prevChatTokens,
      periodReportTokens,
      prevReportTokens,
      periodAgentTokens,
      prevAgentTokens,
      periodQuestions,
      prevQuestions,
      todayQuestions,
      yesterdayQuestions,
    ] = await Promise.all([
      this.prisma.knowledgeBase.count({ where: { ownerId: userId } }),
      this.prisma.document.count({ where: { knowledgeBase: { ownerId: userId } } }),
      this.prisma.chunk.count({ where: { document: { knowledgeBase: { ownerId: userId } } } }),
      this.prisma.chatSession.count({ where: { ownerId: userId } }),
      prismaAny.userMemory.count({ where: { ownerId: userId } }),
      prismaAny.userMemory.groupBy({
        by: ['category'],
        where: { ownerId: userId },
        _count: { _all: true },
      }) as Promise<Array<{ category: string; _count: { _all: number } }>>,
      prismaAny.chatSession.count({
        where: { ownerId: userId, summary: { not: null } },
      }) as Promise<number>,
      this.prisma.document.groupBy({
        by: ['status'],
        where: { knowledgeBase: { ownerId: userId } },
        _count: { _all: true },
      }) as unknown as Promise<Array<{ status: string; _count: { _all: number } }>>,
      this.messageBuckets(userId, prevStart ?? start, bucketFmt),
      this.researchBuckets(userId, prevStart ?? start, bucketFmt),
      this.hourlyQuestions(userId, start),
      this.modelTokens(userId, start, null),
      prevStart ? this.modelTokens(userId, start, prevStart) : Promise.resolve([]),
      this.topSessions(userId, start),
      this.topCited(userId, start),
      this.kbStats(userId, start),
      this.prisma.report.groupBy({
        by: ['status'],
        where: { ownerId: userId, createdAt: { gte: start } },
        _count: { _all: true },
        _avg: { tokensUsed: true },
      }) as unknown as Promise<
        Array<{ status: string; _count: { _all: number }; _avg: { tokensUsed: number | null } }>
      >,
      this.prisma.agentTask.groupBy({
        by: ['status'],
        where: { ownerId: userId, createdAt: { gte: start } },
        _count: { _all: true },
        _avg: { searchRounds: true, pagesRead: true },
      }) as unknown as Promise<
        Array<{
          status: string;
          _count: { _all: number };
          _avg: { searchRounds: number | null; pagesRead: number | null };
        }>
      >,
      this.tokenSum(userId, start, null),
      prevStart
        ? this.tokenSum(userId, start, prevStart)
        : Promise.resolve({ chat: 0, questions: 0 }),
      this.researchTokenSum('report', userId, start, prevStart),
      prevStart
        ? this.researchTokenSum('report', userId, start, prevStart, true)
        : Promise.resolve(0),
      this.researchTokenSum('agent', userId, start, prevStart),
      prevStart
        ? this.researchTokenSum('agent', userId, start, prevStart, true)
        : Promise.resolve(0),
      this.questionCount(userId, start, null),
      prevStart ? this.questionCount(userId, start, prevStart) : Promise.resolve(0),
      this.questionCount(userId, this.shanghaiDayStart(0), null),
      this.questionCount(userId, this.shanghaiDayStart(1), this.shanghaiDayStart(0)),
    ]);

    const researchTokens = periodReportTokens + periodAgentTokens;
    const prevResearchTokens = prevReportTokens + prevAgentTokens;
    const totalTokens = periodChatTokens.chat + researchTokens;
    const prevTotalTokens = prevChatTokens.chat + prevResearchTokens;

    // 分桶数据拆两段：本期（>= 首个桶）用于画本期曲线；更早的部分 = 上一等长周期（画虚线对比）
    const currentRows = rows.filter((r) => r.bucket >= buckets[0]);
    const currentResearchRows = researchRows.filter((r) => r.bucket >= buckets[0]);
    const prevQuestionSeries =
      range === 'all'
        ? []
        : rows
            .filter((r) => r.bucket < buckets[0])
            .sort((a, b) => (a.bucket < b.bucket ? -1 : 1))
            .map((r) => Number(r.questions))
            .slice(-this.periodDays(range));

    // 模型归因：本期 + 上期（算环比）；历史（model 为空）不计入
    const prevModelMap = new Map(prevModelRows.map((r) => [r.model ?? '', Number(r.tokens ?? 0)]));
    const models = modelRows.map((r) => {
      const tokens = Number(r.tokens ?? 0);
      const prev = prevModelMap.get(r.model ?? '') ?? 0;
      return {
        model: r.model ?? '未知模型',
        tokens,
        calls: Number(r.calls),
        delta: prev > 0 ? (tokens - prev) / prev : null,
      };
    });

    const docHealth = { done: 0, processing: 0, failed: 0 };
    for (const r of docStatusRows) {
      const n = r._count._all;
      if (r.status === 'done') docHealth.done += n;
      else if (r.status === 'failed') docHealth.failed += n;
      else docHealth.processing += n; // pending / processing
    }

    // 研究任务状态（报告 + Agent 合并）：完成 / 进行中 / 已停止 / 失败
    const researchStatus = { done: 0, running: 0, stopped: 0, failed: 0 };
    for (const r of reportRows) {
      if (r.status === 'done') researchStatus.done += r._count._all;
      else if (r.status === 'failed') researchStatus.failed += r._count._all;
      else if (r.status === 'cancelled') researchStatus.stopped += r._count._all;
      else researchStatus.running += r._count._all;
    }
    for (const r of agentRows) {
      if (r.status === 'done') researchStatus.done += r._count._all;
      else if (r.status === 'failed') researchStatus.failed += r._count._all;
      else if (r.status === 'stopped') researchStatus.stopped += r._count._all;
      else researchStatus.running += r._count._all;
    }
    const agentAvgSearch =
      agentRows.reduce((a, r) => a + (r._avg.searchRounds ?? 0) * r._count._all, 0) /
      Math.max(
        1,
        agentRows.reduce((a, r) => a + r._count._all, 0),
      );
    const agentAvgPages =
      agentRows.reduce((a, r) => a + (r._avg.pagesRead ?? 0) * r._count._all, 0) /
      Math.max(
        1,
        agentRows.reduce((a, r) => a + r._count._all, 0),
      );
    const reportAvgTokens =
      reportRows.reduce((a, r) => a + (r._avg.tokensUsed ?? 0) * r._count._all, 0) /
      Math.max(
        1,
        reportRows.reduce((a, r) => a + r._count._all, 0),
      );

    return {
      range,
      generatedAt: new Date().toISOString(),
      kpi: {
        tokens: totalTokens,
        tokensDelta: prevTotalTokens > 0 ? (totalTokens - prevTotalTokens) / prevTotalTokens : null,
        questions: periodQuestions,
        questionsDelta:
          prevQuestions > 0 ? (periodQuestions - prevQuestions) / prevQuestions : null,
        todayQuestions,
        todayDelta:
          yesterdayQuestions > 0
            ? (todayQuestions - yesterdayQuestions) / yesterdayQuestions
            : null,
        docFailed: docHealth.failed,
      },
      assets: {
        kbs: kbCount,
        documents: docCount,
        chunks: chunkCount,
        avgChunksPerDoc: docCount > 0 ? Number((chunkCount / docCount).toFixed(1)) : 0,
        sessions: sessionCount,
        memories: memoryCount,
        sessionsWithSummary: summarySessions,
      },
      docHealth,
      tokens: {
        chat: periodChatTokens.chat,
        report: periodReportTokens,
        agent: periodAgentTokens,
      },
      daily: this.fillBuckets(buckets, currentRows, currentResearchRows),
      prevDailyQuestions: prevQuestionSeries,
      hourly: this.fillHourly(hourRows),
      models,
      topSessions: sessionRows.map((r) => ({
        id: r.session_id,
        title: r.title,
        model: r.session_model,
        tokens: Number(r.tokens ?? 0),
        messages: Number(r.msgs),
      })),
      topCited: citedRows.map((r) => ({
        filename: r.filename ?? '（未知文档）',
        kb: r.kb_name,
        hits: Number(r.hits),
      })),
      topKbs: kbRows.map((r) => ({
        id: r.id,
        name: r.name,
        documents: Number(r.docs),
        chunks: Number(r.chunks),
        cited: Number(r.cited),
        updatedAt: r.updated_at,
      })),
      research: {
        status: researchStatus,
        avgSearchRounds: Number(agentAvgSearch.toFixed(1)),
        avgPagesRead: Number(agentAvgPages.toFixed(1)),
        avgReportTokens: Math.round(reportAvgTokens),
      },
      memory: {
        total: memoryCount,
        byCategory: memoryRows
          .map((r) => ({ category: r.category, count: r._count._all }))
          .sort((a, b) => b.count - a.count),
      },
    };
  }

  // ==================== 查询片段 ====================

  /** 对话消息按桶聚合：提问数（user）+ 对话 token（assistant usage） */
  private messageBuckets(userId: string, start: Date, fmt: string): Promise<BucketRow[]> {
    return this.prisma.$queryRaw<BucketRow[]>`
      SELECT to_char(m.created_at AT TIME ZONE 'Asia/Shanghai', ${fmt}) AS bucket,
             COUNT(*) FILTER (WHERE m.role = 'user') AS questions,
             SUM(m.prompt_tokens + m.completion_tokens) FILTER (WHERE m.role = 'assistant') AS tokens
      FROM chat_messages m
      JOIN chat_sessions s ON s.id = m.session_id
      WHERE s.owner_id = ${userId} AND m.created_at >= ${start}
      GROUP BY bucket
      ORDER BY bucket
    `;
  }

  /** 研究类 token 按桶聚合（报告 token 与 Agent token 分开，供堆叠图三段展示） */
  private researchBuckets(userId: string, start: Date, fmt: string): Promise<ResearchBucketRow[]> {
    return this.prisma.$queryRaw<ResearchBucketRow[]>`
      SELECT bucket, SUM(report) AS report, SUM(agent) AS agent FROM (
        SELECT to_char(r.created_at AT TIME ZONE 'Asia/Shanghai', ${fmt}) AS bucket,
               r.tokens_used AS report, 0 AS agent
        FROM reports r WHERE r.owner_id = ${userId} AND r.created_at >= ${start}
        UNION ALL
        SELECT to_char(a.created_at AT TIME ZONE 'Asia/Shanghai', ${fmt}) AS bucket,
               0 AS report, a.tokens_used AS agent
        FROM agent_tasks a WHERE a.owner_id = ${userId} AND a.created_at >= ${start}
      ) t GROUP BY bucket ORDER BY bucket
    `;
  }

  /** 提问时段分布（24 小时，Asia/Shanghai） */
  private hourlyQuestions(userId: string, start: Date): Promise<HourRow[]> {
    return this.prisma.$queryRaw<HourRow[]>`
      SELECT EXTRACT(HOUR FROM m.created_at AT TIME ZONE 'Asia/Shanghai')::int AS hour,
             COUNT(*) AS questions
      FROM chat_messages m
      JOIN chat_sessions s ON s.id = m.session_id
      WHERE s.owner_id = ${userId} AND m.role = 'user' AND m.created_at >= ${start}
      GROUP BY hour ORDER BY hour
    `;
  }

  /**
   * 各模型 token 消耗（只统计记录了模型名的回答）。
   * prevStart 非空 = 取 [prevStart, start) 区间的上期数据（算环比）。
   */
  private modelTokens(userId: string, start: Date, prevStart: Date | null): Promise<ModelRow[]> {
    return prevStart
      ? this.prisma.$queryRaw<ModelRow[]>`
          SELECT m.model, COUNT(*) AS calls,
                 SUM(COALESCE(m.prompt_tokens, 0) + COALESCE(m.completion_tokens, 0)) AS tokens
          FROM chat_messages m
          JOIN chat_sessions s ON s.id = m.session_id
          WHERE s.owner_id = ${userId} AND m.role = 'assistant' AND m.model IS NOT NULL
            AND m.created_at >= ${prevStart} AND m.created_at < ${start}
          GROUP BY m.model
        `
      : this.prisma.$queryRaw<ModelRow[]>`
          SELECT m.model, COUNT(*) AS calls,
                 SUM(COALESCE(m.prompt_tokens, 0) + COALESCE(m.completion_tokens, 0)) AS tokens
          FROM chat_messages m
          JOIN chat_sessions s ON s.id = m.session_id
          WHERE s.owner_id = ${userId} AND m.role = 'assistant' AND m.model IS NOT NULL
            AND m.created_at >= ${start}
          GROUP BY m.model
          ORDER BY tokens DESC
        `;
  }

  /** 本期对话 token 合计与提问数（供 KPI 与环比） */
  private async tokenSum(
    userId: string,
    start: Date,
    prevStart: Date | null,
  ): Promise<{ chat: number; questions: number }> {
    const rows = prevStart
      ? await this.prisma.$queryRaw<Array<{ chat: bigint | null; questions: bigint }>>`
          SELECT SUM(m.prompt_tokens + m.completion_tokens) AS chat,
                 COUNT(*) FILTER (WHERE m.role = 'user') AS questions
          FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
          WHERE s.owner_id = ${userId} AND m.created_at >= ${prevStart} AND m.created_at < ${start}
        `
      : await this.prisma.$queryRaw<Array<{ chat: bigint | null; questions: bigint }>>`
          SELECT SUM(m.prompt_tokens + m.completion_tokens) AS chat,
                 COUNT(*) FILTER (WHERE m.role = 'user') AS questions
          FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
          WHERE s.owner_id = ${userId} AND m.created_at >= ${start}
        `;
    const r = rows[0];
    return { chat: Number(r?.chat ?? 0), questions: Number(r?.questions ?? 0) };
  }

  /** 研究类 token 合计（kind: report / agent）；prev=true 时取上期 */
  private async researchTokenSum(
    kind: 'report' | 'agent',
    userId: string,
    start: Date,
    prevStart: Date | null,
    prev = false,
  ): Promise<number> {
    const from = prev && prevStart ? prevStart : start;
    const rows =
      kind === 'report'
        ? prev && prevStart
          ? await this.prisma.$queryRaw<Array<{ sum: bigint | null }>>`
              SELECT SUM(tokens_used) AS sum FROM reports
              WHERE owner_id = ${userId} AND created_at >= ${from} AND created_at < ${start}
            `
          : await this.prisma.$queryRaw<Array<{ sum: bigint | null }>>`
              SELECT SUM(tokens_used) AS sum FROM reports
              WHERE owner_id = ${userId} AND created_at >= ${from}
            `
        : prev && prevStart
          ? await this.prisma.$queryRaw<Array<{ sum: bigint | null }>>`
              SELECT SUM(tokens_used) AS sum FROM agent_tasks
              WHERE owner_id = ${userId} AND created_at >= ${from} AND created_at < ${start}
            `
          : await this.prisma.$queryRaw<Array<{ sum: bigint | null }>>`
              SELECT SUM(tokens_used) AS sum FROM agent_tasks
              WHERE owner_id = ${userId} AND created_at >= ${from}
            `;
    return Number(rows[0]?.sum ?? 0);
  }

  /** 提问数（prevStart 非空 = 取 [prevStart, start) 上期） */
  private async questionCount(
    userId: string,
    start: Date,
    prevStart: Date | null,
  ): Promise<number> {
    const rows = prevStart
      ? await this.prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT COUNT(*) AS n FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
          WHERE s.owner_id = ${userId} AND m.role = 'user'
            AND m.created_at >= ${prevStart} AND m.created_at < ${start}
        `
      : await this.prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT COUNT(*) AS n FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
          WHERE s.owner_id = ${userId} AND m.role = 'user' AND m.created_at >= ${start}
        `;
    return Number(rows[0]?.n ?? 0);
  }

  /** 最烧 token 的会话 Top5（按会话聚合本期 assistant usage） */
  private topSessions(userId: string, start: Date): Promise<SessionRow[]> {
    return this.prisma.$queryRaw<SessionRow[]>`
      SELECT m.session_id, s.title, s.model AS session_model,
             SUM(COALESCE(m.prompt_tokens, 0) + COALESCE(m.completion_tokens, 0)) AS tokens,
             COUNT(*) AS msgs
      FROM chat_messages m
      JOIN chat_sessions s ON s.id = m.session_id
      WHERE s.owner_id = ${userId} AND m.role = 'assistant' AND m.created_at >= ${start}
      GROUP BY m.session_id, s.title, s.model
      ORDER BY tokens DESC
      LIMIT 5
    `;
  }

  /** 被引用最多的资料 Top5（从回答的 sources.kb 展开统计） */
  private topCited(userId: string, start: Date): Promise<CitedRow[]> {
    // 子查询包一层再聚合：避免 "column src must appear in GROUP BY"（PG 不认 src->>'x' 的函数依赖）
    return this.prisma.$queryRaw<CitedRow[]>`
      SELECT filename, MAX(kb_name) AS kb_name, COUNT(*) AS hits FROM (
        SELECT src->>'filename' AS filename,
               (SELECT kb.name FROM documents d JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
                WHERE d.id::text = src->>'documentId' LIMIT 1) AS kb_name
        FROM chat_messages m
        JOIN chat_sessions s ON s.id = m.session_id
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(m.sources->'kb', '[]'::jsonb)) AS src
        WHERE s.owner_id = ${userId} AND m.role = 'assistant' AND m.created_at >= ${start}
      ) t
      GROUP BY filename
      ORDER BY hits DESC
      LIMIT 5
    `;
  }

  /** 知识库：文档数 / 切块数 / 本期被引用次数 / 最近更新（按被引用降序取前 5） */
  private kbStats(userId: string, start: Date): Promise<KbRow[]> {
    return this.prisma.$queryRaw<KbRow[]>`
      SELECT kb.id, kb.name, kb.updated_at,
             (SELECT COUNT(*) FROM documents d WHERE d.knowledge_base_id = kb.id) AS docs,
             (SELECT COUNT(*) FROM chunks c JOIN documents d ON d.id = c.document_id
              WHERE d.knowledge_base_id = kb.id) AS chunks,
             COALESCE((
               SELECT COUNT(*) FROM chat_messages m
               JOIN chat_sessions s ON s.id = m.session_id
               CROSS JOIN LATERAL jsonb_array_elements(COALESCE(m.sources->'kb', '[]'::jsonb)) AS src
               JOIN documents d2 ON d2.id::text = src->>'documentId'
               WHERE d2.knowledge_base_id = kb.id AND s.owner_id = ${userId}
                 AND m.role = 'assistant' AND m.created_at >= ${start}
             ), 0) AS cited
      FROM knowledge_bases kb
      WHERE kb.owner_id = ${userId}
      ORDER BY cited DESC, kb.updated_at DESC
      LIMIT 5
    `;
  }

  // ==================== 时间桶工具（统一 Asia/Shanghai） ====================

  private periodDays(range: StatsRange): number {
    return range === '30' ? 30 : 7;
  }

  /** 上海时区的"今天 0 点"（daysAgo=1 即昨天 0 点）对应的 UTC 时刻 */
  private shanghaiDayStart(daysAgo: number): Date {
    const t = new Date(Date.now() + SH_MS);
    const dayStartUtc = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
    return new Date(dayStartUtc - SH_MS - daysAgo * DAY_MS);
  }

  /** 本期起点（日粒度 = 含今天在内的 N 天；月粒度 = 含本月在内的 6 个月） */
  private windowStart(range: StatsRange): Date {
    if (range === 'all') {
      const t = new Date(Date.now() + SH_MS);
      const monthStartUtc = Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 5, 1);
      return new Date(monthStartUtc - SH_MS);
    }
    const n = this.periodDays(range);
    return new Date(this.shanghaiDayStart(n - 1).getTime());
  }

  /** 桶列表（连续补零用）：日粒度 YYYY-MM-DD ×N；月粒度 YYYY-MM ×6 */
  private buckets(range: StatsRange): string[] {
    const out: string[] = [];
    if (range === 'all') {
      const t = new Date(Date.now() + SH_MS);
      for (let i = 5; i >= 0; i--) {
        const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - i, 1));
        out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
      }
      return out;
    }
    const n = this.periodDays(range);
    for (let i = n - 1; i >= 0; i--) {
      const t = new Date(Date.now() + SH_MS - i * DAY_MS);
      out.push(
        `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(
          t.getUTCDate(),
        ).padStart(2, '0')}`,
      );
    }
    return out;
  }

  /** 补全桶（没有数据的日期补 0，图表连续） */
  private fillBuckets(
    buckets: string[],
    rows: BucketRow[],
    researchRows: ResearchBucketRow[],
  ): Array<{
    key: string;
    questions: number;
    tokens: number;
    reportTokens: number;
    agentTokens: number;
  }> {
    const map = new Map(rows.map((r) => [r.bucket, r]));
    const researchMap = new Map(researchRows.map((r) => [r.bucket, r]));
    return buckets.map((key) => {
      const research = researchMap.get(key);
      return {
        key,
        questions: Number(map.get(key)?.questions ?? 0),
        tokens: Number(map.get(key)?.tokens ?? 0),
        reportTokens: Number(research?.report ?? 0),
        agentTokens: Number(research?.agent ?? 0),
      };
    });
  }

  /** 补全 24 小时 */
  private fillHourly(rows: HourRow[]): number[] {
    const out = new Array(24).fill(0) as number[];
    for (const r of rows) {
      const h = Number(r.hour);
      if (h >= 0 && h < 24) out[h] = Number(r.questions);
    }
    return out;
  }
}
