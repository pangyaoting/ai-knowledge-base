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
 * 单个方向最少精读页数：模型喊"资料足够"结束方向前，必须至少精读这么多页，
 * 防止方向草草了事（只搜一轮、笔记为空就"完成"）。
 */
const MIN_READS_PER_DIRECTION = 3;
/**
 * 独立"报告组装预算"（token）：与用户设定的研究预算分开，专门用于把研究笔记
 * 润色成正式报告（引言/结论/小节撰写）。任何停止（预算/时间/手动）都会先花这笔钱
 * 把正式报告交付——用户不需要追加 token 才能拿到报告；研究预算的停止规则不变。
 */
const ASSEMBLY_BUDGET = 12000;

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
  /** 记账（研究+组装合计 token，进度条/续跑基数）：worker 并发 1，实例字段安全 */
  private tokenCounter = { total: 0 };

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
    budget.spend(task.tokensUsed); // 续跑：已消耗部分计入研究预算
    // 组装预算独立于研究预算：研究怎么停都行，报告整理的钱是预留好的
    const assembly = new BudgetBox(ASSEMBLY_BUDGET);
    // 记账：研究 + 组装的全部 token（进度条/续跑基数用）
    this.tokenCounter = { total: task.tokensUsed };
    const stop: StopFlag = { flag: false, reason: '' };
    const counters = { searchRounds: task.searchRounds, pagesRead: task.pagesRead };
    // 本次运行内的精读正文缓存：同一 URL 只提取一次（Tavily Extract 免费额度有限，命中缓存不再重复调用）
    const readCache = new Map<string, string>();
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
        await this.finish(taskId, 'time_exhausted', 'stopped', null, null, null, null, null);
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
          // 走到这里只剩真实停止条件（预算耗尽 / 时间到 / 手动停止），按原因如实告知
          const reason: 'budget_exhausted' | 'time_exhausted' =
            stop.reason === 'time_exhausted' ? 'time_exhausted' : 'budget_exhausted';
          const msg =
            reason === 'time_exhausted'
              ? '时间窗已过，未能启动研究'
              : '预算不足，未能拆解出研究方向';
          await this.finish(
            taskId,
            reason,
            'stopped',
            `# 研究未启动\n\n${msg}。可点击「继续研究」追加预算或时长后重试。`,
            [],
            null,
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
        await this.saveProgress(taskId, progress, counters);
        // 方向拆解完成 → 先展示给用户确认，不直接开跑；
        // 用户确认后由 confirm 接口重新入队（断点续跑），重新拆解/取消另有接口
        await this.prisma.agentTask.update({
          where: { id: taskId },
          data: { status: 'awaiting_confirm' },
        });
        this.logger.log(
          `自主研究启动: ${taskId}（${task.mode}），拆解出 ${progress.directions.length} 个方向，等待用户确认`,
        );
        return;
      }

      // ③ 各方向并行推进（共享预算盒 + 停止标记，JS 单线程保证计数安全）
      await Promise.all(
        progress.directions.map((dir) =>
          this.researchDirection(
            target,
            taskId,
            dir,
            progress,
            counters,
            budget,
            stop,
            endAtMs,
            readCache,
          ),
        ),
      );

      // 方向循环可能因"时间到"静默退出（while 条件不满足），这里统一补上停止原因
      if (!stop.flag && Date.now() >= endAtMs) {
        stop.flag = true;
        stop.reason = 'time_exhausted';
      }

      // ④ 收尾：按停止原因落终态 + 组装（用独立组装预算，任何停止都交付正式报告）
      const { report, sources, summary } = await this.assemble(target, task, progress, assembly);
      await this.saveProgress(taskId, progress, counters);
      if (stop.reason === 'budget_exhausted' || budget.exhausted) {
        await this.finish(
          taskId,
          'budget_exhausted',
          'stopped',
          report,
          sources,
          progress,
          summary,
          null,
        );
      } else if (stop.reason === 'time_exhausted') {
        await this.finish(
          taskId,
          'time_exhausted',
          'stopped',
          report,
          sources,
          progress,
          summary,
          null,
        );
      } else if (stop.reason === 'user_stopped') {
        // 用户已把 status 置为 stopped（stop 接口），这里只补写报告/来源/进度，不动状态
        // （updateMany：任务若已被删除则 0 行匹配，不报错）
        await this.prisma.agentTask.updateMany({
          where: { id: taskId },
          data: {
            report,
            summary,
            sources: sources ? JSON.parse(JSON.stringify(sources)) : null,
            progress: JSON.parse(JSON.stringify(progress)),
          },
        });
      } else {
        // 没有停止标记 = 所有方向都研究完了
        await this.finish(taskId, 'completed', 'done', report, sources, progress, summary, null);
      }
      this.logger.log(
        `自主研究结束: ${taskId} → ${stop.reason || 'completed'}（研究 ${budget.used}/${task.tokenBudget}，含整理 ${this.tokenCounter.total} token）`,
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
    readCache: Map<string, string>,
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
        // 模型喊"够了"：但精读页数不足时不允许草草收场（防止方向内容为空/浅尝辄止），
        // 强制再来一轮（最多到 MAX_ROUNDS-1 兜底，防止模型持续喊停导致死循环）
        if (
          dir.readUrls.length >= MIN_READS_PER_DIRECTION ||
          dir.rounds >= MAX_ROUNDS_PER_DIRECTION - 1
        ) {
          dir.status = 'done';
          break;
        }
        dir.rounds += 1;
        continue;
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

      // 4) 精读正文 + 提炼笔记。
      //    正文提取不耗 token，并行执行并复用本次运行缓存（同一 URL 只提取一次）；
      //    笔记提炼走预算互斥锁串行扣费，随时可被预算/时间/手动打断。
      const withContent = await Promise.all(
        chosen.map(async (src): Promise<{ src: WebSource; content: string } | null> => {
          if (stop.flag || budget.exhausted || Date.now() >= endAtMs) return null;
          let content = readCache.get(src.url);
          if (content === undefined) {
            content = (await this.webSearch.extract(src.url)) ?? src.content ?? '';
            if (content) readCache.set(src.url, content);
          }
          return content ? { src, content } : null;
        }),
      );
      for (const item of withContent) {
        if (!item || stop.flag || budget.exhausted || Date.now() >= endAtMs) {
          if (!stop.flag && Date.now() >= endAtMs) {
            stop.flag = true;
            stop.reason = 'time_exhausted';
          }
          break;
        }
        if (!(await this.isRunning(taskId))) {
          stop.flag = true;
          stop.reason = 'user_stopped';
          break;
        }
        const { src, content } = item;
        counters.pagesRead += 1;
        // 先提炼笔记、成功后才记为"已精读"：中途被打断的页面（预算/时间/手动）续跑时会
        // 重新精读补齐笔记，而不是丢内容
        const wrote = await this.extractNotes(target, taskId, dir, src, content, budget, stop);
        if (wrote) dir.readUrls.push({ url: src.url, title: src.title });
        if (stop.flag) break;
        // 每轮精读后保存断点（续跑从这恢复）
        await this.saveProgress(taskId, progress, counters);
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
   * 研究用 LLM 调用：扣"研究预算"，预算用尽立即触发全局停止。
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
    return this.llmCall(target, taskId, system, user, maxTokens, budget, stop, false);
  }

  /**
   * 报告组装用 LLM 调用：扣独立的"组装预算"，不受研究停止标记影响——
   * 研究停了，把手头的笔记整理成正式报告这个收尾动作仍会执行完。
   */
  private async assembleCall(
    target: ChatTarget,
    taskId: string,
    system: string,
    user: string,
    maxTokens: number,
    assembly: BudgetBox,
  ): Promise<{ text: string; totalTokens: number } | null> {
    return this.llmCall(target, taskId, system, user, maxTokens, assembly, null, true);
  }

  /** 一次非流式补全（走用户自己的模型配置），自动扣预算并记账 */
  private async llmCall(
    target: ChatTarget,
    taskId: string,
    system: string,
    user: string,
    maxTokens: number,
    box: BudgetBox,
    stop: StopFlag | null,
    ignoreStop: boolean,
  ): Promise<{ text: string; totalTokens: number } | null> {
    return this.mutex.run(async () => {
      // 组装调用（ignoreStop=true）只看组装预算；研究调用还看停止标记
      if (box.exhausted || (!ignoreStop && stop?.flag)) return null;
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
      box.spend(total);
      this.tokenCounter.total += total;
      // 研究预算用尽 → 立即触发全局停止（用户锁定规则：token 用完永远停）
      if (box.exhausted && !ignoreStop && stop) {
        stop.flag = true;
        stop.reason = 'budget_exhausted';
      }
      // 实时同步已用 token（进度条 = 研究 + 组装合计）
      await this.prisma.agentTask.update({
        where: { id: taskId },
        data: { tokensUsed: this.tokenCounter.total },
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
        `只有当已精读至少 ${MIN_READS_PER_DIRECTION} 个网页且资料足以完整回答该方向问题时，才输出 null；` +
        '否则必须给出下一个搜索词，不要过早结束。只输出一个搜索词或 null，不要任何其它内容。',
      `研究方向：${dir.title}\n要回答的问题：${dir.question}\n已精读网页：${dir.readUrls.length} 页\n${used}\n当前研究笔记：\n${(dir.notes || '（暂无）').slice(0, 800)}`,
      80,
      budget,
      stop,
    );
    if (!res) return null;
    const q = res.text
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

  /** 精读后提炼要点，并入该方向的研究笔记。返回是否真正写入（预算/停止打断时返回 false） */
  private async extractNotes(
    target: ChatTarget,
    taskId: string,
    dir: AgentProgress['directions'][number],
    src: WebSource,
    content: string,
    budget: BudgetBox,
    stop: StopFlag,
  ): Promise<boolean> {
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
    if (!res) return false;
    const block = `【资料：${src.title}｜${src.url}】\n${res.text}`;
    dir.notes = dir.notes ? `${dir.notes}\n\n${block}` : block;
    return true;
  }

  // ==================== 方向初始化 ====================

  /** 定向研究：把目标拆成 8~10 个方向（前端让用户从中选 5 个再研究） */
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
      '你是研究规划助手。把研究目标拆解为 8~10 个研究方向，全面覆盖该目标的主要方面。' +
        '只输出 JSON 数组，每项含 title（方向名，8~20 字）和 question（该方向要研究回答的具体问题，20~50 字）。' +
        '示例：[{"title":"技术原理","question":"RAG 检索增强生成的核心原理是什么"}]。不要任何其它内容。',
      `研究目标：${goal}`,
      1500, // 10 个方向的 JSON 输出较长，留足空间避免截断导致解析失败
      budget,
      stop,
    );
    const dirs = this.parseDirections(res?.text ?? '');
    if (dirs.length) return dirs;
    // 解析失败兜底（仅当预算未耗尽）：把目标本身作为唯一方向继续研究，
    // 而不是误报"预算不足"——否则用户追加预算重跑也永远卡在同一处
    if (!budget.exhausted && !stop.flag) {
      this.logger.warn(`方向拆解解析失败，回退为单一方向: ${taskId}`);
      return [{ title: goal.slice(0, 20) || '自主研究', question: goal }];
    }
    return [];
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
      '你是自主研究规划助手。用户没有给出明确研究目标，请你从用户知识库的主题中挖掘 8~10 个值得深入研究的方向，用于自主联网研究。' +
        '只输出 JSON 数组，每项含 title（方向名）和 question（该方向要研究的具体问题）。不要任何其它内容。',
      `${kbText}\n\n知识库内容样本：\n${seed || '（无）'}\n\n若知识库为空，则基于 AI、效率方法、行业趋势等通用高价值主题提出方向。`,
      1500,
      budget,
      stop,
    );
    const dirs = this.parseDirections(res?.text ?? '');
    if (dirs.length) return dirs;
    // 解析失败兜底：知识库主题作为方向（预算未耗尽时），避免误报预算不足
    if (!budget.exhausted && !stop.flag) {
      this.logger.warn(`开放探索方向解析失败，回退为知识库主题: ${taskId}`);
      return [
        {
          title: kbs[0]?.name?.slice(0, 20) || '自主探索',
          question: kbs[0]?.name || '基于当前热点与通用高价值主题的自主研究',
        },
      ];
    }
    return [];
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
        if (dirs.length) return dirs.slice(0, 10);
      }
    } catch {
      /* fallthrough */
    }
    return raw
      .split('\n')
      .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
      .filter((l) => l.length > 5)
      .slice(0, 10)
      .map((l) => ({ title: l.slice(0, 20), question: l }));
  }

  // ==================== 报告组装 ====================

  /**
   * 把各方向研究笔记写成 Markdown 报告（用独立的组装预算，任何停止都交付正式报告）：
   * ① 执行摘要（最高优先级，先摘要后展开）→ ② 引言（短调用）→ ③ 按笔记量从多到少
   * 逐方向润色小节（组装预算耗尽即停，已缓存的小节正文直接复用，续跑不重复花 token）
   * → ④ 结论（短调用）。
   * 组装预算不够润色的方向，正文直接拼原始研究笔记——报告结构始终完整
   * （有主题/摘要/引言/结论），用户不需要追加 token 就能拿到正式报告。
   */
  private async assemble(
    target: ChatTarget,
    task: { id: string; goal: string | null },
    progress: AgentProgress,
    assembly: BudgetBox,
  ): Promise<{
    report: string | null;
    sources: Array<{ number: number; title: string; url: string }>;
    summary: string | null;
  }> {
    // 没有任何研究内容 → 不组装
    const hasContent = progress.directions.some((d) => d.sectionContent || d.notes);
    if (!hasContent) return { report: null, sources: [], summary: null };

    const topic = task.goal?.trim() || '自主探索研究报告';
    const titles = progress.directions
      .filter((d) => d.sectionContent || d.notes)
      .map((d) => d.title)
      .join('；');

    // ① 执行摘要（先摘要后展开：无论停止与否都先生成，预算耗尽时摘要优先于小节润色）
    const previews = progress.directions
      .filter((d) => d.sectionContent || d.notes)
      .map((d) => {
        const raw = d.sectionContent ?? d.notes ?? '';
        return `- ${d.title}：${raw.replace(/\s+/g, ' ').slice(0, 160)}`;
      })
      .join('\n');
    const summaryRes = await this.assembleCall(
      target,
      task.id,
      '你是研究报告主编。为研究报告写一段 150~220 字的执行摘要（中文）：用最简洁的语言概括研究主题、各方向的关键发现与总体结论，' +
        '让读者不读全文也能掌握要点。只输出摘要段落本身，不要标题。',
      `研究主题：${topic}\n各方向要点：\n${previews || '（暂无）'}`,
      320,
      assembly,
    );
    const summary = summaryRes?.text ?? '';

    // ② 结论（用户明确要求必须有结论：优先级高于引言和小节，预算不足时先保结论）
    let conclusion = '';
    if (!assembly.exhausted) {
      const res = await this.assembleCall(
        target,
        task.id,
        '你是研究报告主编。根据研究主题与各小节标题，写一段 150~250 字的结论：总结核心要点与资料局限。只输出结论段落本身，不要标题。',
        `研究主题：${topic}\n各小节标题：${titles}`,
        400,
        assembly,
      );
      conclusion = res?.text ?? '';
    }

    // ③ 引言
    const intro = await this.assembleCall(
      target,
      task.id,
      '你是研究报告主编。根据研究主题与各小节标题，写一段 120~200 字的引言：说明研究主题、资料来源与研究结构。只输出引言段落本身，不要标题。',
      `研究主题：${topic}\n各小节标题：${titles}`,
      300,
      assembly,
    );

    // ④ 逐方向润色小节：笔记多的方向优先（信息量大、最值得精读成文）
    const pending = progress.directions
      .filter((d) => !d.sectionContent && d.notes)
      .sort((a, b) => b.notes.length - a.notes.length);
    for (const dir of pending) {
      if (assembly.exhausted) break;
      const content = await this.writeSection(target, task.id, dir, assembly);
      // 只有真正写出正文才标记完成：组装预算耗尽返回空时保持待研究，续跑会补写润色
      if (content) {
        dir.sectionContent = content;
        dir.status = 'done';
      }
    }

    // 组装正文：有正式小节的用正式小节，否则用原始笔记；确实没研究到的方向给一句说明，不悄悄消失。
    // 方向内容里 LLM 写的小标题统一降级为 ###（`## ` 只留给方向级，前端按它拆卡片），
    // 内容首行若与方向名相同（LLM 习惯重复写标题）则剥掉，避免空卡片/重复卡片。
    const bodyParts: string[] = [];
    for (const d of progress.directions) {
      if (d.sectionContent)
        bodyParts.push(`## ${d.title}\n\n${this.normalizeSection(d.title, d.sectionContent)}`);
      else if (d.notes)
        bodyParts.push(`## ${d.title}\n\n${this.normalizeSection(d.title, d.notes)}`);
      else if (d.status === 'done' || d.readUrls.length)
        bodyParts.push(`## ${d.title}\n\n> 该方向未能检索到有效资料，已跳过。`);
    }

    const reportParts: string[] = [`# ${topic}`];
    if (intro?.text) reportParts.push(`## 引言\n\n${this.flattenHeadings(intro.text)}`);
    reportParts.push(bodyParts.join('\n\n'));
    if (conclusion) reportParts.push(`## 结论\n\n${this.flattenHeadings(conclusion)}`);
    // 组装预算连引言都不够（极小预算 + 组装预算也耗尽）时，保证至少有正文
    if (reportParts.length === 1) reportParts.push(bodyParts.join('\n\n'));

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
    return { report: reportParts.join('\n\n'), sources, summary: summary || null };
  }

  /**
   * 把文本中行首的 Markdown 标题统一降级为 ###（三级）：
   * 报告里 `## ` 只用于方向级/引言/结论（前端按它拆卡片），
   * 方向内容里的内部小标题必须是 ###，否则会被前端误拆成多个方向卡片。
   */
  private flattenHeadings(text: string): string {
    return text.replace(/^#{1,6}\s+/gm, '### ');
  }

  /**
   * 规范化方向小节正文：剥掉与方向名重复的首行标题（LLM 习惯先写一遍标题），
   * 并把正文里的 Markdown 标题统一降级为 ###。
   */
  private normalizeSection(title: string, raw: string): string {
    let text = raw.trim();
    const firstLine = text
      .split('\n')[0]
      .replace(/^#{1,6}\s*/, '')
      .trim();
    if (firstLine && firstLine === title.trim()) {
      text = text.split('\n').slice(1).join('\n').trim();
    }
    return this.flattenHeadings(text);
  }

  /** 单个方向小节：研究笔记 → Markdown 小节（走组装预算） */
  private async writeSection(
    target: ChatTarget,
    taskId: string,
    dir: AgentProgress['directions'][number],
    assembly: BudgetBox,
  ): Promise<string> {
    const res = await this.assembleCall(
      target,
      taskId,
      '你是严谨的研究撰写助手。根据【研究笔记】撰写该方向的小节，输出 Markdown。要求：' +
        '先直接写内容，不要重复方向标题；结构清晰（可含小标题，但小标题一律用 ### 三级标题，不要用 # 或 ##）；' +
        '引用网页时用 Markdown 链接 [来源](URL)（URL 从笔记的【资料：标题｜URL】中取）；' +
        '资料没有的信息不要编造，可基于自身知识补充并注明"（补充）"。',
      `【方向】${dir.title}\n【问题】${dir.question}\n【研究笔记】\n${(dir.notes || '').slice(0, 6000)}`,
      2000,
      assembly,
    );
    return res?.text ?? '';
  }

  // ==================== 持久化 ====================

  /** 保存断点（无条件更新：进度 + 计数器，不动状态） */
  private async saveProgress(
    taskId: string,
    progress: AgentProgress,
    counters: { searchRounds: number; pagesRead: number },
  ) {
    await this.prisma.agentTask.update({
      where: { id: taskId },
      data: {
        progress: JSON.parse(JSON.stringify(progress)),
        searchRounds: counters.searchRounds,
        pagesRead: counters.pagesRead,
        tokensUsed: this.tokenCounter.total,
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
    summary: string | null,
    error: string | null,
  ) {
    await this.prisma.agentTask.updateMany({
      where: { id: taskId, status: 'running' },
      data: {
        status,
        stopReason,
        finishedAt: new Date(),
        report,
        summary,
        sources: sources ? JSON.parse(JSON.stringify(sources)) : null,
        progress: progress ? JSON.parse(JSON.stringify(progress)) : null,
        error,
      },
    });
  }
}
