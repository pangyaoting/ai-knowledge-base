import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DocumentQueueService } from './document-queue.service';
import { UPLOAD_DIR } from './documents.service';

/** 示例文档内容（短而实用，覆盖平台本身与 RAG 概念） */
const DEMO_DOCS: Array<{ name: string; content: string }> = [
  {
    name: '什么是RAG.md',
    content:
      'RAG（Retrieval-Augmented Generation，检索增强生成）是让大模型"先查资料再回答"的技术。\n' +
      '流程：1. 把文档分块并向量化存入向量库；2. 提问时检索最相关的片段；3. 把片段注入提示词，让模型基于资料回答。\n' +
      'RAG 解决了大模型的幻觉问题，也让私有知识可以被安全地问答。',
  },
  {
    name: 'AI基础概念.md',
    content:
      '人工智能（AI）是让机器模拟人类智能的技术。机器学习是 AI 的核心方法：从数据中学习规律。\n' +
      '深度学习使用多层神经网络，是大语言模型（LLM）的基础。向量表示（Embedding）把文字变成高维空间中的点，语义相近的文字距离更近。',
  },
  {
    name: '平台使用指南.md',
    content:
      '欢迎使用 AI 知识库问答平台！三步开始：\n' +
      '1. 创建知识库：在「知识库」页新建一个库；\n' +
      '2. 上传文档：支持 PDF/Word/Markdown/TXT，可多选或整目录上传，系统自动解析分块并向量化；\n' +
      '3. 开始提问：进入「对话」页，选择知识库范围后提问，回答会附带引用来源。\n' +
      '打开「数据看板」可以查看使用统计与 Token 消耗。',
  },
];

/**
 * 示例数据一键导入：为当前用户创建"示例知识库" + 3 篇示例文档。
 * 文档复用异步队列处理（写文件 → 建记录 → 入队），展示真实管线。
 * 幂等：已存在"示例知识库"则直接返回，不重复创建。
 */
@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  constructor(
    private prisma: PrismaService,
    private queueService: DocumentQueueService,
  ) {}

  async seed(userId: string) {
    const existing = await this.prisma.knowledgeBase.findFirst({
      where: { ownerId: userId, name: '示例知识库' },
    });
    if (existing) {
      return { knowledgeBaseId: existing.id, created: false, documents: DEMO_DOCS.length };
    }

    const kb = await this.prisma.knowledgeBase.create({
      data: {
        name: '示例知识库',
        description: '一键导入的示例数据：RAG 概念、AI 基础与平台使用指南（自动解析向量化）',
        ownerId: userId,
      },
    });

    if (!existsSync(UPLOAD_DIR)) {
      mkdirSync(UPLOAD_DIR, { recursive: true });
    }
    for (const doc of DEMO_DOCS) {
      const storedName = `${randomUUID()}.md`;
      writeFileSync(join(UPLOAD_DIR, storedName), Buffer.from(doc.content, 'utf8'));
      const document = await this.prisma.document.create({
        data: {
          knowledgeBaseId: kb.id,
          filename: doc.name,
          filepath: join('uploads', storedName),
          fileSize: Buffer.byteLength(doc.content, 'utf8'),
          fileType: 'md',
          status: 'pending',
        },
      });
      await this.queueService.addDocumentJob({
        documentId: document.id,
        knowledgeBaseId: kb.id,
        storedName,
        fileType: 'md',
        originalName: doc.name,
      });
    }
    this.logger.log(`示例数据导入完成: user=${userId} kb=${kb.id} docs=${DEMO_DOCS.length}`);
    return { knowledgeBaseId: kb.id, created: true, documents: DEMO_DOCS.length };
  }
}
