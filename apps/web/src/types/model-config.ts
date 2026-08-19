// 用户模型配置（BYO 大模型 API）

export interface ModelConfig {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  isDefault: boolean;
  /** 掩码后的 API Key（如 sk-1234****abcd），后端永不返回明文 */
  apiKeyMasked: string;
  createdAt: string;
  updatedAt: string;
}
