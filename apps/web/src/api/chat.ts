import request from './request';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import type { ChatSession, ChatMessage, RetrievalSource } from '@/types/chat';

// ==================== 会话管理 ====================

export function getChatSessions() {
  return request.get<unknown, ChatSession[]>('/chat/sessions');
}

export function createChatSession(data: { title?: string; knowledgeBaseId?: string }) {
  return request.post<unknown, ChatSession>('/chat/sessions', data);
}

export function getChatMessages(sessionId: string) {
  return request.get<unknown, ChatMessage[]>(`/chat/sessions/${sessionId}/messages`);
}

export function deleteChatSession(sessionId: string) {
  return request.delete<unknown, { success: boolean }>(`/chat/sessions/${sessionId}`);
}

// ==================== 提问（SSE 流式） ====================

export interface AskCallbacks {
  onSources?: (sources: RetrievalSource[]) => void;
  onDelta?: (content: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

/**
 * 提问并流式接收回答
 * 用 fetch-event-source（支持 POST + Authorization 头 + AbortController 中止），
 * 原生 EventSource 只支持 GET，无法带 Token，所以不能用
 */
export function askQuestion(
  sessionId: string,
  content: string,
  signal: AbortSignal,
  callbacks: AskCallbacks,
): Promise<void> {
  return fetchEventSource(`/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('accessToken')}`,
    },
    body: JSON.stringify({ content }),
    signal,
    onmessage(ev) {
      // 事件类型在后端写进了 data 的 JSON 里：{ event, data }
      const msg = JSON.parse(ev.data) as { event: string; data: unknown };
      switch (msg.event) {
        case 'sources':
          callbacks.onSources?.(msg.data as RetrievalSource[]);
          break;
        case 'delta':
          callbacks.onDelta?.((msg.data as { content: string }).content);
          break;
        case 'done':
          callbacks.onDone?.();
          break;
        case 'error':
          callbacks.onError?.((msg.data as { message: string }).message);
          break;
      }
    },
    onerror(err) {
      // 用户主动中止不算错误
      if (!signal.aborted) {
        callbacks.onError?.(err instanceof Error ? err.message : '连接中断');
      }
      throw err; // 抛出以终止重连（SSE 默认会自动重连，这里不需要）
    },
  });
}
