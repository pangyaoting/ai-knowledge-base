import request from './request';

export interface OverviewData {
  counts: {
    kbs: number;
    documents: number;
    chunks: number;
    messages: number;
    questionsToday: number;
  };
  tokens: {
    total: number;
    promptTotal: number;
    completionTotal: number;
  };
  daily: Array<{ day: string; questions: number; tokens: number }>;
  topKbs: Array<{ id: string; name: string; documents: number }>;
}

export function getOverview() {
  return request.get<unknown, OverviewData>('/stats/overview');
}
