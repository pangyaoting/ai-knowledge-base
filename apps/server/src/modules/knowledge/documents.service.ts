import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KnowledgeService } from './knowledge.service';
import { EmbeddingService } from './embedding.service';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { cleanText, detectFileType, extractText, type DocType } from './utils/document-parser';
import { splitText } from './utils/text-splitter';

const UPLOAD_DIR = join(process.cwd(), 'uploads');
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
    private configService: ConfigService,
  ) {}

  /** 单文件大小上限（.env 可配 MAX_FILE_SIZE_MB，默认 20MB） */
  private get maxFileSize(): number {
    const mb = Number(this.configService.get<string>('MAX_FILE_SIZE_MB', '20'));
    return (Number.isFinite(mb) && mb > 0 ? mb : 20) * 1024 * 1024;
  }

  /**
   * 上传并处理文档（multipart/form-data，字段名 file）
   * 流程：校验归属 → 校验文件 → 存盘 → 建 Document(processing) → 解析分块 → 状态 done/failed
   */
  async upload(
    userId: string,
    knowledgeBaseId: string,
    file: Express.Multer.File | undefined,
    name?: string,
  ) {
    // 1. 校验知识库归属（不属于当前用户 → 404，与知识库 CRUD 一致）
    await this.knowledgeService.findOne(userId, knowledgeBaseId);

    // 2. 校验文件
    if (!file) {
      throw new BadRequestException('未收到文件（multipart 字段名应为 file）');
    }
    if (file.size > this.maxFileSize) {
      const mb = Math.round(this.maxFileSize / 1024 / 1024);
      throw new BadRequestException(`文件不能超过 ${mb}MB`);
    }
    if (file.size === 0) {
      throw new BadRequestException('文件内容为空，无法解析');
    }
    const fileType = detectFileType(file.originalname);
    if (!fileType || !ALLOWED_TYPES.includes(fileType)) {
      throw new BadRequestException('仅支持 PDF / Word(.docx) / Markdown / TXT 文件');
    }
    // 目录上传时 name 是独立文本字段（UTF-8 正确解码，直接采用）；
    // 普通上传走 file.originalname（busboy 按 latin1 解码，需要修复中文乱码）
    const originalName = name ? name : fixMojibakeFilename(file.originalname);

    // 2.5 同名文件替换：先记住旧文档，等新文档全部处理成功后再删旧版
    //（避免新上传失败时旧版也丢了；成功前不打扰旧文档）
    const existing = await this.prisma.document.findFirst({
      where: { knowledgeBaseId, filename: originalName },
    });

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
        filename: originalName,
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

      // 6-8. 分块 + 向量化（与在线编辑共用同一管线）
      const chunkCount = await this.indexText(document.id, cleaned);
      this.logger.log(`向量化完成: ${file.originalname} → ${chunkCount} 个向量(1024维)`);

      // 9. 状态 → done，返回带 chunk 数量
      const updated = await this.prisma.document.update({
        where: { id: document.id },
        data: { status: 'done' },
        include: { _count: { select: { chunks: true } } },
      });

      // 9.5 新文档成功 → 删除旧版（chunk 由外键级联删除，磁盘文件手动删）
      if (existing) {
        await this.prisma.document.delete({ where: { id: existing.id } });
        try {
          unlinkSync(join(process.cwd(), existing.filepath));
        } catch {
          /* 文件可能已不存在，忽略 */
        }
        this.logger.log(`同名文件替换: ${originalName}（旧文档 ${existing.id} 已删除）`);
      }

      this.logger.log(
        `文档处理完成: ${file.originalname} (${file.size} bytes) → ${chunkCount} 个 chunk`,
      );
      return updated;
    } catch (err) {
      // 失败：全量清理（磁盘文件 + chunk + Document 行），不留"解析失败"的残渣记录
      try {
        unlinkSync(join(UPLOAD_DIR, storedName));
      } catch {
        /* 文件可能不存在，忽略 */
      }
      await this.prisma.chunk.deleteMany({ where: { documentId: document.id } });
      await this.prisma.document.delete({ where: { id: document.id } }).catch(() => undefined);
      const message = (err as Error).message || '解析失败';
      this.logger.warn(`文档处理失败（已全量清理）: ${file.originalname} → ${message}`);
      throw new BadRequestException(`文档解析失败：${message}`);
    }
  }

  /**
   * 把清洗后的文本重新分块并向量化（上传与在线编辑共用）：
   * 删旧 chunk → 建新 chunk → 批量调 bge-m3 写回 embedding → 返回 chunk 数
   */
  private async indexText(documentId: string, cleaned: string): Promise<number> {
    const chunks = splitText(cleaned, { chunkSize: CHUNK_SIZE, overlap: CHUNK_OVERLAP });
    // 编辑场景会残留旧块，先清掉再建（上传场景此刻还没有 chunk，等同空操作）
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

  /** 文档列表（带 chunk 数量） */
  async findAll(userId: string, knowledgeBaseId: string) {
    await this.knowledgeService.findOne(userId, knowledgeBaseId);
    return this.prisma.document.findMany({
      where: { knowledgeBaseId },
      include: { _count: { select: { chunks: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 获取文档文件（校验归属后返回文件名和绝对路径，供下载/预览） */
  async getFile(userId: string, knowledgeBaseId: string, documentId: string) {
    await this.knowledgeService.findOne(userId, knowledgeBaseId);
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, knowledgeBaseId },
    });
    if (!doc) {
      throw new NotFoundException('文档不存在');
    }
    const absPath = join(process.cwd(), doc.filepath);
    if (!existsSync(absPath)) {
      throw new NotFoundException('文件已不存在（可能被清理）');
    }
    return { filename: doc.filename, absPath };
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

  /** 获取文档可编辑的文本内容（重新解析原文件；PDF/Word 也能看到抽取的纯文本） */
  async getContent(userId: string, knowledgeBaseId: string, documentId: string) {
    await this.knowledgeService.findOne(userId, knowledgeBaseId);
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, knowledgeBaseId },
    });
    if (!doc) {
      throw new NotFoundException('文档不存在');
    }
    const absPath = join(process.cwd(), doc.filepath);
    if (!existsSync(absPath)) {
      throw new NotFoundException('文件已不存在（可能被清理）');
    }
    const buffer = readFileSync(absPath);
    const rawText = await extractText(buffer, doc.fileType as DocType);
    const content = cleanText(rawText);
    if (!content) {
      throw new BadRequestException('未能从文档中提取到文本（可能是扫描件，无法在线编辑）');
    }
    return { id: doc.id, filename: doc.filename, fileType: doc.fileType, content };
  }

  /**
   * 编辑文档：可改文件名、可改内容。
   * 改内容 = 重新分块 + 重新向量化（向量库同步更新，之后按新内容检索）
   */
  async updateContent(
    userId: string,
    knowledgeBaseId: string,
    documentId: string,
    dto: UpdateDocumentDto,
  ) {
    await this.knowledgeService.findOne(userId, knowledgeBaseId);
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, knowledgeBaseId },
    });
    if (!doc) {
      throw new NotFoundException('文档不存在');
    }

    const data: { filename?: string; fileType?: string; fileSize?: number; status?: string } = {};
    if (dto.filename !== undefined) {
      const name = dto.filename.trim();
      if (!name) {
        throw new BadRequestException('文件名不能为空');
      }
      data.filename = name;
    }
    if (dto.content !== undefined) {
      const cleaned = cleanText(dto.content);
      if (!cleaned) {
        throw new BadRequestException('内容为空，无法入库');
      }
      // 重写磁盘文件为编辑后的文本（保持"文件 = 唯一事实来源"：
      // 否则下载/重新解析拿到的还是旧内容）
      const absPath = join(process.cwd(), doc.filepath);
      writeFileSync(absPath, Buffer.from(cleaned, 'utf8'));
      // 原来若是二进制类型（pdf/docx），编辑后文件已变成纯文本，类型改为 txt
      if (doc.fileType === 'pdf' || doc.fileType === 'docx') {
        data.fileType = 'txt';
      }
      data.fileSize = Buffer.byteLength(cleaned, 'utf8');
      // 重新分块 + 向量化（复用上传管线）
      const chunkCount = await this.indexText(documentId, cleaned);
      data.status = 'done';
      this.logger.log(`文档内容已编辑并重新向量化: ${doc.filename} → ${chunkCount} 个 chunk`);
    }

    return this.prisma.document.update({
      where: { id: documentId },
      data,
      include: { _count: { select: { chunks: true } } },
    });
  }
}

/** 数字数组 → pgvector 字面量字符串，如 [0.1,0.2,...] → "[0.1,0.2,...]" */
function toPgVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * 修复 multipart 上传中文文件名乱码
 * 根因：busboy（multer 底层）默认把文件名按 latin1 解码，UTF-8 字节变成乱码字符（如 新→æ°）
 * 修复：latin1 字符还原成字节，再按 UTF-8 解码
 * 安全性：纯 ASCII 文件名不受影响；已经是正确 UTF-8 的文件名会还原出替换符，自动保持原样
 */
function fixMojibakeFilename(name: string): string {
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  // 还原出 U+FFFD 说明原字符串不是 latin1 乱码（可能是已正确的 UTF-8），保持原样
  if (decoded.includes('\uFFFD')) {
    return name;
  }
  return decoded;
}
