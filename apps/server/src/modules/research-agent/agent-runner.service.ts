import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ModelConfigService, ChatTarget } from '../models/model-config.service';
import { WebSearchService, WebSource } from '../chat/web-search.service';

export interface AgentJobData {
  userId: string;
  taskId: string;
}

/** 单个方向的展示元信息（写入任务 directions 列） */
export interface AgentDirectionMeta {
  title: string;
  question: string;
  status: 'pending' | 'active' | 'done';
  rounds: number;
}

/** 断点进度（写入任务 progress 列，续跑依据） */
interface AgentProgress {
  directions: Array<{
    title: string;
    question: string;
    status: 'pending' | 'active' | 'done';
    rounds: number;
    searchTerms: string[];
    readUrls: Array<{ url: string; title: string }>;
    notes: string;
    sectionContent?: string; // 已缓存的小节正文（续跑不重复生成，省 token）
  }>;
}

/** 共享预算盒：所有方向的 LLM 调用都从这里扣 token */
class BudgetBox {
  used = 0;
  constructor(readonly limit: number) {}
  get exhausted(): boolean {
    return this.used >= this.limit;
  }
  spend(totalTokens: number) {
    this.used += totalTokens;
  }
}

/** 共享停止标记：预算用尽 / 时间到 / 手动停止，任一触发所有方向收尾 */
interface StopFlag {
  flag: boolean;
  reason: 'budget_exhausted' | 'time_exhausted' | 'user_stopped' | '';
}

/**
 * 预算互斥锁：LLM 调用是唯一消耗 token 的操作，串行扣费保证预算精确。
 * 各方向并发跑在"搜索/正文提取"（不耗 token）上，只在 LLM 调用处排队；
 * 预算用尽时最多一个在途调用（约 1~4k token 的软超支），而不是整批并发超支。
 */
class BudgetMutex {
  private chain: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.chain;
    this.chain = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 单个方向最多研究轮数（防止 LLM 判断失灵无限循环） */
const MAX_ROUNDS_PER_DIRECTION = 8;

/**
 * 限时·限量·自主研究 Agent 执行器（BullMQ worker 后台执行）：
 *
 * 流程：初始化方向（定向=拆解目标；开放=从知识库挖掘）→ 各方向并行自主推进
 * （生成搜索词 → 联网搜索 → 摘要预筛 → 精读正文 → 提炼笔记），共享 token 预算盒
 * 与停止标记 → 全部完成或停止时，把各方向笔记撰写成 Markdown 报告（含来源）。
 *
 * 停止三条件（用户锁定规则）：token 预算用尽永远停；否则用户设定的结束时间到了就停；
 * 用户手动停止随时生效。停止后保留阶段成果；续时/加预算后从 progress 断点续跑
 * （已精读的 URL 跳过、已完成方向不重复写、已缓存小节正文直接复用）。
 *
 * BYO 强依赖：所有 LLM 调用走用户默认模型配置，token 由用户承担，系统零成本。
 */
@Injectable()
export class AgentRunner {
  private readonly logger = new Logger(AgentRunner.name);
  /** 预算互斥锁：worker 并发为 1，每次 processTask 开始时重置，不会跨任务串锁 */
  private mutex = new BudgetMutex();

  constructor(
    private prisma: PrismaService,
    private modelConfigService: ModelConfigService,
    private webSearch: WebSearchService,
  ) {}

