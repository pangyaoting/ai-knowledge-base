import request from './request';
import type { AgentTask } from '@/types/research-agent';

// ==================== 自主研究 Agent ====================

/** 我的自主研究任务列表 */
export function getAgentTasks() {
  return request.get<unknown, AgentTask[]>('/research-agent/tasks');
}

/** 单任务详情（轮询研究进度用） */
export function getAgentTask(id: string) {
  return request.get<unknown, AgentTask>(`/research-agent/tasks/${id}`);
}

/** 创建自主研究任务（异步执行，立即返回 pending） */
export function createAgentTask(data: {
  mode: 'targeted' | 'open';
  goal?: string;
  startAt?: string;
  endAt?: string;
  tokenBudget: number;
}) {
  // datetime-local 是本地时间无时区，转成 UTC ISO，避免服务器时区解析偏差
  const payload: Record<string, unknown> = { ...data };
  if (payload.startAt) payload.startAt = new Date(payload.startAt as string).toISOString();
  if (payload.endAt) payload.endAt = new Date(payload.endAt as string).toISOString();
  return request.post<unknown, AgentTask>('/research-agent/tasks', payload);
}

/** 手动停止（保留阶段成果，可续时/加预算后继续） */
export function stopAgentTask(id: string) {
  return request.post<unknown, AgentTask>(`/research-agent/tasks/${id}/stop`);
}

/** 续时/加预算（仅限已停止任务，从断点续跑） */
export function extendAgentTask(id: string, data: { extraTokens?: number; extraMinutes?: number }) {
  return request.patch<unknown, AgentTask>(`/research-agent/tasks/${id}/extend`, data);
}

export function deleteAgentTask(id: string) {
  return request.delete<unknown, { success: boolean }>(`/research-agent/tasks/${id}`);
}
