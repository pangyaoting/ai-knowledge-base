// 自主研究 Agent 相关类型（与后端 AgentTask 模型对应）

export type AgentMode = 'targeted' | 'open';
export type AgentTaskStatus =
  'pending' | 'awaiting_confirm' | 'running' | 'stopped' | 'done' | 'failed';
export type AgentStopReason =
  | 'budget_exhausted'
  | 'time_exhausted'
  | 'user_stopped'
  | 'cancelled'
  | 'completed'
  | 'error'
  | null;

/** 研究方向（进度展示用） */
export interface AgentDirection {
  title: string;
  question: string;
  status: 'pending' | 'active' | 'done';
  rounds: number;
}

/** 引用来源（网页） */
export interface AgentSource {
  number: number;
  title: string;
  url: string;
}

export interface AgentTask {
  id: string;
  mode: AgentMode;
  goal: string | null;
  startAt: string;
  endAt: string;
  tokenBudget: number;
  tokensUsed: number;
  searchRounds: number;
  pagesRead: number;
  status: AgentTaskStatus;
  stopReason: AgentStopReason;
  directions: AgentDirection[] | null;
  report: string | null;
  summary: string | null;
  sources: AgentSource[] | null;
  error: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
