import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { GraphService } from './graph.service';
import { cleanText, extractText, type DocType } from './utils/document-parser';
import { splitText } from './utils/text-splitter';

const UPLOAD_DIR = join(process.cwd(), 'uploads');
const CHUNK_SIZE = 500; // 每块目标字符数（已确认的决策）
const CHUNK_OVERLAP = 100; // 相邻块重叠字符数（已确认的决策）

/** 文档处理任务的数据载荷 */
export interface DocumentJobData {
  userId: string; // 归属用户（图谱抽取用用户的模型配置，BYO）
  documentId: string;
  knowledgeBaseId: string;
  storedName: string; // 磁盘文件名（uploads/uuid.txt）
  fileType: string; // pdf / docx / md / txt
  originalName: string; // 展示用文件名（可能带相对路径）
}

/**
 * 文档处理器：被 BullMQ worker 调用，负责 解析 → 清洗 → 分块 → 向量化 → 更新状态。
 * 失败时保留 Document(failed) 并记录原因（前端可见、可重传），清理半成品 chunk。
 */
@Injectable()
export class DocumentProcessor {
  private readonly logger = new Logger(DocumentProcessor.name);

  constructor(
    private prisma: PrismaService,
    private embeddingService: EmbeddingService,
    private graphService: GraphService,
  ) {}

  async processDocument(data: DocumentJobData): Promise<void> {
    const { documentId, storedName, fileType, originalName, knowledgeBaseId, userId } = data;
    const absPath = join(UPLOAD_DIR, storedName);
    try {
      if (!existsSync(absPath)) {
        throw new Error('文件已不存在，无法解析');
      }
      const buffer = readFileSync(absPath);

      // 解析 → 清洗
      const rawText = await extractText(buffer, fileType as DocType);
      const cleaned = cleanText(rawText);
      if (!cleaned) {
        throw new Error('未能从文档中提取到文本（可能是扫描件或不含文字的 PDF）');
      }

      await this.prisma.document.update({
        where: { id: documentId },
        data: { status: 'processing', error: null },
      });

      // 分块 + 向量化
      const chunkCount = await this.indexText(documentId, cleaned);

      // 知识图谱抽取（增强环节：使用用户自己的模型配置，未绑定则自动跳过；失败不影响文档主流程）
      await this.graphService
        .extractFromDocument(userId, documentId)
        .catch((err) =>
          this.logger.warn(`图谱抽取失败 ${originalName}: ${(err as Error).message}`),
        );

      // 同名替换：新文档处理成功后再删旧版（失败不丢旧版）
      const existing = await this.prisma.document.findFirst({
        where: {
          knowledgeBaseId,
          filename: originalName,
          id: { not: documentId },
        },
      });
      if (existing) {
        await this.prisma.document.delete({ where: { id: existing.id } });
        try {
          unlinkSync(join(process.cwd(), existing.filepath));
        } catch {
          /* 文件可能已不存在，忽略 */
        }
        this.logger.log(`同名文件替换: ${originalName}（旧文档 ${existing.id} 已删除）`);
      }

      await this.prisma.document.update({
        where: { id: documentId },
        data: { status: 'done' },
      });
      this.logger.log(`文档处理完成: ${originalName} → ${chunkCount} 个 chunk`);
    } catch (err) {
      // 失败：清理半成品 chunk，Document 保留并标记 failed 展示原因（异步场景无法直接抛给请求方）
      await this.prisma.chunk.deleteMany({ where: { documentId } }).catch(() => undefined);
      const message = (err as Error).message || '处理失败';
      await this.prisma.document
        .update({ where: { id: documentId }, data: { status: 'failed', error: message } })
        .catch(() => undefined);
      this.logger.warn(`文档处理失败: ${originalName} → ${message}`);
    }
  }

  /**
   * 把清洗后的文本分块并向量化（上传队列与在线编辑共用）：
   * 删旧 chunk → 建新 chunk → 批量调 bge-m3 写回 embedding → 返回 chunk 数
   */
  async indexText(documentId: string, cleaned: string): Promise<number> {
    const chunks = splitText(cleaned, { chunkSize: CHUNK_SIZE, overlap: CHUNK_OVERLAP });
    await this.prisma.chunk.deleteMany({ where: { documentId } });
    await this.prisma.chunk.createMany({
      data: chunks.map((content, index) => ({
        documentId,
        content,
        chunkIndex: index,
      })),
    });
    const created = await this.prisma.chunk.findMany({
      where: { documentId },
      select: { id: true, content: true },
      orderBy: { chunkIndex: 'asc' },
    });
    const vectors = await this.embeddingService.embedTexts(created.map((c) => c.content));
    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < created.length; i++) {
        await tx.$executeRaw`
          UPDATE "chunks" SET "embedding" = ${toPgVector(vectors[i])}::vector WHERE "id" = ${created[i].id}
        `;
      }
    });
    return chunks.length;
  }
}

/** 数字数组 → pgvector 字面量字符串，如 [0.1,0.2,...] → "[0.1,0.2,...]" */
function toPgVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
