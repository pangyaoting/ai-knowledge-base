// 用户模型配置（BYO 大模型 API）

export interface ModelConfig {
  id: string;
  name: string;
  baseURL: string;
  /** 主模型名（该配置默认选中的模型） */
  model: string;
  /** 该配置下的全部模型名（同一 Key 多模型；空 = 只用 model） */
  models: string[];
  /** 掩码后的 API Key（如 sk-1234****abcd），后端永不返回明文 */
  apiKeyMasked: string;
  createdAt: string;
  updatedAt: string;
}

/** 配置下可用的模型名列表（兼容旧数据：未存 models 时只有默认 model） */
export function configModels(c: ModelConfig): string[] {
  return c.models?.length ? c.models : [c.model];
}
