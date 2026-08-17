import request from './request';
import type { KnowledgeBase, Document } from '@/types/knowledge';

// ==================== 知识库 ====================

export function getKnowledgeBases() {
  return request.get<unknown, KnowledgeBase[]>('/knowledge');
}

export function createKnowledgeBase(data: { name: string; description?: string }) {
  return request.post<unknown, KnowledgeBase>('/knowledge', data);
}

export function updateKnowledgeBase(id: string, data: { name?: string; description?: string }) {
  return request.patch<unknown, KnowledgeBase>(`/knowledge/${id}`, data);
}

export function deleteKnowledgeBase(id: string) {
  return request.delete<unknown, { success: boolean }>(`/knowledge/${id}`);
}

// ==================== 文档 ====================

export function getDocuments(knowledgeBaseId: string) {
  return request.get<unknown, Document[]>(`/knowledge/${knowledgeBaseId}/documents`);
}

/**
 * 上传文档（后端同步完成 解析→分块→向量化，可能耗时较长）
 * 单独放宽超时到 120 秒，避免大文档被默认 15s 超时打断
 */
export function uploadDocument(knowledgeBaseId: string, file: File) {
  const form = new FormData();
  form.append('file', file);
  return request.post<unknown, Document>(`/knowledge/${knowledgeBaseId}/documents`, form, {
    timeout: 120_000,
  });
}

export function deleteDocument(knowledgeBaseId: string, documentId: string) {
  return request.delete<unknown, { success: boolean }>(
    `/knowledge/${knowledgeBaseId}/documents/${documentId}`,
  );
}
