import request from './request';
import type { Report } from '@/types/research';

// ==================== 研究报告 ====================

/** 我的研究报告列表 */
export function getReports() {
  return request.get<unknown, Report[]>('/research/reports');
}

/** 单份报告详情（轮询生成进度用） */
export function getReport(id: string) {
  return request.get<unknown, Report>(`/research/reports/${id}`);
}

/** 创建研究报告任务（异步生成，立即返回 pending） */
export function createReport(data: { topic: string; knowledgeBaseIds?: string[] }) {
  return request.post<unknown, Report>('/research/reports', data);
}

export function deleteReport(id: string) {
  return request.delete<unknown, { success: boolean }>(`/research/reports/${id}`);
}
