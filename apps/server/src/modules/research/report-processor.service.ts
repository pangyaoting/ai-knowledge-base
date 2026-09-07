import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RagService, RetrievalSource } from '../chat/rag.service';
import { WebSearchService } from '../chat/web-search.service';
import { ModelConfigService, ChatTarget } from '../models/model-config.service';

export interface ReportJobData {
  userId: string;
  reportId: string;
}

interface ReportSection {
  index: number;
  question: string;
  content: string;
}

interface ReportSource {
  number: number;
  documentId: string;
  chunkIndex: number;
  filename: string;
  similarity: number;
}

/**
 * 研究报告生成管线（BullMQ worker 后台执行）：
 * ① 主题拆解成 3~5 个子问题 → ② 每个子问题检索知识库 + 撰写小节（并行）
 * → ③ 汇总成完整 Markdown 报告（引言/正文/结论，保留 [来源N] 标注）。
 * 报告耗时 1~2 分钟，所以走异步队列；status/step 供前端轮询进度。
 * BYO 强依赖：所有 LLM 调用都使用报告行快照的模型配置，token 由用户承担；
 * 未绑定配置 → 报告直接标记 failed 并提示先去「模型配置」绑定。
 */
@Injectable()
export class ReportProcessor {
  private readonly logger = new Logger(ReportProcessor.name);
  /** 本份报告累计消耗的 token（complete 内累计，结束时落库给数据看板统计） */
  private tokensUsed = 0;

  constructor(
    private prisma: PrismaService,
    private ragService: RagService,
    private webSearchService: WebSearchService,
    private modelConfigService: ModelConfigService,
    private configService: ConfigService,
  ) {}

