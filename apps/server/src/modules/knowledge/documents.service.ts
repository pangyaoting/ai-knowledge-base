import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KnowledgeService } from './knowledge.service';
import { EmbeddingService } from './embedding.service';
import { cleanText, detectFileType, extractText } from './utils/document-parser';
import { splitText } from './utils/text-splitter';

const UPLOAD_DIR = join(process.cwd(), 'uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['pdf', 'docx', 'md', 'txt'];
const CHUNK_SIZE = 500; // 每块目标字符数（已确认的决策）
const CHUNK_OVERLAP = 100; // 相邻块重叠字符数（已确认的决策）

/**
 * 文档服务：上传 → 解析 → 清洗 → 分块 → 存 Chunk（同步流水线）
 * 阶段 4 会升级为 BullMQ 异步队列 + 进度推送，这里先同步跑通
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private prisma: PrismaService,
    private knowledgeService: KnowledgeService,
    private embeddingService: EmbeddingService,
  ) {}

  /**
   * 上传并处理文档（multipart/form-data，字段名 file）
   * 流程：校验归属 → 校验文件 → 存盘 → 建 Document(processing) → 解析分块 → 状态 done/failed
   */
  async upload(userId: string, knowledgeBaseId: string, file: Express.Multer.File | undefined) {
    // 1. 校验知识库归属（不属于当前用户 → 404，与知识库 CRUD 一致）
    await this.knowledgeService.findOne(userId, knowledgeBaseId);

    // 2. 校验文件
    if (!file) {
      throw new BadRequestException('未收到文件（multipart 字段名应为 file）');
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException('文件不能超过 10MB');
    }
    const fileType = detectFileType(file.originalname);
    if (!fileType || !ALLOWED_TYPES.includes(fileType)) {
      throw new BadRequestException('仅支持 PDF / Word(.docx) / Markdown / TXT 文件');
    }

    // 3. 存盘：UUID 改名防重名/防路径注入，扩展名保留
    const storedName = `${randomUUID()}.${fileType}`;
    if (!existsSync(UPLOAD_DIR)) {
      mkdirSync(UPLOAD_DIR, { recursive: true });
    }
    const filepath = join('uploads', storedName);
    writeFileSync(join(UPLOAD_DIR, storedName), file.buffer);

    // 4. 创建 Document 记录（processing）
    const document = await this.prisma.document.create({
      data: {
        knowledgeBaseId,
        filename: file.originalname,
        filepath,
        fileSize: file.size,
        fileType,
        status: 'processing',
      },
    });

    try {
      // 5. 解析 → 清洗
      const rawText = await extractText(file.buffer, fileType);
      const cleaned = cleanText(rawText);
      if (!cleaned) {
        throw new Error('未能从文档中提取到文本（可能是扫描件或不含文字的 PDF）');
      }

      // 6. 递归字符分块
      const chunks = splitText(cleaned, { chunkSize: CHUNK_SIZE, overlap: CHUNK_OVERLAP });

      // 7. 批量写入 Chunk 表（createMany 一条 SQL 插入全部，比循环 create 快很多）
      await this.prisma.chunk.createMany({
        data: chunks.map((content, index) => ({
          documentId: document.id,
          content,
          chunkIndex: index,
        })),
      });

      // 8. 向量化：取回刚插入的 chunk → 批量调 bge-m3 → 写回 embedding 列
      const created = await this.prisma.chunk.findMany({
        where: { documentId: document.id },
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
      this.logger.log(
        `向量化完成: ${file.originalname} → ${created.length} 个向量(1024维)`,
      );

      // 9. 状态 → done，返回带 chunk 数量
      const updated = await this.prisma.document.update({
        where: { id: document.id },
        data: { status: 'done' },
        include: { _count: { select: { chunks: true } } },
      });
      this.logger.log(
        `文档处理完成: ${file.originalname} (${file.size} bytes) → ${chunks.length} 个 chunk`,
      );
      return updated;
    } catch (err) {
      // 失败：删掉已存的文件和已写入的 chunk（不留孤儿数据），
      // Document 保留并标记 failed 供前端展示原因
      try {
        unlinkSync(join(UPLOAD_DIR, storedName));
      } catch {
        /* 文件可能不存在，忽略 */
      }
      await this.prisma.chunk.deleteMany({ where: { documentId: document.id } });
      const message = (err as Error).message || '解析失败';
      await this.prisma.document.update({
        where: { id: document.id },
        data: { status: 'failed', error: message },
      });
      this.logger.warn(`文档解析失败: ${file.originalname} → ${message}`);
      throw new BadRequestException(`文档解析失败: ${message}`);
    }
  }

  /** 文档列表（带 chunk 数量） */
  async findAll(userId: string, knowledgeBaseId: string) {
    await this.knowledgeService.findOne(userId, knowledgeBaseId);
    return this.prisma.document.findMany({
      where: { knowledgeBaseId },
      include: { _count: { select: { chunks: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 删除文档：chunk 由外键级联删除，磁盘文件手动删 */
  async remove(userId: string, knowledgeBaseId: string, documentId: string) {
    await this.knowledgeService.findOne(userId, knowledgeBaseId);
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, knowledgeBaseId },
    });
    if (!doc) {
      throw new NotFoundException('文档不存在');
    }
    await this.prisma.document.delete({ where: { id: documentId } });
    try {
      unlinkSync(join(process.cwd(), doc.filepath));
    } catch {
      /* 文件可能已不存在，忽略 */
    }
    return { success: true };
  }
}

/** 数字数组 → pgvector 字面量字符串，如 [0.1,0.2,...] → "[0.1,0.2,...]" */
function toPgVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
