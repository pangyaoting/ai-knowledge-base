import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmbeddingService } from '../knowledge/embedding.service';
import { RerankService } from '../knowledge/rerank.service';
import { rrfMerge } from './rrf';

/** 检索命中的来源片段（similarity 为 null 表示来自知识图谱扩展的关联片段，无向量相似度） */
export interface RetrievalSource {
  chunkId: string;
  content: string;
  chunkIndex: number;
  documentId: string;
  filename: string;
  similarity: number | null;
}

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
    docIds?: string[], // A 档案锁定：限定只在命中的文档内检索
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
    // 文档范围（A 档案锁定）；null = 不限（参数绑定，防注入）
    const docLiteral =
      docIds && docIds.length > 0 ? `{${docIds.map((id) => `"${id}"`).join(',')}}` : null;

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
          SELECT COALESCE(parent_chunk.id, c.id) AS chunk_id,
                 COALESCE(parent_chunk.content, c.content) AS content,
                 COALESCE(parent_chunk.chunk_index, c.chunk_index) AS chunk_index,
                 d.id AS document_id, d.filename,
                 1 - (c.embedding <=> ${vectorStr}::vector) AS similarity
          FROM chunks c
          JOIN documents d ON d.id = c.document_id
          LEFT JOIN chunks parent_chunk ON parent_chunk.id = c.parent_id
          WHERE c.embedding IS NOT NULL
            AND d.knowledge_base_id = ANY(${kbLiteral}::text[])
            AND (${docLiteral}::text[] IS NULL OR d.id = ANY(${docLiteral}::text[]))
            AND 1 - (c.embedding <=> ${vectorStr}::vector) >= ${minSim}
          ORDER BY c.embedding <=> ${vectorStr}::vector
          LIMIT ${limit}
        `
      : await this.prisma.$queryRaw<RawRow[]>`
          SELECT COALESCE(parent_chunk.id, c.id) AS chunk_id,
                 COALESCE(parent_chunk.content, c.content) AS content,
                 COALESCE(parent_chunk.chunk_index, c.chunk_index) AS chunk_index,
                 d.id AS document_id, d.filename,
                 1 - (c.embedding <=> ${vectorStr}::vector) AS similarity
          FROM chunks c
          JOIN documents d ON d.id = c.document_id
          LEFT JOIN chunks parent_chunk ON parent_chunk.id = c.parent_id
          JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
          WHERE c.embedding IS NOT NULL
            AND kb.owner_id = ${userId}
            AND (${docLiteral}::text[] IS NULL OR d.id = ANY(${docLiteral}::text[]))
            AND 1 - (c.embedding <=> ${vectorStr}::vector) >= ${minSim}
          ORDER BY c.embedding <=> ${vectorStr}::vector
          LIMIT ${limit}
        `;

    // 2b. 关键词检索（精确命中）：pg_trgm 三元组相似度，content % question 走 GIN 索引
    const keywordRows: RawRow[] = kbLiteral
      ? await this.prisma.$queryRaw<RawRow[]>`
          SELECT COALESCE(parent_chunk.id, c.id) AS chunk_id,
                 COALESCE(parent_chunk.content, c.content) AS content,
                 COALESCE(parent_chunk.chunk_index, c.chunk_index) AS chunk_index,
                 d.id AS document_id, d.filename,
                 similarity(c.content, ${question}) AS similarity
          FROM chunks c
          JOIN documents d ON d.id = c.document_id
          LEFT JOIN chunks parent_chunk ON parent_chunk.id = c.parent_id
          WHERE c.embedding IS NOT NULL
            AND d.knowledge_base_id = ANY(${kbLiteral}::text[])
            AND (${docLiteral}::text[] IS NULL OR d.id = ANY(${docLiteral}::text[]))
            AND c.content % ${question}
          ORDER BY similarity(c.content, ${question}) DESC
          LIMIT ${limit}
        `
      : await this.prisma.$queryRaw<RawRow[]>`
          SELECT COALESCE(parent_chunk.id, c.id) AS chunk_id,
                 COALESCE(parent_chunk.content, c.content) AS content,
                 COALESCE(parent_chunk.chunk_index, c.chunk_index) AS chunk_index,
                 d.id AS document_id, d.filename,
                 similarity(c.content, ${question}) AS similarity
          FROM chunks c
          JOIN documents d ON d.id = c.document_id
          LEFT JOIN chunks parent_chunk ON parent_chunk.id = c.parent_id
          JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
          WHERE c.embedding IS NOT NULL
            AND kb.owner_id = ${userId}
            AND (${docLiteral}::text[] IS NULL OR d.id = ANY(${docLiteral}::text[]))
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

  /**
   * C 符号命中：问题里点名了已知符号（函数/类/组件/变量名）→ 直接返回该符号实现源码。
   * 比语义检索精准：不看"像不像"，只看"问题里是否出现库里的符号名"（标识符精确匹配）。
   * 命中结果 similarity 置 null（非语义分数），调用方作为高置信来源优先采用。
   * 中文/无标识符问题返回空（fallback 语义检索）。
   *
   * 噪音过滤（评测发现的劫持）：
   * - 全大写缩写（OCR/API/SSE…）：问"支持 OCR 吗"是问能力边界，不是点名符号，排除；
   * - 通用英文词（token/user/error…）：太泛，任何库都可能有同名符号，
   *   会让"登录鉴权怎么拿到 token"被一个叫 token 的变量符号劫持，跳过真正的语义检索。
   */
  private static readonly SYMBOL_STOPWORDS = new Set([
    'token',
    'user',
    'users',
    'error',
    'data',
    'file',
    'files',
    'type',
    'types',
    'name',
    'date',
    'time',
    'key',
    'keys',
    'id',
    'api',
    'url',
    'body',
    'params',
    'string',
    'number',
    'boolean',
    'object',
    'array',
    'value',
    'status',
    'code',
    'message',
    'model',
    'config',
    'login',
    'logout',
    'register',
    'avatar',
    'theme',
  ]);

  /** 是否值得当符号名查：排除全大写缩写（OCR/SSE/API）与通用停用词 */
  private static isSymbolToken(tok: string): boolean {
    if (tok === tok.toUpperCase()) return false; // 全大写 = 缩写/常量，非函数名
    return !RagService.SYMBOL_STOPWORDS.has(tok.toLowerCase());
  }

  async symbolLookup(
    userId: string,
    question: string,
    kbIds?: string[],
  ): Promise<RetrievalSource[]> {
    // 提取问题里的标识符（camelCase/snake 等符号名），排除 3 字符以下 + 噪音词
    const tokens =
      question.match(/[A-Za-z_$][\w$]{2,}/g)?.filter((t) => RagService.isSymbolToken(t)) ?? [];
    if (tokens.length === 0) return [];
    const hits = await this.prisma.codeSymbol.findMany({
      where: {
        symbolName: { in: tokens },
        document: {
          knowledgeBase: {
            ownerId: userId,
            ...(kbIds && kbIds.length ? { id: { in: kbIds } } : {}),
          },
        },
      },
      select: {
        documentId: true,
        filename: true,
        symbolName: true,
        kind: true,
        body: true,
        signature: true,
        startLine: true,
      },
      take: 10,
    });
    if (hits.length === 0) {
      // 符号表没命中（索引缺漏/上传不完整/命名变体）→ 字面量兜底：
      // 直接在片段原文里找该标识符——定义处与调用处都含此词，能答"XX 在哪被调用/定义"
      return this.literalLookup(userId, tokens, kbIds, 6);
    }
    return hits.map((h) => ({
      chunkId: `${h.documentId}:${h.symbolName}`,
      // 实现源码优先；解析不到 body（如 interface）退签名
      content: h.body || h.signature,
      chunkIndex: h.startLine - 1,
      documentId: h.documentId,
      filename: h.filename,
      similarity: null,
    }));
  }

  /**
   * 字面量兜底检索：按标识符在片段原文做子串匹配（ILIKE，命中 pg_trgm GIN 索引）。
   * 用于符号表未命中时（索引缺漏/命名变体/部分上传），把"定义处/调用处"片段直接捞回来。
   * 只接受长度 ≥ 5 的标识符，避免 api/token 这类短通用词造成海量噪音。
   */
  private async literalLookup(
    userId: string,
    tokens: string[],
    kbIds: string[] | undefined,
    limit: number,
  ): Promise<RetrievalSource[]> {
    const candidates = tokens.filter((t) => t.length >= 5);
    const sources: RetrievalSource[] = [];
    const seen = new Set<string>();
    let kbLiteral: string | null = null;
    if (kbIds?.length) {
      const owned = await this.prisma.knowledgeBase.findMany({
        where: { id: { in: kbIds }, ownerId: userId },
        select: { id: true },
      });
      if (owned.length === new Set(kbIds).size) {
        kbLiteral = `{${owned.map((k) => `"${k.id}"`).join(',')}}`;
      }
    }
    for (const token of candidates) {
      if (sources.length >= limit) break;
      const rows = await this.prisma.$queryRaw<
        Array<{
          chunk_id: string;
          content: string;
          chunk_index: number;
          document_id: string;
          filename: string;
        }>
      >`
        SELECT COALESCE(parent_chunk.id, c.id) AS chunk_id,
               COALESCE(parent_chunk.content, c.content) AS content,
               COALESCE(parent_chunk.chunk_index, c.chunk_index) AS chunk_index,
               d.id AS document_id, d.filename
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        LEFT JOIN chunks parent_chunk ON parent_chunk.id = c.parent_id
        JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
        WHERE c.embedding IS NOT NULL
          AND kb.owner_id = ${userId}
          AND (${kbLiteral}::text[] IS NULL OR d.knowledge_base_id = ANY(${kbLiteral}::text[]))
          AND c.content ILIKE ${'%' + token + '%'}
        ORDER BY (c.content ILIKE ${'%' + token + '(%'}) DESC, d.filename, c.chunk_index
        LIMIT ${limit}
      `;
      for (const r of rows) {
        if (sources.length >= limit) break;
        if (seen.has(r.chunk_id)) continue;
        seen.add(r.chunk_id);
        sources.push({
          chunkId: r.chunk_id,
          content: r.content,
          chunkIndex: r.chunk_index,
          documentId: r.document_id,
          filename: r.filename,
          similarity: null,
        });
      }
      if (rows.length > 0) {
        this.logger.log(`字面量兜底命中符号 ${token}：${rows.length} 个片段`);
      }
    }
    return sources;
  }

  /**
   * 业务关键词 → 模块文件路径片段映射。
   * 代码文件档案是"符号清单+头注释"，对中文业务问题（登录/上传/报告怎么实现）
   * 语义匹配不稳（auth.service.ts 无中文头注释就匹配不上"登录"）。
   * 这是确定性补充：问题含业务词时，直接按文件名/路径召回对应模块的真实代码文件。
   */
  private static readonly MODULE_KEYWORDS: Array<{
    words: string[];
    pathPart: string;
  }> = [
    {
      words: ['登录', '注册', '鉴权', '认证', 'token', '密码', '登录态', 'auth'],
      pathPart: 'modules/auth',
    },
    {
      words: ['上传', '文件', '文档', '解析', '分块', '向量', '入库', 'knowledge'],
      pathPart: 'modules/knowledge',
    },
    {
      words: ['ocr', '扫描', '识别图片', '图片文字', '文字识别'],
      pathPart: 'modules/knowledge/utils/document-parser',
    },
    { words: ['报告', '研究报告', '生成报告'], pathPart: 'modules/research' },
    {
      words: ['研究任务', 'agent', '自主研究', '方向', '预算'],
      pathPart: 'modules/research-agent',
    },
    { words: ['会话', '聊天', '消息', '对话', '提问'], pathPart: 'modules/chat' },
    { words: ['头像', '资料', '用户', '个人'], pathPart: 'modules/user' },
    { words: ['模型配置', '模型', 'key', '密钥', 'byo'], pathPart: 'modules/models' },
  ];

  /**
   * 按业务关键词补召模块代码文件（确定性路径匹配，兜档案语义召回之不足）。
   * 只召回"模块内主实现"：优先 *service.ts / *controller.ts（业务逻辑所在），
   * 排除 spec/test（测试文件）、dto（纯类型），避免拉进无关文件。
   */
  async profileLookupByKeyword(
    userId: string,
    query: string,
    kbIds: string[] | undefined,
    limit = 4,
  ): Promise<Array<{ documentId: string; filename: string }>> {
    const lower = query.toLowerCase();
    const matched = RagService.MODULE_KEYWORDS.find((m) => m.words.some((w) => lower.includes(w)));
    if (!matched) return [];
    const rows = await this.prisma.document.findMany({
      where: {
        ...(kbIds && kbIds.length ? { knowledgeBaseId: { in: kbIds } } : {}),
        filename: { contains: matched.pathPart },
        fileType: 'code',
        status: 'done',
        NOT: {
          OR: [
            { filename: { contains: '.spec.' } },
            { filename: { contains: '/dto/' } },
            { filename: { contains: '.dto.' } },
          ],
        },
      },
      select: { id: true, filename: true },
      take: 10, // 多取再排序，保证 service/controller 优先
    });
    // 业务逻辑优先：service > controller > 其他（按文件名子串打分）
    const score = (fn: string): number => {
      if (/\.service\./.test(fn)) return 0;
      if (/\.controller\./.test(fn)) return 1;
      return 2;
    };
    return rows
      .sort((a, b) => score(a.filename) - score(b.filename))
      .slice(0, limit)
      .map((r) => ({ documentId: r.id, filename: r.filename }));
  }

  /**
   * A 档案命中：用问题向量检索"文件档案"（文件名 + 章节地图/符号清单），
   * 锁定最相关的文档——中文泛化问题（"设置头像的代码"）也能先定位到 Settings.vue，
   * 再交给 retrieve 在锁定的文档内检索（解决全库几万片段抢 topK 的问题）。
   */
  async profileLookup(
    userId: string,
    question: string,
    kbIds?: string[],
    topDocs = 3,
  ): Promise<Array<{ documentId: string; filename: string }>> {
    const [vec] = await this.embeddingService.embedTexts([question]);
    const vecStr = `[${vec.join(',')}]`;
    const kbLiteral = kbIds?.length ? `{${kbIds.map((id) => `"${id}"`).join(',')}}` : null;
    const rows = await this.prisma.$queryRaw<Array<{ document_id: string; filename: string }>>`
      SELECT p.document_id, d.filename
      FROM file_profiles p
      JOIN documents d ON d.id = p.document_id
      JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
      WHERE p.embedding IS NOT NULL
        AND kb.owner_id = ${userId}
        AND (${kbLiteral}::text[] IS NULL OR kb.id = ANY(${kbLiteral}::text[]))
      ORDER BY p.embedding <=> ${vecStr}::vector
      LIMIT ${topDocs}
    `;
    return rows.map((r) => ({ documentId: r.document_id, filename: r.filename }));
  }

  /**
   * A+C 联动：档案命中文档后，拉取这些文档的真实符号实现（函数/类 body）。
   * 中文问"设置头像的代码"时，仅靠文件内语义片段可能漏掉 script 实现区（被模板区抢 topK），
   * 直接把该文件的符号实现注入，让模型基于真实源码回答（想编都编不了）。
   * 优先取 function/component（实现类），超长 body 截断控制 token。
   */
  async symbolsForDocs(userId: string, docIds: string[], limit = 8): Promise<RetrievalSource[]> {
    if (docIds.length === 0) return [];
    // 归属校验：文档必须属于该用户（防越权拉取他人文件符号）
    const owned = await this.prisma.document.findMany({
      where: { id: { in: docIds }, knowledgeBase: { ownerId: userId } },
      select: { id: true },
    });
    if (owned.length === 0) return [];
    const ids = owned.map((d) => d.id);
    const docLiteral = `{${ids.map((id) => `"${id}"`).join(',')}}`;
    const rows = await this.prisma.$queryRaw<
      Array<{
        document_id: string;
        filename: string;
        symbol_name: string;
        kind: string;
        body: string;
        start_line: number;
      }>
    >`
      SELECT s.document_id, s.filename, s.symbol_name, s.kind, s.body, s.start_line
      FROM code_symbols s
      WHERE s.document_id = ANY(${docLiteral}::text[])
        AND s.body <> ''
      ORDER BY
        CASE s.kind WHEN 'function' THEN 0 WHEN 'component' THEN 1 WHEN 'class' THEN 2 ELSE 3 END,
        s.start_line ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      chunkId: `${r.document_id}:${r.symbol_name}`,
      content: r.body.slice(0, 2000), // 防超长函数撑爆上下文
      chunkIndex: r.start_line - 1,
      documentId: r.document_id,
      filename: r.filename,
      similarity: null,
    }));
  }

  /**
   * 按文件名取单文档全文（"解析 HomeCosmos.vue"类问题）：
   * filename 以给定名字结尾匹配（容忍 "主项目/apps/.../HomeCosmos.vue" 前缀），
   * 经 knowledgeBase.ownerId 归属校验防越权。
   */
  async loadDocumentByNameFulltext(
    userId: string,
    filename: string,
    kbIds: string[] | undefined,
    maxChars: number,
  ): Promise<{ sources: RetrievalSource[]; totalChars: number }> {
    const found = await this.prisma.document.findFirst({
      where: {
        // 大小写不敏感匹配：库里存的是原始大小写（HomeCosmos.vue），
        // toLowerCase 后 endsWith 在 PG 里大小写敏感 → 匹配失败（线上 bug）
        filename: { endsWith: filename, mode: 'insensitive' },
        ...(kbIds && kbIds.length ? { knowledgeBaseId: { in: kbIds } } : {}),
      },
      select: {
        id: true,
        knowledgeBase: { select: { ownerId: true } },
      },
    });
    if (!found || found.knowledgeBase.ownerId !== userId) {
      return { sources: [], totalChars: 0 };
    }
    return this.loadDocumentFulltext(userId, found.id, maxChars);
  }

  /**
   * 单文档全文模式：解析/逐行讲解单个代码文件时，直接取该文件全部叶子块拼成全文。
   * 检索只给 topK 片段必然覆盖不全（大文件后半段永远进不来）；
   * 单文件通常 ≤ 阈值（HomeCosmos.vue 22k 字符），全文喂模型才能"逐行解析到底"。
   * 返回 totalChars 供调用方判断是否超限（超限则退回检索模式）。
   */
  async loadDocumentFulltext(
    userId: string,
    documentId: string,
    maxChars: number,
  ): Promise<{ sources: RetrievalSource[]; totalChars: number }> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, knowledgeBase: { ownerId: userId } },
      select: { id: true },
    });
    if (!doc) return { sources: [], totalChars: 0 };
    const rows = await this.prisma.$queryRaw<
      Array<{ document_id: string; filename: string; content: string; chunk_index: number }>
    >`
      SELECT d.id AS document_id, d.filename, c.content, c.chunk_index
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.document_id = ${doc.id}
        AND c.parent_id IS NULL
      ORDER BY c.chunk_index
    `;
    const agg = aggregateFulltext(rows);
    if (agg.totalChars > maxChars) {
      return { sources: [], totalChars: agg.totalChars };
    }
    return agg;
  }

  /**
   * P0 全文模式：把绑定知识库的全部文本按文档分组取回（不走检索）。
   * 用于"需要看完整文档"的任务（逐行解析、全文总结、代码讲解）——检索只给片段，
   * 模型看不到全文必然答不全；文档总量小于阈值时全文喂模型更完整。
   * 调用方依据 totalChars 判断：超过阈值 → 放弃全文走检索模式。
   */
  async loadFulltext(
    userId: string,
    kbIds: string[],
    maxChars: number,
  ): Promise<{ sources: RetrievalSource[]; totalChars: number }> {
    const owned = await this.prisma.knowledgeBase.findMany({
      where: { id: { in: kbIds }, ownerId: userId },
      select: { id: true },
    });
    if (owned.length !== new Set(kbIds).size) {
      throw new NotFoundException('知识库不存在');
    }
    const kbLiteral = `{${owned.map((k) => `"${k.id}"`).join(',')}}`;
    // 先算总量：超过阈值直接返回空（调用方走检索），避免白拉全量文本
    const [agg] = await this.prisma.$queryRaw<Array<{ total: number }>>`
      SELECT COALESCE(SUM(LENGTH(c.content)), 0)::int AS total
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.knowledge_base_id = ANY(${kbLiteral}::text[])
        AND c.parent_id IS NULL
    `;
    const totalChars = Number(agg?.total ?? 0);
    if (totalChars > maxChars) {
      return { sources: [], totalChars };
    }
    const rows = await this.prisma.$queryRaw<
      Array<{ document_id: string; filename: string; content: string; chunk_index: number }>
    >`
      SELECT d.id AS document_id, d.filename, c.content, c.chunk_index
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.knowledge_base_id = ANY(${kbLiteral}::text[])
        AND c.parent_id IS NULL
      ORDER BY d.id, c.chunk_index
    `;
    return aggregateFulltext(rows);
  }
}

/**
 * 把 (文档, 片段) 行按文档聚合成"每文档一条全文"（纯函数，便于单测）。
 * chunkIndex 置 -1、similarity 置 null 标记"全文块"（buildPrompt 据此显示"全文"而非"第 N 段"）。
 */
export function aggregateFulltext(
  rows: Array<{ document_id: string; filename: string; content: string; chunk_index: number }>,
): { sources: RetrievalSource[]; totalChars: number } {
  const byDoc = new Map<
    string,
    { filename: string; parts: Array<{ content: string; index: number }> }
  >();
  for (const r of rows) {
    const doc = byDoc.get(r.document_id) ?? { filename: r.filename, parts: [] };
    doc.parts.push({ content: r.content, index: r.chunk_index });
    byDoc.set(r.document_id, doc);
  }
  let totalChars = 0;
  const sources: RetrievalSource[] = [];
  for (const [docId, doc] of byDoc) {
    const content = doc.parts
      .sort((a, b) => a.index - b.index)
      .map((p) => p.content)
      .join('\n');
    totalChars += content.length;
    sources.push({
      chunkId: docId,
      content,
      chunkIndex: -1,
      documentId: docId,
      filename: doc.filename,
      similarity: null,
    });
  }
  return { sources, totalChars };
}
