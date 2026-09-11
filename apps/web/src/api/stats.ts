import request from './request';

/** 时间范围：近 7 天 / 近 30 天 / 全部（按月分桶） */
export type StatsRange = '7' | '30' | 'all';

export interface OverviewData {
  range: StatsRange;
  /** 服务端生成时刻（ISO）：页脚"数据更新于" */
  generatedAt: string;
  kpi: {
    tokens: number;
    tokensDelta: number | null;
    questions: number;
    questionsDelta: number | null;
    todayQuestions: number;
    todayDelta: number | null;
    docFailed: number;
  };
  assets: {
    kbs: number;
    documents: number;
    chunks: number;
    avgChunksPerDoc: number;
    sessions: number;
    memories: number;
    sessionsWithSummary: number;
  };
  docHealth: { done: number; processing: number; failed: number };
  tokens: { chat: number; report: number; agent: number };
  /** 本期分桶：日粒度 key=YYYY-MM-DD；全部范围 key=YYYY-MM */
  daily: Array<{
    key: string;
    questions: number;
    tokens: number;
    reportTokens: number;
    agentTokens: number;
  }>;
  /** 上一等长周期的每日提问数（画虚线对比；全部范围为空） */
  prevDailyQuestions: number[];
  /** 24 小时提问分布（Asia/Shanghai） */
  hourly: number[];
  /** 各模型 token 消耗（仅统计记录了模型名的回答；历史不计入） */
  models: Array<{ model: string; tokens: number; calls: number; delta: number | null }>;
  topSessions: Array<{
    id: string;
    title: string;
    model: string | null;
    tokens: number;
    messages: number;
  }>;
  topCited: Array<{ filename: string; kb: string | null; hits: number }>;
  topKbs: Array<{
    id: string;
    name: string;
    documents: number;
    chunks: number;
    cited: number;
    updatedAt: string;
  }>;
  research: {
    status: { done: number; running: number; stopped: number; failed: number };
    avgSearchRounds: number;
    avgPagesRead: number;
    avgReportTokens: number;
  };
  memory: { total: number; byCategory: Array<{ category: string; count: number }> };
}

export function getOverview(range: StatsRange = '7') {
  return request.get<unknown, OverviewData>('/stats/overview', { params: { range } });
}
