import request from './request';
import axios from 'axios';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import type { ChatSession, ChatMessage, ChatSources } from '@/types/chat';

// ==================== 会话管理 ====================

/** 会话列表；q 存在时按标题/消息内容全文检索 */
export function getChatSessions(q?: string) {
  return request.get<unknown, ChatSession[]>('/chat/sessions', { params: q ? { q } : undefined });
}

export function createChatSession(data: {
  title?: string;
  knowledgeBaseIds?: string[];
  useKnowledgeBase?: boolean;
  modelConfigId?: string;
}) {
  return request.post<unknown, ChatSession>('/chat/sessions', data);
}

export function getChatMessages(sessionId: string) {
  return request.get<unknown, ChatMessage[]>(`/chat/sessions/${sessionId}/messages`);
}

export function deleteChatSession(sessionId: string) {
  return request.delete<unknown, { success: boolean }>(`/chat/sessions/${sessionId}`);
}

/** 修改会话绑定的知识库（问答范围）：空数组 + useKnowledgeBase=true = 全部；false = 纯对话 */
export function updateSessionKnowledgeBases(
  sessionId: string,
  knowledgeBaseIds: string[],
  useKnowledgeBase: boolean,
) {
  return request.patch<unknown, ChatSession>(`/chat/sessions/${sessionId}/knowledge-bases`, {
    knowledgeBaseIds,
    useKnowledgeBase,
  });
}

/** 修改会话绑定的模型配置与推理等级（null = 跟随默认；reasoningEffort: low/high/max） */
export function updateSessionModel(
  sessionId: string,
  modelConfigId: string | null,
  reasoningEffort?: string | null,
) {
  return request.patch<unknown, ChatSession>(`/chat/sessions/${sessionId}/model`, {
    modelConfigId,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  });
}

/** 导出会话为 Markdown 文件（原始 axios 下载，绕开 JSON 拦截器） */
export async function exportSessionFile(sessionId: string): Promise<Blob> {
  const res = await axios.get(`/api/chat/sessions/${sessionId}/export`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('accessToken')}` },
    responseType: 'blob',
    timeout: 30_000,
  });
  return res.data;
}

// ==================== 提问（SSE 流式） ====================

export interface AskCallbacks {
  onSources?: (sources: ChatSources) => void;
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
  useWebSearch: boolean,
  signal: AbortSignal,
  callbacks: AskCallbacks,
  imageDataUrl?: string,
): Promise<void> {
  return fetchEventSource(`/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('accessToken')}`,
    },
    body: JSON.stringify({ content, useWebSearch, imageDataUrl }),
    signal,
    onmessage(ev) {
      // 事件类型在后端写进了 data 的 JSON 里：{ event, data }
      const msg = JSON.parse(ev.data) as { event: string; data: unknown };
      switch (msg.event) {
        case 'sources':
          callbacks.onSources?.(msg.data as ChatSources);
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
        const raw = err instanceof Error ? err.message : '连接中断';
        // fetch-event-source 在响应不是 SSE（如 400 JSON 校验错误）时抛 content-type 错，
        // 翻译成可操作的中文提示（真正的错误信息后端会通过 SSE error 事件送达）
        callbacks.onError?.(
          /Expected content-type/i.test(raw)
            ? '请求未正常建立（响应格式异常）：请确认问题内容或模型配置（只发图片时需配置视觉模型）'
            : raw,
        );
      }
      throw err; // 抛出以终止重连（SSE 默认会自动重连，这里不需要）
    },
  });
}
