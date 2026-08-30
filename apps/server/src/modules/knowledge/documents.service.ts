import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KnowledgeService } from './knowledge.service';
import { DocumentQueueService } from './document-queue.service';
import { DocumentProcessor } from './document-processor.service';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { cleanText, detectFileType, extractText, type DocType } from './utils/document-parser';

const UPLOAD_DIR = join(process.cwd(), 'uploads');

// 供其他模块（如示例数据导入）复用
export { UPLOAD_DIR };

/**
 * 文档服务：上传 → 入队（异步处理）→ 状态轮询；列表/下载/编辑/删除
 * 解析、分块、向量化已移到 DocumentProcessor（BullMQ worker 后台执行）
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private prisma: PrismaService,
    private knowledgeService: KnowledgeService,
    private configService: ConfigService,
    private queueService: DocumentQueueService,
    private processor: DocumentProcessor,
  ) {}

  /** 单文件大小上限（.env 可配 MAX_FILE_SIZE_MB，默认 20MB） */
  private get maxFileSize(): number {
    const mb = Number(this.configService.get<string>('MAX_FILE_SIZE_MB', '20'));
    return (Number.isFinite(mb) && mb > 0 ? mb : 20) * 1024 * 1024;
  }

  /**
   * 上传文档（multipart/form-data，字段名 file）
   * 流程：校验归属 → 校验文件 → 存盘 → 建 Document(pending) → 入队 → 立即返回
   * 真正的解析/分块/向量化由队列 worker 异步执行，前端轮询文档状态
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
    // 目录上传时 name 是独立文本字段（UTF-8 正确解码，直接采用）；
    // 普通上传走 file.originalname（busboy 按 latin1 解码，需要修复中文乱码）
    const originalName = name ? name : fixMojibakeFilename(file.originalname);
    // 附件（无法解析的类型：图片/二进制/未知扩展名）：保留原扩展名用于展示
    const rawExt = (file.originalname.split('.').pop() ?? '').toLowerCase() || 'bin';

    // 3. 存盘：UUID 改名防重名/防路径注入，扩展名保留
    const storedName = `${randomUUID()}.${fileType ?? rawExt}`;
    if (!existsSync(UPLOAD_DIR)) {
      mkdirSync(UPLOAD_DIR, { recursive: true });
    }
    writeFileSync(join(UPLOAD_DIR, storedName), file.buffer);

    // 4a. 附件：不支持解析的类型原样保管（不解析/不分块/不向量化，跳过队列）
    if (!fileType) {
      await this.removeSameName(knowledgeBaseId, originalName, null);
      const doc = await this.prisma.document.create({
        data: {
          knowledgeBaseId,
          filename: originalName,
          filepath: join('uploads', storedName),
          fileSize: file.size,
          fileType: rawExt,
          status: 'done', // 附件无需后台处理，直接完成
        },
      });
      this.logger.log(`附件已入库（不参与检索）: ${originalName}`);
      return doc;
    }

    // 4b. 创建 Document 记录（pending：已接收，待后台处理）
    const document = await this.prisma.document.create({
      data: {
        knowledgeBaseId,
        filename: originalName,
        filepath: join('uploads', storedName),
        fileSize: file.size,
        fileType,
        status: 'pending',
      },
    });

    // 同名旧文档立即标记"替换中"（列表显示"替换中"而非新旧并存被误认为"新增"；
    // 新文档解析失败时旧文档自动恢复为 done，不丢数据）
    await this.prisma.document
      .updateMany({
        where: { knowledgeBaseId, filename: originalName, id: { not: document.id } },
        data: { status: 'replacing' },
      })
      .catch(() => undefined);

    // 5. 入队并立即返回（解析/分块/向量化在后台执行，接口响应 <1s）
    await this.queueService.addDocumentJob({
      userId,
      documentId: document.id,
      knowledgeBaseId,
      storedName,
      fileType,
      originalName,
    });
    this.logger.log(`文档已入队: ${originalName} (${document.id})`);

    return this.prisma.document.findUnique({
      where: { id: document.id },
      include: { _count: { select: { chunks: true } } },
    });
  }

  /** 删除同名旧文档（含磁盘文件）。exceptId 传 null 表示全删；用于附件同步替换 */
  private async removeSameName(
    knowledgeBaseId: string,
    filename: string,
    exceptId: string | null,
  ): Promise<void> {
    const olds = await this.prisma.document.findMany({
      where: { knowledgeBaseId, filename, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    for (const old of olds) {
      await this.prisma.document.delete({ where: { id: old.id } });
      try {
        unlinkSync(join(process.cwd(), old.filepath));
      } catch {
        /* 文件可能已不存在，忽略 */
      }
    }
  }

  /** 文档列表（带 chunk 数量；前端据此轮询处理状态） */
  async findAll(userId: string, knowledgeBaseId: string) {
    await this.knowledgeService.findOne(userId, knowledgeBaseId);
    return this.prisma.document.findMany({
      where: { knowledgeBaseId },
      include: { _count: { select: { chunks: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 文档文本块列表（预览 + 引用定位）
   * 按 documentId 直接取全部切块（chunkIndex 升序），前端渲染"第 N 段"，
   * 聊天引用定位时按 chunkIndex 滚动高亮。归属校验：文档 → 知识库 → 当前用户。
   */
  async getChunks(userId: string, documentId: string) {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { knowledgeBase: { select: { ownerId: true } } },
    });
    if (!doc || doc.knowledgeBase.ownerId !== userId) {
      throw new NotFoundException('文档不存在');
    }
    const chunks = await this.prisma.chunk.findMany({
      where: { documentId },
      orderBy: { chunkIndex: 'asc' },
      select: { id: true, chunkIndex: true, content: true },
    });
    return { filename: doc.filename, fileType: doc.fileType, chunks };
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
      // 文档已不存在（可能刚被同名替换删除/并发删除）：幂等处理，视为删除成功
      return { success: true };
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
      // 只更新知识库内部（重新分块 + 向量化），不改写磁盘文件——
      // 知识库与本地文件分离：编辑内容/改名都不影响上传的原文件（下载拿到的始终是原始文件）
      const chunkCount = await this.processor.indexText(documentId, cleaned);
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
