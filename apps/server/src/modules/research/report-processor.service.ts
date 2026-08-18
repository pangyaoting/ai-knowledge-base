import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RagService, RetrievalSource } from '../chat/rag.service';

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
 */
@Injectable()
export class ReportProcessor {
  private readonly logger = new Logger(ReportProcessor.name);
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

  private get model(): string {
    return this.configService.get<string>('DEEPSEEK_MODEL', 'deepseek-chat');
  }

  /** 一次 LLM 补全（非流式） */
  private async complete(system: string, user: string, maxTokens = 1200): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
    });
    return res.choices[0]?.message?.content?.trim() ?? '';
  }

  /** 执行报告生成（任何异常把报告标记为 failed，不阻塞队列） */
  async processReport(data: ReportJobData) {
    const { userId, reportId } = data;
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, ownerId: userId },
    });
    if (!report) return;
    try {
      // ① 拆解子问题
      await this.prisma.report.update({
        where: { id: reportId },
        data: { status: 'processing', step: 1 },
      });
      const subQuestions = await this.splitTopic(report.topic);

      // ② 每个子问题：检索 + 撰写小节（并行，来源编号全局统一）
      await this.prisma.report.update({ where: { id: reportId }, data: { step: 2 } });
      const sections: ReportSection[] = [];
      const sourceMap = new Map<string, ReportSource>();
      await Promise.all(
        subQuestions.map(async (question, index) => {
          const sources = await this.ragService.retrieve(userId, question, undefined, 4);
          const numbered = sources.map((s) => {
            const existing = sourceMap.get(s.chunkId);
            const num = existing?.number ?? sourceMap.size + 1;
            if (!existing) {
              sourceMap.set(s.chunkId, {
                number: num,
                documentId: s.documentId,
                chunkIndex: s.chunkIndex,
                filename: s.filename,
                similarity: s.similarity,
              });
            }
            return { ...s, num };
          });
          const content = await this.writeSection(question, numbered);
          sections.push({ index, question, content });
        }),
      );
      sections.sort((a, b) => a.index - b.index);

      // ③ 汇总成完整报告
      await this.prisma.report.update({ where: { id: reportId }, data: { step: 3 } });
      const content = await this.mergeReport(report.topic, sections);
      await this.prisma.report.update({
        where: { id: reportId },
        data: {
          status: 'done',
          step: 4,
          content,
          sections: JSON.parse(JSON.stringify(sections)),
          sources: JSON.parse(
            JSON.stringify([...sourceMap.values()].sort((a, b) => a.number - b.number)),
          ),
        },
      });
      this.logger.log(`研究报告完成: ${reportId}，${sections.length} 节`);
    } catch (err) {
      this.logger.warn(`研究报告失败: ${reportId} → ${(err as Error).message}`);
      await this.prisma.report.update({
        where: { id: reportId },
        data: { status: 'failed', error: (err as Error).message },
      });
    }
  }

  /** 主题 → 子问题列表（JSON 解析失败时按行拆分回退） */
  private async splitTopic(topic: string): Promise<string[]> {
    const raw = await this.complete(
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

  /** 单个小节：检索片段 + 撰写（[来源N] 编号与全局一致） */
  private async writeSection(
    question: string,
    sources: Array<RetrievalSource & { num: number }>,
  ): Promise<string> {
    const sourceText = sources.length
      ? sources
          .map((s) => `[${s.num}]（来自《${s.filename}》第 ${s.chunkIndex + 1} 段）\n${s.content}`)
          .join('\n\n')
      : '（未检索到相关资料）';
    return this.complete(
      '你是严谨的研究撰写助手。根据【资料】撰写本小节内容，引用时标注 [来源N]（编号与资料一致）；资料没有的信息不要编造，可基于自身知识补充并注明"（补充）"。输出 Markdown。',
      `【资料】\n${sourceText}\n\n【小节主题】\n${question}`,
      1000,
    );
  }

  /** 汇总：引言 + 各小节 + 结论 */
  private async mergeReport(topic: string, sections: ReportSection[]): Promise<string> {
    const body = sections.map((s) => `### ${s.question}\n\n${s.content}`).join('\n\n');
    return this.complete(
      '你是研究报告主编。根据各小节内容输出一份完整的研究报告 Markdown：标题、引言（说明研究主题与资料范围）、正文（按小节组织，保留各小节的 [来源N] 标注）、结论（总结要点与资料局限）。不要遗漏小节内容，不要编造来源编号。',
      `【研究主题】\n${topic}\n\n【各小节内容】\n\n${body}`,
      2500,
    );
  }
}
