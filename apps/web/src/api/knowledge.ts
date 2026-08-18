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

/** 一键导入示例知识库（幂等：已存在则返回现有） */
export function seedDemoData() {
  return request.post<unknown, { knowledgeBaseId: string; created: boolean; documents: number }>(
    '/demo/seed',
  );
}

// ==================== 文档 ====================

export function getDocuments(knowledgeBaseId: string) {
  return request.get<unknown, Document[]>(`/knowledge/${knowledgeBaseId}/documents`);
}

/**
 * 上传文档（后端同步完成 解析→分块→向量化，可能耗时较长）
 * 单独放宽超时到 120 秒，避免大文档被默认 15s 超时打断
 * @param onProgress 上传进度回调（0-100，只反映 HTTP 传输阶段）
 * @param filename 可选：自定义文档名（目录上传时传相对路径如 docs/子/a.txt）
 * 注意：浏览器会把 multipart 文件名里的路径分隔符剥掉，所以相对路径走独立字段 name
 */
export function uploadDocument(
  knowledgeBaseId: string,
  file: File,
  onProgress?: (percent: number) => void,
  filename?: string,
) {
  const form = new FormData();
  form.append('file', file);
  if (filename && filename !== file.name) {
    form.append('name', filename);
  }
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

/** 获取文档可编辑文本内容（重新解析原文件） */
export function getDocumentContent(knowledgeBaseId: string, documentId: string) {
  return request.get<unknown, { id: string; filename: string; fileType: string; content: string }>(
    `/knowledge/${knowledgeBaseId}/documents/${documentId}/content`,
  );
}

/** 编辑文档：改名 / 改内容（传 content 会重新分块向量化） */
export function updateDocument(
  knowledgeBaseId: string,
  documentId: string,
  data: { filename?: string; content?: string },
) {
  return request.patch<unknown, Document>(
    `/knowledge/${knowledgeBaseId}/documents/${documentId}`,
    data,
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