  /** 执行一次任务运行（首次启动或续跑都由同一入口进入） */
  async processTask(data: AgentJobData) {
    const { userId, taskId } = data;
    let task = await this.prisma.agentTask.findFirst({ where: { id: taskId, ownerId: userId } });
    // 任务被删除 / 已被手动停止且未续跑 → 直接跳过；failed 允许重跑（BullMQ 瞬时错误重试）
    if (!task || !['pending', 'running', 'failed'].includes(task.status)) return;

    // BYO：必须先绑定用户默认模型配置，否则不消耗系统任何 token
    const target = await this.modelConfigService.resolveDefaultForUser(userId);
    if (!target) {
      await this.prisma.agentTask.update({
        where: { id: taskId },
        data: {
          status: 'failed',
          stopReason: 'error',
          error: '请先在「模型配置」绑定你自己的大模型 API Key，再启动自主研究。',
          finishedAt: new Date(),
        },
      });
      return;
    }

    const budget = new BudgetBox(task.tokenBudget);
    budget.spend(task.tokensUsed); // 续跑：已消耗部分计入预算
    const stop: StopFlag = { flag: false, reason: '' };
    const counters = { searchRounds: task.searchRounds, pagesRead: task.pagesRead };
    this.mutex = new BudgetMutex();

    // 标记为运行中（可能覆盖上次 stopped → pending 的续跑状态）
    await this.prisma.agentTask.update({
      where: { id: taskId },
      data: { status: 'running', error: null },
    });

    try {
      // ① 等开始时间（startAt 设在未来时；等待期间可手动停止/删除）
      while (Date.now() < new Date(task.startAt).getTime()) {
        await sleep(15_000);
        const t = await this.prisma.agentTask.findFirst({ where: { id: taskId, ownerId: userId } });
        if (!t || t.status !== 'running') return; // 已被停止/删除
        task = t;
      }
      const endAtMs = new Date(task.endAt).getTime();
      if (Date.now() >= endAtMs) {
        // 排队太久导致时间窗已过：直接按"时间到"收尾（无成果）
        await this.finish(taskId, 'time_exhausted', 'stopped', null, null, null, null);
        return;
      }

      // ② 初始化方向（首次）或读取断点（续跑）
      let progress = (task.progress ?? null) as AgentProgress | null;
      if (!progress || !progress.directions?.length) {
        const dirs =
          task.mode === 'open'
            ? await this.mineDirections(target, taskId, userId, budget, stop)
            : await this.splitDirections(target, taskId, task.goal ?? '', budget, stop);
        if (!dirs.length) {
          // 预算太小连方向都没拆出来：如实告知
          await this.finish(
            taskId,
            'budget_exhausted',
            'stopped',
            '# 研究未启动\n\n预算过小，未能拆解出研究方向。可点击「继续研究」追加预算后重试。',
            [],
            null,
            null,
          );
          return;
        }
        progress = {
          directions: dirs.map((d) => ({
            ...d,
            status: 'pending' as const,
            rounds: 0,
            searchTerms: [],
            readUrls: [],
            notes: '',
          })),
        };
        await this.saveProgress(taskId, progress, counters, budget);
        this.logger.log(
          `自主研究启动: ${taskId}（${task.mode}），${progress.directions.length} 个方向`,
        );
      }

      // ③ 各方向并行推进（共享预算盒 + 停止标记，JS 单线程保证计数安全）
      await Promise.all(
        progress.directions.map((dir) =>
          this.researchDirection(target, taskId, dir, progress, counters, budget, stop, endAtMs),
        ),
      );

      // 方向循环可能因"时间到"静默退出（while 条件不满足），这里统一补上停止原因
      if (!stop.flag && Date.now() >= endAtMs) {
        stop.flag = true;
        stop.reason = 'time_exhausted';
      }

      // ④ 收尾：按停止原因落终态 + 组装（阶段或完整）报告
      const { report, sources } = await this.assemble(target, task, progress, budget, stop);
      await this.saveProgress(taskId, progress, counters, budget);
      if (stop.reason === 'budget_exhausted' || budget.exhausted) {
        await this.finish(taskId, 'budget_exhausted', 'stopped', report, sources, progress, null);
      } else if (stop.reason === 'time_exhausted') {
        await this.finish(taskId, 'time_exhausted', 'stopped', report, sources, progress, null);
      } else if (stop.reason === 'user_stopped') {
        // 用户已把 status 置为 stopped（stop 接口），这里只补写报告/来源/进度，不动状态
        // （updateMany：任务若已被删除则 0 行匹配，不报错）
        await this.prisma.agentTask.updateMany({
          where: { id: taskId },
          data: {
            report,
            sources: sources ? JSON.parse(JSON.stringify(sources)) : null,
            progress: JSON.parse(JSON.stringify(progress)),
          },
        });
      } else {
        // 没有停止标记 = 所有方向都研究完了
        await this.finish(taskId, 'completed', 'done', report, sources, progress, null);
      }
      this.logger.log(
        `自主研究结束: ${taskId} → ${stop.reason || 'completed'}（已用 ${budget.used}/${task.tokenBudget} token）`,
      );
    } catch (err) {
      this.logger.warn(`自主研究异常: ${taskId} → ${(err as Error).message}`);
      await this.prisma.agentTask.updateMany({
        where: { id: taskId, status: 'running' },
        data: {
          status: 'failed',
          stopReason: 'error',
          error: (err as Error).message,
          finishedAt: new Date(),
        },
      });
    }
  }

