// 研究报告相关类型（与后端 Report 模型对应）

export type ReportStatus = 'pending' | 'processing' | 'done' | 'failed' | 'cancelled';

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

/** 报告创建时的检索范围（失败重试精确回填用） */
export interface ReportKbScope {
  scope: 'all' | 'specific';
  knowledgeBaseIds: string[];
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
  /** 创建时的检索范围（null = 旧报告无记录，重试按全库处理） */
  kbScope: ReportKbScope | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
