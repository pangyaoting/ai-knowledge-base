import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmbeddingService } from '../knowledge/embedding.service';
import { KnowledgeService } from '../knowledge/knowledge.service';

/** 检索命中的来源片段 */
export interface RetrievalSource {
  chunkId: string;
  content: string;
  chunkIndex: number;
  documentId: string;
  filename: string;
  similarity: number;
}

/**
 * RAG 检索服务：问题 → 向量化 → pgvector Top-K 余弦检索 → 来源片段
 * 这是"先查资料再回答"的"查资料"环节
 */
@Injectable()
export class RagService {
  constructor(
    private prisma: PrismaService,
    private embeddingService: EmbeddingService,
    private knowledgeService: KnowledgeService,
  ) {}

  /**
   * 检索与问题语义最相似的 Top-K 个 chunk
   * @param question 用户问题
   * @param knowledgeBaseId 可选：限定某个知识库范围
   * @param topK 返回条数，默认 5
   */
  async retrieve(
    userId: string,
    question: string,
    knowledgeBaseId?: string,
    topK = 5,
  ): Promise<RetrievalSource[]> {
    // 如果指定了知识库，先校验归属（不属于当前用户 → 404）
    if (knowledgeBaseId) {
      await this.knowledgeService.findOne(userId, knowledgeBaseId);
    }

    // 1. 问题向量化（与入库用同一个模型，语义空间一致）
    const [vector] = await this.embeddingService.embedTexts([question]);
    const vectorStr = `[${vector.join(',')}]`;

    // 2. pgvector 余弦距离 Top-K（<=> 是 cosine 距离算子，越小越相似）
    const rows = await this.prisma.$queryRaw<
      Array<{
        chunk_id: string;
        content: string;
        chunk_index: number;
        document_id: string;
        filename: string;
        similarity: number;
      }>
    >`
      SELECT
        c.id AS chunk_id,
        c.content,
        c.chunk_index,
        d.id AS document_id,
        d.filename,
        1 - (c.embedding <=> ${vectorStr}::vector) AS similarity
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.embedding IS NOT NULL
        ${knowledgeBaseId ? Prisma.sql`AND d.knowledge_base_id = ${knowledgeBaseId}` : Prisma.empty}
      ORDER BY c.embedding <=> ${vectorStr}::vector
      LIMIT ${topK}
    `;

    return rows.map((r) => ({
      chunkId: r.chunk_id,
      content: r.content,
      chunkIndex: r.chunk_index,
      documentId: r.document_id,
      filename: r.filename,
      similarity: Number(r.similarity),
    }));
  }
}