  // ==================== 单个方向的研究循环 ====================

  private async researchDirection(
    target: ChatTarget,
    taskId: string,
    dir: AgentProgress['directions'][number],
    progress: AgentProgress,
    counters: { searchRounds: number; pagesRead: number },
    budget: BudgetBox,
    stop: StopFlag,
    endAtMs: number,
  ) {
    if (dir.status === 'done' || dir.sectionContent) return; // 断点续跑：已完成方向跳过
    dir.status = 'active';

    while (!stop.flag && !budget.exhausted && Date.now() < endAtMs) {
      // 手动停止检测（每轮开始）：任务状态不再是 running → 全局收尾
      if (!(await this.isRunning(taskId))) {
        stop.flag = true;
        stop.reason = 'user_stopped';
        break;
      }

      // 1) 生成下一个搜索词；模型认为资料已足够 → 返回 null → 方向完成
      if (dir.rounds >= MAX_ROUNDS_PER_DIRECTION) {
        dir.status = 'done';
        break;
      }
      const query = await this.nextQuery(target, taskId, dir, budget, stop);
      if (stop.flag) break;
      if (!query) {
        dir.status = 'done';
        break;
      }

      // 2) 联网搜索 + 过滤已精读的 URL
      const results = await this.webSearch.search(query, 5);
      if (stop.flag) break;
      counters.searchRounds += 1;
      const readUrls = new Set(dir.readUrls.map((r) => r.url));
      const fresh = results.filter((r) => !readUrls.has(r.url));
      if (fresh.length === 0) {
        dir.rounds += 1;
        continue; // 没有新结果，换个搜索词
      }

      // 3) 摘要预筛：LLM 从候选中挑 2 个最值得精读的
      if (!(await this.isRunning(taskId))) {
        stop.flag = true;
        stop.reason = 'user_stopped';
        break;
      }
      const chosen = await this.triage(target, taskId, dir, fresh, budget, stop);
      if (stop.flag) break;

      // 4) 精读正文 + 提炼笔记（逐条，随时可被预算/时间/手动打断）
      for (const src of chosen) {
        if (stop.flag || budget.exhausted || Date.now() >= endAtMs) {
          stop.flag = true;
          if (!stop.reason && Date.now() >= endAtMs) stop.reason = 'time_exhausted';
          break;
        }
        if (!(await this.isRunning(taskId))) {
          stop.flag = true;
          stop.reason = 'user_stopped';
          break;
        }
        const content = (await this.webSearch.extract(src.url)) ?? src.content ?? '';
        if (!content) continue;
        dir.readUrls.push({ url: src.url, title: src.title });
        counters.pagesRead += 1;
        await this.extractNotes(target, taskId, dir, src, content, budget, stop);
        if (stop.flag) break;
        // 每轮精读后保存断点（续跑从这恢复）
        await this.saveProgress(taskId, progress, counters, budget);
      }
      dir.rounds += 1;
    }
    if (dir.status === 'active') dir.status = 'pending'; // 被打断的方向回到待研究，续跑时接着做
  }

  /** 任务是否仍在运行（被手动停止/删除 → false） */
  private async isRunning(taskId: string): Promise<boolean> {
    const t = await this.prisma.agentTask.findFirst({
      where: { id: taskId },
      select: { status: true },
    });
    return !!t && t.status === 'running';
  }

  // ==================== LLM 调用 ====================

  /**
   * 一次非流式补全（走用户自己的模型配置），自动扣预算。
   * 预算用尽 / 已触发停止 → 返回 null，调用方据此收尾。
   * LLM 调用串行执行（BudgetMutex）：多方向并发只发生在不耗 token 的搜索/提取上，
   * 保证预算用尽时最多只有一个在途调用（软超支 ≈ 单次调用），不会整批超支。
   */
  private async complete(
    target: ChatTarget,
    taskId: string,
    system: string,
    user: string,
    maxTokens: number,
    budget: BudgetBox,
    stop: StopFlag,
  ): Promise<{ text: string; totalTokens: number } | null> {
    return this.mutex.run(async () => {
      if (budget.exhausted || stop.flag) return null;
      const client = new OpenAI({ apiKey: target.apiKey, baseURL: target.baseURL });
      const res = await client.chat.completions.create({
        model: target.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.4,
      });
      const usage = res.usage;
      const total =
        usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
      budget.spend(total);
      // 预算用尽 → 立即触发全局停止（用户锁定规则：token 用完永远停）
      if (budget.exhausted) {
        stop.flag = true;
        stop.reason = 'budget_exhausted';
      }
      // 实时同步已用 token（进度条）
      await this.prisma.agentTask.update({
        where: { id: taskId },
        data: { tokensUsed: budget.used },
      });
      const choice = res.choices[0];
      if (choice?.finish_reason === 'length') {
        this.logger.warn(`自主研究 LLM 输出达到上限(${maxTokens})：${user.slice(0, 40)}…`);
      }
      return { text: choice?.message?.content?.trim() ?? '', totalTokens: total };
    });
  }

