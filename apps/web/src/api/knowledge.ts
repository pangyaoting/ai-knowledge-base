import request from './request';
import axios from 'axios';
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
 * @param onProgress 上传进度回调（0-100，只反映 HTTP 传输阶段）
 */
export function uploadDocument(
  knowledgeBaseId: string,
  file: File,
  onProgress?: (percent: number) => void,
) {
  const form = new FormData();
  form.append('file', file);
  return request.post<unknown, Document>(`/knowledge/${knowledgeBaseId}/documents`, form, {
    timeout: 120_000,
    onUploadProgress: onProgress
      ? (e) => {
          if (e.total) onProgress(Math.round((e.loaded / e.total) * 100));
        }
      : undefined,
  });
}

export function deleteDocument(knowledgeBaseId: string, documentId: string) {
  return request.delete<unknown, { success: boolean }>(
    `/knowledge/${knowledgeBaseId}/documents/${documentId}`,
  );
}

/**
 * 下载文档原文件
 * 注意：返回的是文件二进制（Blob），不能用统一响应拦截器（它只解包 JSON），
 * 所以这里用原生 axios + 手动带 token
 */
export async function downloadDocumentFile(
  knowledgeBaseId: string,
  documentId: string,
): Promise<Blob> {
  const res = await axios.get(`/api/knowledge/${knowledgeBaseId}/documents/${documentId}/file`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('accessToken')}` },
    responseType: 'blob',
    timeout: 60_000,
  });
  return res.data;
}
