// 知识库与文档的类型定义（与后端 Prisma 模型对应）

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  _count?: { documents: number };
}

export type DocumentStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface Document {
  id: string;
  knowledgeBaseId: string;
  filename: string;
  filepath: string;
  fileSize: number;
  fileType: string; // pdf / docx / md / txt
  status: DocumentStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { chunks: number };
}

/** 文件大小格式化为可读文本 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
