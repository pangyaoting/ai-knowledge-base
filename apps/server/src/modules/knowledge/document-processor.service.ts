import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import {
  cleanText,
  extractText,
  sanitizeControlChars,
  type DocType,
} from './utils/document-parser';
import { splitCode, splitText } from './utils/text-splitter';
import { splitStructuredMd } from './utils/structured-splitter';
import { extractSymbols } from './utils/code-indexer';

/** 参与符号索引的代码语言（TS Compiler API 可解析；html/css/py 等跳过） */
const CODE_SYMBOL_EXTS = ['ts', 'tsx', 'js', 'jsx', 'vue', 'mjs', 'cjs'];

const UPLOAD_DIR = join(process.cwd(), 'uploads');
const CHUNK_SIZE = 500; // 每块目标字符数（已确认的决策）
const CHUNK_OVERLAP = 100; // 相邻块重叠字符数（已确认的决策）
const CHILD_CHUNK_SIZE = 500; // P2 父子分块：子块（检索片）目标字符数
const CHILD_OVERLAP = 100; // 子块重叠字符数

/**
 * P2 父子分块规划（纯函数，便于单测）：
 * - 父块 ≤ 子块大小 → 父块自身就是叶子（直接向量化，命中返回自身）
 * - 父块 > 子块大小 → 切成多个子块（带向量做检索），父块留作"命中后喂模型的全文容器"
 * @returns embed 需要向量化的行（小父块自身 + 大父块切出的子块）；childRows 待插入的子块
 */
export function planParentChildren(
  parents: Array<{ id: string; content: string }>,
  childSize = CHILD_CHUNK_SIZE,
): {
  embed: Array<{ id: string; content: string }>;
  childRows: Array<{ content: string; parentId: string }>;
} {
  const embed: Array<{ id: string; content: string }> = [];
  const childRows: Array<{ content: string; parentId: string }> = [];
  for (const p of parents) {
    if (p.content.length <= childSize) {
      embed.push({ id: p.id, content: p.content });
    } else {
      for (const piece of splitText(p.content, { chunkSize: childSize, overlap: CHILD_OVERLAP })) {
        childRows.push({ content: piece, parentId: p.id });
      }
    }
  }
  return { embed, childRows };
}

