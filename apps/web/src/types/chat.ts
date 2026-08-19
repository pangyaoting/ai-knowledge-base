// 对话相关类型（与后端 ChatSession / ChatMessage / RetrievalSource 对应）

export interface ChatSession {
  id: string;
  title: string;
  /** 是否使用知识库检索（false = 纯对话模式；true 且未绑定 = 检索全部知识库） */
  useKnowledgeBase: boolean;
  /** 会话绑定的用户模型配置（null = 跟随用户默认配置；BYO key） */
  modelConfigId: string | null;
  modelConfig: { id: string; name: string; model: string } | null;
  /** 会话绑定的知识库（空数组 = 检索全部知识库） */
  knowledgeBases: Array<{ knowledgeBase: { id: string; name: string } }>;
  createdAt: string;
  updatedAt: string;
  _count?: { messages: number };
  messages?: Array<{ content: string }>; // 列表接口带回最后一条预览
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  sources: ChatSources | null;
  createdAt: string;
}

export interface RetrievalSource {
  chunkId: string;
  content: string;
  chunkIndex: number;
  documentId: string;
  filename: string;
  /** 向量相似度；null = 来自知识图谱扩展的关联片段 */
  similarity: number | null;
}

/** 联网检索结果 */
export interface WebSource {
  title: string;
  url: string;
  content: string;
  score?: number;
}

/** 引用来源：知识库片段 + 网络资料 */
export interface ChatSources {
  kb: RetrievalSource[];
  web: WebSource[];
}

/** SSE 事件协议（后端按此格式推送） */
export interface SseEvent<T = unknown> {
  event: 'sources' | 'delta' | 'done' | 'error';
  data: T;
}
