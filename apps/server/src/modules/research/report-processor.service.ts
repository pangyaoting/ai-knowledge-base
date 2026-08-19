import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RagService, RetrievalSource } from '../chat/rag.service';
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
 * BYO 强依赖：所有 LLM 调用都使用用户自己的默认模型配置，token 由用户承担；
 * 未绑定配置 → 报告直接标记 failed 并提示先去「模型配置」绑定。
 */
@Injectable()
export class ReportProcessor {
  private readonly logger = new Logger(ReportProcessor.name);

  constructor(
    private prisma: PrismaService,
    private ragService: RagService,
    private modelConfigService: ModelConfigService,
  ) {}

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
    const choice = res.choices[0];
    if (choice?.finish_reason === 'length') {
      this.logger.warn(
        `LLM 输出达到 max_tokens(${maxTokens}) 上限，内容可能被截断：${user.slice(0, 40)}…`,
      );
    }
    return choice?.message?.content?.trim() ?? '';
  }

  /** 执行报告生成（任何异常把报告标记为 failed，不阻塞队列） */
  async processReport(data: ReportJobData) {
    const { userId, reportId } = data;
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, ownerId: userId },
    });
    if (!report) return;

    // BYO：必须先绑定用户自己的默认模型配置，否则不消耗系统任何 token
    const target = await this.modelConfigService.resolveDefaultForUser(userId);
    if (!target) {
      await this.prisma.report.update({
        where: { id: reportId },
        data: {
          status: 'failed',
          error:
            '请先在「模型配置」绑定你自己的大模型 API Key（个人中心入口已移动到导航栏「模型配置」），再重新生成报告。',
        },
      });
      return;
    }

    try {
      // ① 拆解子问题
      await this.prisma.report.update({
        where: { id: reportId },
        data: { status: 'processing', step: 1 },
      });
      const subQuestions = await this.splitTopic(target, report.topic);

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
                similarity: s.similarity ?? 0, // 检索片段必有相似度（null 仅出现在聊天的图谱扩展）
              });
            }
            return { ...s, num };
          });
          const content = await this.writeSection(target, question, numbered);
          sections.push({ index, question, content });
        }),
      );
      sections.sort((a, b) => a.index - b.index);

      // ③ 组装完整报告（引言/结论单独写，正文拼各小节原文——杜绝复述全文被截断）
      await this.prisma.report.update({ where: { id: reportId }, data: { step: 3 } });
      const content = await this.assembleReport(target, report.topic, sections);
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

  /** 单个小节：检索片段 + 撰写（[来源N] 编号与全局一致） */
  private async writeSection(
    target: ChatTarget,
    question: string,
    sources: Array<RetrievalSource & { num: number }>,
  ): Promise<string> {
    const sourceText = sources.length
      ? sources
          .map((s) => `[${s.num}]（来自《${s.filename}》第 ${s.chunkIndex + 1} 段）\n${s.content}`)
          .join('\n\n')
      : '（未检索到相关资料）';
    return this.complete(
      target,
      '你是严谨的研究撰写助手。根据【资料】撰写本小节内容，引用时标注 [来源N]（编号与资料一致）；资料没有的信息不要编造，可基于自身知识补充并注明"（补充）"。输出 Markdown。',
      `【资料】\n${sourceText}\n\n【小节主题】\n${question}`,
      2000,
    );
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