/** 文档处理任务的数据载荷 */
export interface DocumentJobData {
  userId: string;
  documentId: string;
  knowledgeBaseId: string;
  storedName: string; // 磁盘文件名（uploads/uuid.txt）
  fileType: string; // pdf / docx / md / txt / code
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
  ) {}

  async processDocument(data: DocumentJobData): Promise<void> {
    const { documentId, storedName, fileType, originalName, knowledgeBaseId } = data;
    const absPath = join(UPLOAD_DIR, storedName);
    try {
      if (!existsSync(absPath)) {
        throw new Error('文件已不存在，无法解析');
      }
      const buffer = readFileSync(absPath);

      // 解析 → 清洗（代码文件不折叠空白/缩进，否则代码语义与可读性被破坏）
      const rawText = await extractText(buffer, fileType as DocType);
      const isCode = fileType === 'code';

      // 二进制被误判成文本/代码（UTF-16 文件、伪装扩展名的二进制等）：
      // UTF-8 解码后 NUL/替换字符占比高 → 转为"附件"保管，不报解析失败
      if (isCode || fileType === 'txt' || fileType === 'md') {
        const nullRatio = (rawText.match(/\u0000/g)?.length ?? 0) / Math.max(rawText.length, 1);
        const replRatio = (rawText.match(/\uFFFD/g)?.length ?? 0) / Math.max(rawText.length, 1);
        if (nullRatio > 0.01 || replRatio > 0.05) {
          await this.prisma.document.update({
            where: { id: documentId },
            data: { status: 'done', error: null, fileType: 'bin' },
          });
          this.logger.warn(`二进制内容转为附件（不参与检索）: ${originalName}`);
          return;
        }
      }

      // 代码文件不折叠空白/缩进（否则代码语义被破坏），但仍要删控制字符（\u0000 等）——
      // 否则含 NUL 的代码/HTML 入库后，检索命中再落库会触发 PG 22P05 崩溃
      const cleaned = isCode
        ? sanitizeControlChars(rawText).replace(/\r\n/g, '\n').trim()
        : cleanText(rawText);
      if (!cleaned) {
        throw new Error('未能从文档中提取到文本（可能是扫描件或不含文字的 PDF）');
      }

      await this.prisma.document.update({
        where: { id: documentId },
        data: { status: 'processing', error: null },
      });

      // 分块 + 向量化：
      // - code：代码分块器（块首标注来源文件）
      // - md：结构化分块（按标题分节、表格保表头，块带章节路径——P1 提升检索上下文）
      // - 其他：字符分块
      const structuredChunks =
        fileType === 'md' && !isCode ? splitStructuredMd(cleaned) : undefined;
      const chunkCount = await this.indexText(
        documentId,
        cleaned,
        isCode ? `文件: ${originalName}` : undefined,
        structuredChunks,
      );

      // C 符号级索引：可解析的代码文件（ts/js/vue…）生成符号表，
      // 检索命中符号名时直接返回该符号的实现源码（不靠文本相似度碰运气）
      if (
        isCode &&
        CODE_SYMBOL_EXTS.some((ext) => originalName.toLowerCase().endsWith(`.${ext}`))
      ) {
        await this.indexSymbols(documentId, originalName, cleaned);
      }

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
      // 新文档失败 → 恢复被标记为"替换中"的旧文档（不丢旧数据）
      await this.prisma.document
        .updateMany({
          where: { knowledgeBaseId, filename: originalName, status: 'replacing' },
          data: { status: 'done', error: null },
        })
        .catch(() => undefined);
      this.logger.warn(`文档处理失败: ${originalName} → ${message}`);
    }
  }

  /**
   * 把清洗后的文本分块并向量化（上传队列与在线编辑共用）：
   * 删旧 chunk → 建新 chunk → 批量调 bge-m3 写回 embedding → 返回叶子块数
   * 分块策略：
   * - externalChunks（md 结构化父块）→ 父子分块：父块 ≤500 直接向量化；父块更大切成子块检索、
   *   命中后取父块全文喂模型（P2）
   * - prefix（代码）→ 代码分块器；其他 → 字符分块（均无父块，块自身即叶子）
   */
  async indexText(
    documentId: string,
    cleaned: string,
    prefix?: string,
    externalChunks?: string[],
  ): Promise<number> {
    await this.prisma.chunk.deleteMany({ where: { documentId } });

    // —— P2 父子分块路径（md 结构化父块）——
    if (externalChunks?.length) {
      // 1. 父块入库（不带向量：容器角色，检索只命中子块/小父块）
      await this.prisma.chunk.createMany({
        data: externalChunks.map((content, index) => ({
          documentId,
          content,
          chunkIndex: index,
          parentId: null,
        })),
      });
      const parents = await this.prisma.chunk.findMany({
        where: { documentId, parentId: null },
        select: { id: true, content: true },
        orderBy: { chunkIndex: 'asc' },
      });
      // 2. 规划：小父块自身做叶子；大父块切成子块
      const { embed, childRows } = planParentChildren(parents);
      let childIndex = 0;
      await this.prisma.chunk.createMany({
        data: childRows.map((r) => ({
          documentId,
          content: r.content,
          chunkIndex: childIndex++,
          parentId: r.parentId,
        })),
      });
      // 3. 子块也纳入向量化（从库读回真实 id）
      if (childRows.length > 0) {
        const children = await this.prisma.chunk.findMany({
          where: { documentId, parentId: { not: null } },
          select: { id: true, content: true },
        });
        embed.push(...children);
      }
      await this.embedRows(embed);
      return embed.length;
    }

    // —— 普通路径：字符切 / 代码切，块自身即叶子（无父块）——
    const chunks = prefix
      ? splitCode(cleaned, prefix, { chunkSize: 900 })
      : splitText(cleaned, { chunkSize: CHUNK_SIZE, overlap: CHUNK_OVERLAP });
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
    await this.embedRows(created);
    return created.length;
  }

  /** 批量向量化并写回 embedding（父块不在此列：不参与检索） */
  private async embedRows(rows: Array<{ id: string; content: string }>): Promise<void> {
    if (rows.length === 0) return;
    const vectors = await this.embeddingService.embedTexts(rows.map((r) => r.content));
    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < rows.length; i++) {
        await tx.$executeRaw`
          UPDATE "chunks" SET "embedding" = ${toPgVector(vectors[i])}::vector WHERE "id" = ${rows[i].id}
        `;
      }
    });
  }

  /**
   * C 符号级索引：解析代码文件符号表入库（AST 提取函数/类/组件等 + 行号范围 + 实现源码）。
   * 同名文档重传/内容变更时全量替换（先删后建）。
   */
  private async indexSymbols(documentId: string, filename: string, code: string): Promise<void> {
    await this.prisma.codeSymbol.deleteMany({ where: { documentId } });
    const symbols = extractSymbols(filename, code);
    if (symbols.length === 0) return;
    const lines = code.split('\n');
    await this.prisma.codeSymbol.createMany({
      data: symbols.map((s) => ({
        documentId,
        filename,
        symbolName: s.name,
        kind: s.kind,
        signature: s.signature,
        body: lines
          .slice(s.startLine - 1, s.endLine)
          .join('\n')
          .trim(),
        startLine: s.startLine,
        endLine: s.endLine,
      })),
    });
    this.logger.log(`符号索引: ${filename} → ${symbols.length} 个符号`);
  }
}

/** 数字数组 → pgvector 字面量字符串，如 [0.1,0.2,...] → "[0.1,0.2,...]" */
function toPgVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
