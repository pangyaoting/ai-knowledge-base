import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmbeddingService } from '../knowledge/embedding.service';
import { RerankService } from '../knowledge/rerank.service';

/** 检索命中的来源片段 */
export interface RetrievalSource {
  chunkId: string;
  content: string;
  chunkIndex: number;
  documentId: string;
  filename: string;
  similarity: number;
}

/** 混合检索参数（RRF 融合常量） */
const RRF_K = 60; // RRF 平滑常数（论文默认值）

/**
 * RAG 检索服务：问题 → 向量化 → pgvector 余弦检索（语义）
 *                   + pg_trgm 关键词检索（精确词命中）
 *                   → RRF 排名融合 → Top-K 来源片段
 *
 * 为什么混合：向量检索擅长"语义相近"，但精确关键词（专有名词、型号、代码片段）
 * 会被 embedding 打散进语义空间而漏掉；pg_trgm 按子串命中补上这一路。
 * 为什么 RRF：只比较两路结果的【排名】而非分数，无需归一化、无需调权重。
 */
@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    private prisma: PrismaService,
    private embeddingService: EmbeddingService,
    private configService: ConfigService,
    private rerankService: RerankService,
  ) {}

  /** 向量相似度下限（.env 可配 MIN_SIMILARITY，默认 0.35）低于它的片段视为噪声丢弃 */
  private get minSimilarity(): number {
    const v = Number(this.configService.get<string>('MIN_SIMILARITY', '0.35'));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.35;
  }

  /**
   * 重排相关性门控下限（.env 可配 RERANK_MIN_SCORE，默认 0.1）。
   * bge-reranker 分数实测：相关≈0.9+，无关≈0.00x——低于阈值的片段直接丢弃，
   * 宁可返回空（触发"未检索到相关内容"兜底），也不拿无关片段误导回答。
   */
  private get rerankMinScore(): number {
    const v = Number(this.configService.get<string>('RERANK_MIN_SCORE', '0.1'));
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.1;
  }

  /**
   * 混合检索：向量 + 关键词两路并行，RRF 融合后返回 Top-K
   * @param question 用户问题
   * @param kbIds 可选：限定多个知识库范围（空 = 检索该用户全部知识库）
   * @param topK 返回条数，默认 5
   */
  async retrieve(
    userId: string,
    question: string,
    kbIds?: string[],
    topK = 5,
  ): Promise<RetrievalSource[]> {
    // 归属校验：绑定的知识库必须都属于当前用户（不存在或他人的 → 404）
    let kbLiteral: string | undefined;
    if (kbIds?.length) {
      const owned = await this.prisma.knowledgeBase.findMany({
        where: { id: { in: kbIds }, ownerId: userId },
        select: { id: true },
      });
      if (owned.length !== new Set(kbIds).size) {
        throw new NotFoundException('知识库不存在');
      }
      // owned 全部来自数据库（真实 UUID），拼成 PG 数组字面量作为参数，安全
      // 注意：id 列是 text 类型（Prisma String → TEXT），数组也要转 text[]，转 uuid[] 会报 text = uuid 不匹配
      kbLiteral = `{${owned.map((k) => `"${k.id}"`).join(',')}}`;
    }

    // 每路多取一些（RRF 合并后截断到 topK，多路候选重合时不会漏）
    const limit = Math.max(topK * 3, 15);

    // 1. 问题向量化（与入库用同一个模型，语义空间一致）
    const [vector] = await this.embeddingService.embedTexts([question]);
    const vectorStr = `[${vector.join(',')}]`;
    const minSim = this.minSimilarity;

    type RawRow = {
      chunk_id: string;
      content: string;
      chunk_index: number;
      document_id: string;
      filename: string;
      similarity: number;
    };

    // 2a. 向量检索（语义）：1 - cosine距离 = 余弦相似度，低于阈值的直接丢弃（不硬凑条数）
    // 按是否限定知识库写两条完整 SQL：所有值都用 $queryRaw 参数绑定（不拼接字符串，防注入）
    // 注意：未限定知识库（检索全部）时必须以 owner_id 过滤，否则会搜到其他用户的知识库（数据隔离）
    const vectorRows: RawRow[] = kbLiteral
      ? await this.prisma.$queryRaw<RawRow[]>`
          SELECT c.id AS chunk_id, c.content, c.chunk_index, d.id AS document_id, d.filename,
                 1 - (c.embedding <=> ${vectorStr}::vector) AS similarity
          FROM chunks c
          JOIN documents d ON d.id = c.document_id
          WHERE c.embedding IS NOT NULL
            AND d.knowledge_base_id = ANY(${kbLiteral}::text[])
            AND 1 - (c.embedding <=> ${vectorStr}::vector) >= ${minSim}
          ORDER BY c.embedding <=> ${vectorStr}::vector
          LIMIT ${limit}
        `
      : await this.prisma.$queryRaw<RawRow[]>`
          SELECT c.id AS chunk_id, c.content, c.chunk_index, d.id AS document_id, d.filename,
                 1 - (c.embedding <=> ${vectorStr}::vector) AS similarity
          FROM chunks c
          JOIN documents d ON d.id = c.document_id
          JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
          WHERE c.embedding IS NOT NULL
            AND kb.owner_id = ${userId}
            AND 1 - (c.embedding <=> ${vectorStr}::vector) >= ${minSim}
          ORDER BY c.embedding <=> ${vectorStr}::vector
          LIMIT ${limit}
        `;

    // 2b. 关键词检索（精确命中）：pg_trgm 三元组相似度，content % question 走 GIN 索引
    const keywordRows: RawRow[] = kbLiteral
      ? await this.prisma.$queryRaw<RawRow[]>`
          SELECT c.id AS chunk_id, c.content, c.chunk_index, d.id AS document_id, d.filename,
                 similarity(c.content, ${question}) AS similarity
          FROM chunks c
          JOIN documents d ON d.id = c.document_id
          WHERE c.embedding IS NOT NULL
            AND d.knowledge_base_id = ANY(${kbLiteral}::text[])
            AND c.content % ${question}
          ORDER BY similarity(c.content, ${question}) DESC
          LIMIT ${limit}
        `
      : await this.prisma.$queryRaw<RawRow[]>`
          SELECT c.id AS chunk_id, c.content, c.chunk_index, d.id AS document_id, d.filename,
                 similarity(c.content, ${question}) AS similarity
          FROM chunks c
          JOIN documents d ON d.id = c.document_id
          JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
          WHERE c.embedding IS NOT NULL
            AND kb.owner_id = ${userId}
            AND c.content % ${question}
          ORDER BY similarity(c.content, ${question}) DESC
          LIMIT ${limit}
        `;

    // 3. RRF 融合：召回粗排 Top-N（多取一些，给精排留余地）
    const merged = rrfMerge(vectorRows, keywordRows, Math.max(topK * 3, 15));

    // 4. 两阶段精排：交叉编码器重排 → 相关性门控 → 截断 Top-K
    // 重排分数是"问题↔片段"的精确相关性分，低于 RERANK_MIN_SCORE 的片段直接丢弃；
    // 重排不可用/失败时回退 RRF 顺序（降级模式，相关性把关较松但检索仍可用）。
    const toSource = (r: RawRow) => ({
      chunkId: r.chunk_id,
      content: r.content,
      chunkIndex: r.chunk_index,
      documentId: r.document_id,
      filename: r.filename,
      similarity: Number(r.similarity),
    });

    const ranked = await this.rerankService.rerank(
      question,
      merged.map((r) => r.content),
      Math.max(topK * 2, 10),
    );
    if (!ranked) {
      return merged.slice(0, topK).map(toSource);
    }

    const minScore = this.rerankMinScore;
    const gated = ranked
      .filter((r) => r.score >= minScore)
      .slice(0, topK)
      .map((r) => merged[r.index])
      .filter((r): r is RawRow => !!r)
      .map(toSource);
    if (gated.length === 0) {
      this.logger.log(
        `两阶段检索: 召回 ${merged.length} 条 → 重排后全部低于相关性阈值 ${minScore}，判定无相关内容`,
      );
    } else {
      this.logger.log(`两阶段检索: 召回 ${merged.length} 条 → 重排截断 ${gated.length} 条`);
    }
    return gated;
  }
}

/**
 * RRF（Reciprocal Rank Fusion）：把两路按排名合并为总分
 * 只依赖排名，不依赖分数量纲 → 向量相似度(0~1)和关键词相似度(0~1)可直接融合，无需归一化
 */
function rrfMerge(vectorRows: RawRow[], keywordRows: RawRow[], topK: number): RawRow[] {
  const scores = new Map<string, { score: number; row: RawRow }>();
  const add = (rows: RawRow[]) => {
    rows.forEach((row, i) => {
      const rank = i + 1;
      const contribution = 1 / (RRF_K + rank);
      const cur = scores.get(row.chunk_id);
      if (cur) {
        cur.score += contribution;
      } else {
        scores.set(row.chunk_id, { score: contribution, row });
      }
    });
  };
  add(vectorRows); // 先加向量：融合分相同时，语义命中优先展示
  add(keywordRows);
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.row);
}

type RawRow = {
  chunk_id: string;
  content: string;
  chunk_index: number;
  document_id: string;
  filename: string;
  similarity: number;
};
