// 研究报告相关类型（与后端 Report 模型对应）

export type ReportStatus = 'pending' | 'processing' | 'done' | 'failed';

/** 报告引用来源（全局编号，可点击定位原文） */
export interface ReportSource {
  number: number;
  documentId: string;
  chunkIndex: number;
  filename: string;
  similarity: number;
}

/** 报告的一个小节（子问题 + 撰写内容） */
export interface ReportSection {
  index: number;
  question: string;
  content: string;
}

export interface Report {
  id: string;
  topic: string;
  status: ReportStatus;
  /** 进度步骤：1=拆解 2=撰写章节 3=汇总 4=完成 */
  step: number;
  content: string | null;
  sections: ReportSection[] | null;
  sources: ReportSource[] | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