  /** 生成下一个搜索词；认为已研究充分时返回 null */
  private async nextQuery(
    target: ChatTarget,
    taskId: string,
    dir: AgentProgress['directions'][number],
    budget: BudgetBox,
    stop: StopFlag,
  ): Promise<string | null> {
    const used = dir.searchTerms.length
      ? `已用搜索词：${dir.searchTerms.join('；')}`
      : '尚未搜索过';
    const res = await this.complete(
      target,
      taskId,
      '你是自主研究规划助手。基于该研究方向已有的发现，提出下一个最值得搜索的中文搜索词（8~25 字，具体可检索）。' +
        '若你认为当前资料已足够回答该方向问题，直接输出 null。只输出一个搜索词或 null，不要任何其它内容。',
      `研究方向：${dir.title}\n要回答的问题：${dir.question}\n${used}\n当前研究笔记：\n${(dir.notes || '（暂无）').slice(0, 800)}`,
      80,
      budget,
      stop,
    );
    if (!res) return null;
    let q = res.text
      .replace(/^["'“”\s]+|["'“”\s]+$/g, '')
      .replace(/^搜索词[:：]\s*/i, '')
      .trim();
    if (!q || q.toLowerCase() === 'null') return null;
    if (dir.searchTerms.includes(q)) return null; // 防重复
    dir.searchTerms.push(q);
    return q;
  }

  /** 摘要预筛：从候选网页中挑 2 个最值得精读的 */
  private async triage(
    target: ChatTarget,
    taskId: string,
    dir: AgentProgress['directions'][number],
    candidates: WebSource[],
    budget: BudgetBox,
    stop: StopFlag,
  ): Promise<WebSource[]> {
    if (candidates.length <= 2) return candidates;
    const list = candidates
      .map((c, i) => `${i}. ${c.title}｜${(c.content || '').slice(0, 160)}`)
      .join('\n');
    const res = await this.complete(
      target,
      taskId,
      '你是资料筛选助手。根据研究方向，从候选网页中选出最有价值精读的 2 个（输出编号，英文逗号分隔，如 "1,3"）。' +
        '考虑与方向的相关性和信息密度，忽略广告、低质或重复页面。只输出编号，不要任何其它内容。',
      `研究方向：${dir.title}\n问题：${dir.question}\n候选网页：\n${list}`,
      40,
      budget,
      stop,
    );
    if (!res) return candidates.slice(0, 2);
    const idxs = (res.text.match(/\d+/g) ?? [])
      .map(Number)
      .filter((i) => i >= 0 && i < candidates.length);
    const uniq = [...new Set(idxs)].slice(0, 2);
    return uniq.length ? uniq.map((i) => candidates[i]) : candidates.slice(0, 2);
  }

  /** 精读后提炼要点，并入该方向的研究笔记 */
  private async extractNotes(
    target: ChatTarget,
    taskId: string,
    dir: AgentProgress['directions'][number],
    src: WebSource,
    content: string,
    budget: BudgetBox,
    stop: StopFlag,
  ) {
    const res = await this.complete(
      target,
      taskId,
      '你是研究助理。从网页内容中提炼与本方向问题相关的要点，整合进研究笔记。要求：' +
        '只保留与方向问题相关的信息；用你自己的话归纳成一段连贯的中文笔记（150~350 字），不要标题；' +
        '关键数据、事实、结论可原样保留并注明出处。',
      `研究方向：${dir.title}\n问题：${dir.question}\n网页标题：${src.title}\nURL：${src.url}\n\n网页内容：\n${content.slice(0, 4000)}`,
      600,
      budget,
      stop,
    );
    if (!res) return;
    const block = `【资料：${src.title}｜${src.url}】\n${res.text}`;
    dir.notes = dir.notes ? `${dir.notes}\n\n${block}` : block;
  }

  // ==================== 方向初始化 ====================

  /** 定向研究：把目标拆成 3~5 个方向 */
  private async splitDirections(
    target: ChatTarget,
    taskId: string,
    goal: string,
    budget: BudgetBox,
    stop: StopFlag,
  ): Promise<Array<{ title: string; question: string }>> {
    const res = await this.complete(
      target,
      taskId,
      '你是研究规划助手。把研究目标拆解为 3~5 个研究方向，覆盖该目标的主要方面。' +
        '只输出 JSON 数组，每项含 title（方向名，8~20 字）和 question（该方向要研究回答的具体问题，20~50 字）。' +
        '示例：[{"title":"技术原理","question":"RAG 检索增强生成的核心原理是什么"}]。不要任何其它内容。',
      `研究目标：${goal}`,
      500,
      budget,
      stop,
    );
    return this.parseDirections(res?.text ?? '');
  }

  /** 开放探索：没有目标，从用户知识库的主题中挖掘研究方向 */
  private async mineDirections(
    target: ChatTarget,
    taskId: string,
    userId: string,
    budget: BudgetBox,
    stop: StopFlag,
  ): Promise<Array<{ title: string; question: string }>> {
    const kbs = await this.prisma.knowledgeBase.findMany({
      where: { ownerId: userId },
      select: { name: true },
      take: 10,
    });
    const chunks = await this.prisma.chunk.findMany({
      where: { document: { knowledgeBase: { ownerId: userId } } },
      select: { content: true },
      orderBy: { createdAt: 'desc' },
      take: 24,
    });
    const seed = chunks.map((c) => c.content.replace(/\s+/g, ' ').slice(0, 150)).join('\n');
    const kbText = kbs.length
      ? `用户知识库：${kbs.map((k) => k.name).join('、')}`
      : '用户暂无知识库';
    const res = await this.complete(
      target,
      taskId,
      '你是自主研究规划助手。用户没有给出明确研究目标，请你从用户知识库的主题中挖掘 3~5 个值得深入研究的方向，用于自主联网研究。' +
        '只输出 JSON 数组，每项含 title（方向名）和 question（该方向要研究的具体问题）。不要任何其它内容。',
      `${kbText}\n\n知识库内容样本：\n${seed || '（无）'}\n\n若知识库为空，则基于 AI、效率方法、行业趋势等通用高价值主题提出方向。`,
      500,
      budget,
      stop,
    );
    return this.parseDirections(res?.text ?? '');
  }

  /** 解析方向 JSON（失败回退到按行拆分） */
  private parseDirections(raw: string): Array<{ title: string; question: string }> {
    try {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) {
        const dirs = arr
          .map((x) => ({
            title: String((x as { title?: unknown })?.title ?? '').trim(),
            question: String((x as { question?: unknown })?.question ?? '').trim(),
          }))
          .filter((d) => d.title && d.question);
        if (dirs.length) return dirs.slice(0, 5);
      }
    } catch {
      /* fallthrough */
    }
    return raw
      .split('\n')
      .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
      .filter((l) => l.length > 5)
      .slice(0, 5)
      .map((l) => ({ title: l.slice(0, 20), question: l }));
  }

  // ==================== 报告组装 ====================

  /**
   * 把各方向研究笔记写成 Markdown 报告。
   * - 正常运行（未停止）：为有笔记的方向做 LLM 润色小节（已缓存的小节正文直接复用，续跑不重复花 token），
   *   再生成引言/结论；
   * - 停止收尾（预算/时间/手动）：不再花任何 token，有笔记的方向直接拼原始研究笔记作为"阶段成果"，
   *   保证用户停止后立刻能看到已经研究到的内容（后续续跑完成时会被正式报告替换）。
   */
  private async assemble(
    target: ChatTarget,
    task: { id: string; goal: string | null },
    progress: AgentProgress,
    budget: BudgetBox,
    stop: StopFlag,
  ): Promise<{
    report: string | null;
    sources: Array<{ number: number; title: string; url: string }>;
  }> {
    const canCall = !stop.flag && !budget.exhausted;
    if (canCall) {
      // 逐方向生成小节正文（跳过已缓存 / 无笔记的方向）
      for (const dir of progress.directions) {
        if (dir.sectionContent || !dir.notes) continue;
        const content = await this.writeSection(target, task.id, dir, budget, stop);
        // 只有真正写出正文才标记完成：预算中途耗尽返回空时保持待研究，续跑会补写并润色
        if (content) {
          dir.sectionContent = content;
          dir.status = 'done';
        }
      }
    }

    // 按原始顺序组装正文：有正式小节的用正式小节，否则有笔记的用原始笔记（阶段成果）
    const bodyParts: string[] = [];
    for (const d of progress.directions) {
      if (d.sectionContent) bodyParts.push(`## ${d.title}\n\n${d.sectionContent}`);
      else if (d.notes) bodyParts.push(`## ${d.title}\n\n${d.notes}`);
    }
    if (!bodyParts.length) return { report: null, sources: [] };

    const topic = task.goal?.trim() || '自主探索研究报告';
    const reportParts: string[] = [`# ${topic}`];
    if (canCall) {
      const titles = progress.directions
        .filter((d) => d.sectionContent || d.notes)
        .map((d) => d.title)
        .join('；');
      const intro = await this.complete(
        target,
        task.id,
        '你是研究报告主编。根据研究主题与各小节标题，写一段 120~200 字的引言：说明研究主题、资料来源与研究结构。只输出引言段落本身，不要标题。',
        `研究主题：${topic}\n各小节标题：${titles}`,
        300,
        budget,
        stop,
      );
      const conclusion = await this.complete(
        target,
        task.id,
        '你是研究报告主编。根据研究主题与各小节标题，写一段 150~250 字的结论：总结核心要点与资料局限。只输出结论段落本身，不要标题。',
        `研究主题：${topic}\n各小节标题：${titles}`,
        400,
        budget,
        stop,
      );
      if (intro?.text) reportParts.push(`## 引言\n\n${intro.text}`);
      reportParts.push(bodyParts.join('\n\n'));
      if (conclusion?.text) reportParts.push(`## 结论\n\n${conclusion.text}`);
    } else {
      reportParts.push(bodyParts.join('\n\n'));
    }

    // 来源：全部已精读页面，按方向顺序全局编号
    const sources: Array<{ number: number; title: string; url: string }> = [];
    const seen = new Set<string>();
    for (const d of progress.directions) {
      for (const r of d.readUrls) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        sources.push({ number: sources.length + 1, title: r.title, url: r.url });
      }
    }
    return { report: reportParts.join('\n\n'), sources };
  }