  // —— 参数化上限（弱点②：.env 可配，默认保持原值）——
  /** 单节正文输出上限（token） */
  private get sectionMaxTokens(): number {
    return this.num('SECTION_MAX_TOKENS', 2000);
  }
  /** 联网搜索条数（每个子问题） */
  private get webResults(): number {
    return this.num('REPORT_WEB_RESULTS', 3);
  }
  private num(key: string, fallback: number): number {
    const v = Number(this.configService.get<string>(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  /** 一次 LLM 补全（非流式，使用用户自己的模型配置）；输出撞到 max_tokens 上限时记录日志 */
  private async complete(
    target: ChatTarget,
    system: string,
    user: string,
    maxTokens = 1200,
  ): Promise<string> {
    const client = new OpenAI({ apiKey: target.apiKey, baseURL: target.baseURL });
    const res = await client.chat.completions.create({
      model: target.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
    });
    const usage = res.usage;
    const total =
      usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
    this.tokensUsed += total;
    const choice = res.choices[0];
    if (choice?.finish_reason === 'length') {
      this.logger.warn(
        `LLM 输出达到 max_tokens(${maxTokens}) 上限，内容可能被截断：${user.slice(0, 40)}…`,
      );
    }
    return choice?.message?.content?.trim() ?? '';
  }

  /** 执行报告生成（任何异常把报告标记为 failed，不阻塞队列） */
  /** 从 report.kbScope 取限定检索的文档范围（kbScope: { scope, knowledgeBaseIds }；specific 无 ID 时退化为全库） */
  private scopeDocIds(report: { kbScope: unknown }): string[] | undefined {
    const scope = (report.kbScope ?? null) as {
      scope?: string;
      knowledgeBaseIds?: string[];
    } | null;
    if (scope?.scope === 'specific' && scope.knowledgeBaseIds?.length) {
      return scope.knowledgeBaseIds;
    }
    return undefined;
  }

  async processReport(data: ReportJobData) {
    const { userId, reportId } = data;
    this.tokensUsed = 0;
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, ownerId: userId },
    });
    if (!report) return;

    // 模型快照（无默认配置兜底）：创建报告时页面选定的配置+模型已快照在报告行上；
    // 配置被删/失效 → 快速失败 + 明确报错（不留半成品、不静默换模型）
    // 注：快照列为新加列，本地 client 未重生成 → 行类型用 any 兼容（CI 生成后真实存在）
    const reportSnap = report as unknown as {
      modelConfigId?: string | null;
      model?: string | null;
    };
    const target = await this.modelConfigService.resolveForChat(
      userId,
      reportSnap.modelConfigId ?? null,
      reportSnap.model ?? null,
    );
    if (!target) {
      await this.prisma.report.update({
        where: { id: reportId },
        data: {
          status: 'failed',
          error:
            '生成报告所用的模型不可用（配置可能已被删除）。请回到「研究报告」页顶部重新选择模型后重试。',
        },
      });
      return;
    }

    try {
      // 生成中是否被取消/删除（P1-4/P0-1）：被取消或已被删除则抛标记错误，外层 catch 干净退出
      const ensureRunning = async () => {
        const cur = await this.prisma.report.findUnique({
          where: { id: reportId },
          select: { status: true },
        });
        if (!cur || cur.status === 'cancelled') {
          const e = new Error('报告已被用户取消') as Error & { cancelled?: boolean };
          e.cancelled = true;
          throw e;
        }
      };

      // —— P0-1 取消竞态门控 ——
      // 所有状态推进都走 updateMany(status ∈ pending/processing)：
      // 排队期间/生成中被取消 → 0 行匹配 → 立即中止，绝不覆盖 cancelled、不继续扣 token。
      const ACTIVE = ['pending', 'processing'];
      const advance = (step: number, extra: Prisma.ReportUpdateManyMutationInput = {}) =>
        this.prisma.report.updateMany({
          where: { id: reportId, ownerId: userId, status: { in: ACTIVE } },
          data: { status: 'processing', step, ...extra },
        });

      // ① 拆解子问题（入口预检：排队期间已被取消 → 0 行，直接结束，不开始生成）
      const claimed = await advance(1);
      if (claimed.count === 0) {
        this.logger.log(`研究报告在排队期间已被取消，跳过生成: ${reportId}`);
        return;
      }
      const subQuestions = await this.splitTopic(target, report.topic);
      await ensureRunning();

      // ② 每个子问题：检索（知识库 + 联网并行）+ 撰写小节。
      //    小节用并发池而非 Promise.all：取消后尚未启动的小节直接跳过（止损），
      //    已在跑的 LLM 调用无法硬断，跑完即止。
      const step2 = await advance(2);
      if (step2.count === 0) return;
      const sections: ReportSection[] = [];
      const sourceMap = new Map<string, ReportSource>();
      let cancelledEarly = false;
      const CONCURRENCY = Math.min(3, subQuestions.length);
      let nextSection = 0;
      const worker = async () => {
        while (!cancelledEarly && nextSection < subQuestions.length) {
          const index = nextSection++;
          const question = subQuestions[index];
          await ensureRunning().catch((e) => {
            cancelledEarly = true;
            throw e;
          });
          if (cancelledEarly) return;
          const [kbRows, webRows] = await Promise.all([
            this.ragService.retrieve(userId, question, this.scopeDocIds(report), 4),
            this.webSearchService.search(question, this.webResults),
          ]);
          // 检索期间可能收到取消：再查一次，取消则不再调用 LLM
          await ensureRunning().catch((e) => {
            cancelledEarly = true;
            throw e;
          });
          if (cancelledEarly) return;
          const sources = kbRows.map((s) => {
            const existing = sourceMap.get(s.chunkId);
            const num = existing?.number ?? sourceMap.size + 1;
            if (!existing) {
              sourceMap.set(s.chunkId, {
                number: num,
                documentId: s.documentId,
                chunkIndex: s.chunkIndex,
                filename: s.filename,
                similarity: s.similarity ?? 0, // 检索片段必有相似度（null 仅出现在聊天的图谱扩展）
              });
            }
            return { ...s, num };
          });
          const content = await this.writeSection(target, question, sources, webRows);
          if (cancelledEarly) return; // 撰写期间被取消：丢弃本节，不写入结果
          sections.push({ index, question, content });
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      await ensureRunning();
      sections.sort((a, b) => a.index - b.index);

      // ③ 组装完整报告（引言/结论单独写，正文拼各小节原文——杜绝复述全文被截断）
      const step3 = await advance(3);
      if (step3.count === 0) return;
      const content = await this.assembleReport(target, report.topic, sections);
      // 汇总期间被取消：done 用条件更新，0 行 = 已 cancelled/failed → 不覆盖
      const done = await this.prisma.report.updateMany({
        where: { id: reportId, ownerId: userId, status: { in: ACTIVE } },
        data: {
          status: 'done',
          step: 4,
          content,
          tokensUsed: this.tokensUsed,
          sections: JSON.parse(JSON.stringify(sections)),
          sources: JSON.parse(
            JSON.stringify([...sourceMap.values()].sort((a, b) => a.number - b.number)),
          ),
        },
      });
      if (done.count === 0) {
        this.logger.log(`研究报告汇总完成前已被取消，放弃写入: ${reportId}`);
        return;
      }
      this.logger.log(`研究报告完成: ${reportId}，${sections.length} 节，${this.tokensUsed} token`);
    } catch (err) {
      // P1-4：用户主动取消 → 不覆盖成 failed（cancel 接口已置 cancelled）
      if ((err as Error & { cancelled?: boolean }).cancelled) {
        this.logger.log(`研究报告已被用户取消: ${reportId}`);
        return;
      }
      this.logger.warn(`研究报告失败: ${reportId} → ${(err as Error).message}`);
      await this.prisma.report.update({
        where: { id: reportId },
        data: { status: 'failed', error: (err as Error).message, tokensUsed: this.tokensUsed },
      });
    }
  }

  /** 主题 → 子问题列表（JSON 解析失败时按行拆分回退） */
  private async splitTopic(target: ChatTarget, topic: string): Promise<string[]> {
    const raw = await this.complete(
      target,
      '你是研究规划助手。把用户的研究主题拆解为 3~5 个具体的子问题，覆盖该主题的主要方面，用于后续检索资料和分节撰写。只输出 JSON 字符串数组，如 ["子问题一","子问题二"]，不要任何其他内容。',
      `研究主题：${topic}`,
      300,
    );
    try {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr) && arr.length > 0) {
        return arr
          .map((x) => String(x).trim())
          .filter(Boolean)
          .slice(0, 5);
      }
    } catch {
      /* fallthrough */
    }
    return raw
      .split('\n')
      .map((l) => l.replace(/^\d+[.、)\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 5);
  }

  /** 单个小节：知识库片段 + 联网资料 一起撰写（[来源N] 全局编号；[网N] 附网页链接） */
  private async writeSection(
    target: ChatTarget,
    question: string,
    sources: Array<RetrievalSource & { num: number }>,
    webSources: Array<{ title: string; url: string; content: string }>,
  ): Promise<string> {
    const kbText = sources.length
      ? sources
          .map((s) => `[${s.num}]（来自《${s.filename}》第 ${s.chunkIndex + 1} 段）\n${s.content}`)
          .join('\n\n')
      : '';
    const webText = webSources.length
      ? webSources
          .map(
            (w, i) =>
              `[网${i + 1}]（来自网页：${w.title}\n链接：${w.url}）\n${w.content?.slice(0, 1500)}`,
          )
          .join('\n\n')
      : '';
    const sourceText = [kbText, webText].filter(Boolean).join('\n\n') || '（未检索到资料）';
    const system =
      '你是严谨的研究撰写助手。根据【资料】撰写本小节内容：知识库资料标注 [来源N]、网页资料标注 [网N]（编号与资料一致）；资料没有的信息不要编造，可基于自身知识补充并注明"（补充）"。输出 Markdown。';
    const user = `【资料】\n${sourceText}\n\n【小节主题】\n${question}`;
    let content = await this.complete(target, system, user, this.sectionMaxTokens);
    // 弱点③质量门控：输出过短（<80 字）或资料存在却完全没引用 → 重写一次（限 1 次，控制成本）
    const hasKb = kbText.length > 0;
    const hasWeb = webText.length > 0;
    const looksThin =
      content.length < 80 ||
      (hasKb && !content.includes('[来源')) ||
      (hasWeb && !content.includes('[网'));
    if (looksThin) {
      this.logger.log(`小节质量门控触发重写：${question.slice(0, 30)}…`);
      content = await this.complete(
        target,
        '你是严谨的研究撰写助手。上次输出不合格（过短或未引用资料），请基于【资料】重写本小节：内容充实、结构完整，引用资料时标注 [来源N]/[网N]（编号与资料一致），资料没有的不要编造。',
        user,
        this.sectionMaxTokens,
      );
    }
    return content;
  }

  /**
   * 组装完整报告：引言 / 结论由 LLM 单独写（短调用），正文直接拼各小节原文。
   * 背景：旧实现让模型一次"复述"整份报告（引言+全部小节+结论），输出上限一到就被截断
   * （实测报告 4.2k 字结尾断句、缺结论）。改成代码拼接后，正文绝不截断，只剩短段落有上限。
   */
  private async assembleReport(
    target: ChatTarget,
    topic: string,
    sections: ReportSection[],
  ): Promise<string> {
    const titles = sections.map((s) => s.question).join('；');
    const intro = await this.complete(
      target,
      '你是研究报告主编。根据研究主题与各小节标题，写一段 120~200 字的引言：说明研究主题、资料范围与报告结构。只输出引言段落本身，不要标题。',
      `研究主题：${topic}\n各小节标题：${titles}`,
      300,
    );
    const conclusion = await this.complete(
      target,
      '你是研究报告主编。根据研究主题与各小节标题，写一段 150~250 字的结论：总结核心要点与资料局限。只输出结论段落本身，不要标题。',
      `研究主题：${topic}\n各小节标题：${titles}`,
      400,
    );
    const body = sections.map((s) => `### ${s.question}\n\n${s.content}`).join('\n\n');
    return `# ${topic}\n\n## 引言\n\n${intro}\n\n${body}\n\n## 结论\n\n${conclusion}`;
  }
}
