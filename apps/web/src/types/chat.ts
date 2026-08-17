// 对话相关类型（与后端 ChatSession / ChatMessage / RetrievalSource 对应）

export interface ChatSession {
  id: string;
  title: string;
  knowledgeBaseId: string | null;
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
  similarity: number;
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
