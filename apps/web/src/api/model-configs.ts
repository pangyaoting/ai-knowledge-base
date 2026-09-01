import request from './request';
import type { ModelConfig } from '@/types/model-config';

// ==================== 模型配置（BYO 大模型 API） ====================

export function getModelConfigs() {
  return request.get<unknown, ModelConfig[]>('/model-configs');
}

export function createModelConfig(data: {
  name: string;
  baseURL?: string;
  apiKey: string;
  model: string;
  /** 该配置下的全部模型名（同一 Key 多模型） */
  models?: string[];
  isDefault?: boolean;
}) {
  return request.post<unknown, ModelConfig>('/model-configs', data);
}

export function updateModelConfig(
  id: string,
  data: {
    name?: string;
    baseURL?: string;
    apiKey?: string;
    model?: string;
    models?: string[];
    isDefault?: boolean;
  },
) {
  return request.patch<unknown, ModelConfig>(`/model-configs/${id}`, data);
}

export function deleteModelConfig(id: string) {
  return request.delete<unknown, { success: boolean }>(`/model-configs/${id}`);
}

/** 测试连接（后端发最小补全请求验证 key 可用） */
export function testModelConfig(id: string) {
  return request.post<unknown, { ok: boolean; message: string }>(`/model-configs/${id}/test`);
}

/** 探测提供商模型列表（模型名下拉选择用；创建传 baseURL+key / 编辑传 configId） */
export function listRemoteModels(data: { baseURL?: string; apiKey?: string; configId?: string }) {
  return request.post<unknown, { models: string[] }>('/model-configs/models', data);
}
