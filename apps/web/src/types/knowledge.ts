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

// ==================== 文档预览（文本块） ====================

/** 文档的一个文本块（检索与引用的最小单元） */
export interface DocumentChunk {
  id: string;
  chunkIndex: number; // 第几块（0 起）
  content: string;
}

/** 文档预览接口返回：文件名 + 全部文本块（按 chunkIndex 升序） */
export interface DocumentChunksResult {
  filename: string;
  fileType: string;
  chunks: DocumentChunk[];
}

// ==================== 知识图谱（知识网络） ====================

/** 图谱节点（按名称聚合） */
export interface GraphNode {
  name: string;
  type: string;
  count: number; // 出现文档数
}

/** 图谱边 */
export interface GraphEdge {
  source: string;
  relation: string;
  target: string;
  count: number;
}

/** 图谱数据（节点 + 边） */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** 实体原文片段 */
export interface EntityChunk {
  chunkId: string;
  chunkIndex: number;
  content: string;
  documentId: string;
  filename: string;
}
