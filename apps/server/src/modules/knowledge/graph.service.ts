import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KnowledgeService } from './knowledge.service';

const EXTRACT_MAX_CHARS = 4000; // 抽取时喂给 LLM 的文本上限（控制成本）
const EXPAND_LIMIT = 5; // 多跳扩展最多追加的关联片段数

interface ExtractResult {
  entities: Array<{ name: string; type?: string }>;
  relations: Array<{ source: string; relation: string; target: string }>;
}

/** 图谱节点（供前端渲染，按名称聚合） */
export interface GraphNode {
  name: string;
  type: string;
  count: number; // 出现文档数
}

export interface GraphEdge {
  source: string;
  relation: string;
  target: string;
  count: number;
}

/**
 * 知识图谱服务（GraphRAG-lite）：
 * - 抽取：文档处理时用 LLM 抽"实体 + 关系"，实体关联到出现的 chunk（多跳检索取回原文）；
 * - 多跳扩展：问题命中实体 → 沿关系找到相邻实体 → 取回它们的原文片段，作为额外证据；
 * - 图查询：聚合节点/边，供前端"知识网络"可视化。
 */
@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);
  private client: OpenAI;

  constructor(
    private prisma: PrismaService,
    private knowledgeService: KnowledgeService,
    private configService: ConfigService,
  ) {
    this.client = new OpenAI({
      apiKey: this.configService.get<string>('DEEPSEEK_API_KEY'),
      baseURL: this.configService.get<string>('DEEPSEEK_BASE_URL'),
    });
  }

  private get model(): string {
    return this.configService.get<string>('DEEPSEEK_MODEL', 'deepseek-chat');
  }

  // ==================== 抽取 ====================

  /**
   * 从文档抽取实体/关系并落库（幂等：先删该文档旧图谱再写入）。
   * 实体按名称去重，并把"名称出现在哪些 chunk"记录到 chunkIds（多跳取回原文用）。
   * 抽取失败只记录日志，不抛错（图谱是增强，不应影响文档处理主流程）。
   */
  async extractFromDocument(documentId: string): Promise<void> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, knowledgeBaseId: true, filename: true },
    });
    if (!doc) return;

    const chunks = await this.prisma.chunk.findMany({
      where: { documentId },
      select: { id: true, content: true },
      orderBy: { chunkIndex: 'asc' },
    });
    if (chunks.length === 0) return;

    const result = await this.extractWithLLM(chunks.map((c) => c.content).join('\n'));
    // 先清旧图谱（重新抽取幂等）
    await this.prisma.$transaction([
      this.prisma.graphEntity.deleteMany({ where: { documentId } }),
      this.prisma.graphRelation.deleteMany({ where: { documentId } }),
    ]);

    // 实体：记录名称出现在哪些 chunk（大小写不敏感，最多关联 5 个）
    for (const e of result.entities.slice(0, 30)) {
      const name = e.name.trim();
      if (name.length < 2) continue;
      const chunkIds = chunks
        .filter((c) => c.content.toLowerCase().includes(name.toLowerCase()))
        .slice(0, 5)
        .map((c) => c.id);
      await this.prisma.graphEntity.create({
        data: {
          knowledgeBaseId: doc.knowledgeBaseId,
          documentId,
          name,
          type: e.type || '概念',
          chunkIds: JSON.parse(JSON.stringify(chunkIds)),
        },
      });
    }

    // 关系
    for (const rel of result.relations) {
      const source = rel.source.trim();
      const target = rel.target.trim();
      const relation = rel.relation.trim();
      if (!source || !target || !relation) continue;
      await this.prisma.graphRelation.create({
        data: {
          knowledgeBaseId: doc.knowledgeBaseId,
          documentId,
          sourceName: source,
          relation,
          targetName: target,
        },
      });
    }
    this.logger.log(
      `图谱抽取完成: ${doc.filename} → 实体 ${result.entities.length} / 关系 ${result.relations.length}`,
    );
  }

  /** LLM 抽取（JSON 解析失败时回退为空结果，不抛错） */
  private async extractWithLLM(text: string): Promise<ExtractResult> {
    const truncated = text.slice(0, EXTRACT_MAX_CHARS);
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content:
              '你是知识图谱抽取助手。从文档中抽取重要概念（实体）和它们之间的关系。只输出 JSON，格式：' +
              '{"entities":[{"name":"实体名","type":"概念|技术|人物|组织|产品"}],"relations":[{"source":"实体A","relation":"关系词","target":"实体B"}]}。' +
              '要求：实体名用文档中的原词；只抽取文档明确提到的重要概念（不超过 30 个）；关系不超过 30 条；不要编造文档中没有的内容。',
          },
          { role: 'user', content: `文档内容：\n${truncated}` },
        ],
        max_tokens: 1500,
        temperature: 0,
      });
      const raw = res.choices[0]?.message?.content ?? '';
      const parsed = JSON.parse(
        raw.replace(/^```json\s*/i, '').replace(/```$/, ''),
      ) as ExtractResult;
      return {
        entities: Array.isArray(parsed.entities) ? parsed.entities : [],
        relations: Array.isArray(parsed.relations) ? parsed.relations : [],
      };
    } catch (err) {
      this.logger.warn(`图谱抽取 JSON 解析失败: ${(err as Error).message}`);
      return { entities: [], relations: [] };
    }
  }

  /** 重建某个知识库全部已完成文档的图谱（fire-and-forget，前端轮询图数据） */
  async rebuild(knowledgeBaseId: string, userId: string) {
    await this.knowledgeService.findOne(userId, knowledgeBaseId);
    void this.rebuildInternal(knowledgeBaseId);
    return { success: true };
  }

  private async rebuildInternal(knowledgeBaseId: string) {
    const docs = await this.prisma.document.findMany({
      where: { knowledgeBaseId, status: 'done' },
      select: { id: true },
    });
    for (const doc of docs) {
      await this.extractFromDocument(doc.id).catch((err) =>
        this.logger.warn(`图谱重建失败 ${doc.id}: ${(err as Error).message}`),
      );
    }
    this.logger.log(`知识库 ${knowledgeBaseId} 图谱重建完成（${docs.length} 篇文档）`);
  }

  // ==================== 图查询 ====================

  /** 聚合图谱：节点（按名称）+ 边（按三元组），供前端可视化 */
  async getGraph(knowledgeBaseId: string, userId: string) {
    await this.knowledgeService.findOne(userId, knowledgeBaseId);
    const [entities, relations] = await Promise.all([
      this.prisma.graphEntity.findMany({
        where: { knowledgeBaseId },
        select: { name: true, type: true },
      }),
      this.prisma.graphRelation.findMany({
        where: { knowledgeBaseId },
        select: { sourceName: true, relation: true, targetName: true },
      }),
    ]);
    const nodeMap = new Map<string, GraphNode>();
    for (const e of entities) {
      const cur = nodeMap.get(e.name);
      if (cur) cur.count += 1;
      else nodeMap.set(e.name, { name: e.name, type: e.type, count: 1 });
    }
    const edgeMap = new Map<string, GraphEdge>();
    for (const r of relations) {
      const key = `${r.sourceName}|${r.relation}|${r.targetName}`;
      const cur = edgeMap.get(key);
      if (cur) cur.count += 1;
      else
        edgeMap.set(key, {
          source: r.sourceName,
          relation: r.relation,
          target: r.targetName,
          count: 1,
        });
    }
    return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
  }

  /** 某实体的原文片段（节点详情面板用） */
  async getEntityChunks(knowledgeBaseId: string, userId: string, name: string) {
    await this.knowledgeService.findOne(userId, knowledgeBaseId);
    const rows = await this.prisma.graphEntity.findMany({
      where: { knowledgeBaseId, name },
      take: 5,
    });
    const chunkIds = [...new Set(rows.flatMap((r) => (r.chunkIds as string[]) ?? []))];
    if (chunkIds.length === 0) return [];
    // 取回片段原文（含文件名与 chunkIndex，供定位原文）
    const chunks = await this.prisma.$queryRaw<
      Array<{
        chunk_id: string;
        chunk_index: number;
        content: string;
        document_id: string;
        filename: string;
      }>
    >`
      SELECT c.id AS chunk_id, c.chunk_index, c.content, c.document_id, d.filename
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.id = ANY(${chunkIds}::text[])
      ORDER BY d.filename, c.chunk_index
      LIMIT 10
    `;
    return chunks.map((c) => ({
      chunkId: c.chunk_id,
      chunkIndex: c.chunk_index,
      content: c.content,
      documentId: c.document_id,
      filename: c.filename,
    }));
  }

  // ==================== 多跳扩展 ====================

  /**
   * 多跳扩展：问题命中实体 → 1 跳关系找到相邻实体 → 取回它们的原文片段。
   * 用于把"平铺相似度检索"升级为"沿关系链推理"（RAG 的公认短板：A 和 B 什么关系）。
   * @param kbIds 可选知识库范围（空 = 全部）
   * @returns 关联片段 [{ chunkId, documentId, chunkIndex, content, filename }]
   */
  async expandQuestion(
    userId: string,
    question: string,
    kbIds?: string[],
  ): Promise<
    Array<{
      chunkId: string;
      documentId: string;
      chunkIndex: number;
      content: string;
      filename: string;
    }>
  > {
    const kbFilter = kbIds?.length ? { knowledgeBaseId: { in: kbIds } } : {};
    // ① 取该范围下的实体名（按出现次数取前 200 个，命中匹配成本可控）
    const names = await this.prisma.graphEntity.groupBy({
      by: ['name'],
      where: kbFilter,
      _count: { _all: true },
      orderBy: { _count: { name: 'desc' } },
      take: 200,
    });
    // ② 问题命中哪些实体（实体名出现在问题里，且不是超短词避免噪声）
    const q = question.toLowerCase();
    const matched = names
      .filter((n) => n.name.length >= 2 && q.includes(n.name.toLowerCase()))
      .slice(0, 5)
      .map((n) => n.name);
    if (matched.length === 0) return [];

    // ③ 1 跳关系：命中实体相连的相邻实体
    const rels = await this.prisma.graphRelation.findMany({
      where: {
        ...kbFilter,
        OR: [{ sourceName: { in: matched } }, { targetName: { in: matched } }],
      },
      select: { sourceName: true, targetName: true },
      take: 100,
    });
    const related = new Set<string>(matched);
    rels.forEach((r) => {
      related.add(r.sourceName);
      related.add(r.targetName);
    });

    // ④ 取相关实体的原文片段（去重后最多 EXPAND_LIMIT 条）
    const entityRows = await this.prisma.graphEntity.findMany({
      where: { ...kbFilter, name: { in: [...related] } },
      select: { chunkIds: true },
      take: 200,
    });
    const chunkIds = [...new Set(entityRows.flatMap((r) => (r.chunkIds as string[]) ?? []))];
    if (chunkIds.length === 0) return [];
    const chunks = await this.prisma.$queryRaw<
      Array<{
        chunk_id: string;
        chunk_index: number;
        content: string;
        document_id: string;
        filename: string;
      }>
    >`
      SELECT c.id AS chunk_id, c.chunk_index, c.content, c.document_id, d.filename
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.id = ANY(${chunkIds}::text[])
      ORDER BY c.chunk_index
      LIMIT ${EXPAND_LIMIT}
    `;
    if (chunks.length > 0) {
      this.logger.log(
        `图谱多跳扩展: 命中实体 [${matched.join(', ')}] → 追加 ${chunks.length} 条关联片段`,
      );
    }
    return chunks.map((c) => ({
      chunkId: c.chunk_id,
      chunkIndex: c.chunk_index,
      content: c.content,
      documentId: c.document_id,
      filename: c.filename,
    }));
  }
}
