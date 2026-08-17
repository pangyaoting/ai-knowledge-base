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
  sources: RetrievalSource[] | null;
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

/** SSE 事件协议（后端按此格式推送） */
export interface SseEvent<T = unknown> {
  event: 'sources' | 'delta' | 'done' | 'error';
  data: T;
}