  /** 单个方向小节：研究笔记 → Markdown 小节 */
  private async writeSection(
    target: ChatTarget,
    taskId: string,
    dir: AgentProgress['directions'][number],
    budget: BudgetBox,
    stop: StopFlag,
  ): Promise<string> {
    const res = await this.complete(
      target,
      taskId,
      '你是严谨的研究撰写助手。根据【研究笔记】撰写该方向的小节，输出 Markdown。要求：' +
        '结构清晰（可含小标题、列表）；引用网页时用 Markdown 链接 [来源](URL)（URL 从笔记的【资料：标题｜URL】中取）；' +
        '资料没有的信息不要编造，可基于自身知识补充并注明"（补充）"。',
      `【方向】${dir.title}\n【问题】${dir.question}\n【研究笔记】\n${(dir.notes || '').slice(0, 6000)}`,
      2000,
      budget,
      stop,
    );
    return res?.text ?? '';
  }

  // ==================== 持久化 ====================

  /** 保存断点（无条件更新：进度 + 计数器，不动状态） */
  private async saveProgress(
    taskId: string,
    progress: AgentProgress,
    counters: { searchRounds: number; pagesRead: number },
    budget: BudgetBox,
  ) {
    await this.prisma.agentTask.update({
      where: { id: taskId },
      data: {
        progress: JSON.parse(JSON.stringify(progress)),
        searchRounds: counters.searchRounds,
        pagesRead: counters.pagesRead,
        tokensUsed: budget.used,
      },
    });
  }

  /** 落终态（条件更新：仅在任务仍处于 running 时生效，避免覆盖用户手动停止/续跑状态） */
  private async finish(
    taskId: string,
    stopReason: 'budget_exhausted' | 'time_exhausted' | 'completed',
    status: 'stopped' | 'done',
    report: string | null,
    sources: Array<{ number: number; title: string; url: string }> | null,
    progress: AgentProgress | null,
    error: string | null,
  ) {
    await this.prisma.agentTask.updateMany({
      where: { id: taskId, status: 'running' },
      data: {
        status,
        stopReason,
        finishedAt: new Date(),
        report,
        sources: sources ? JSON.parse(JSON.stringify(sources)) : null,
        progress: progress ? JSON.parse(JSON.stringify(progress)) : null,
        error,
      },
    });
  }
}
