import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 重排序服务（两阶段检索的"精排"环节）：
 * 用交叉编码器 bge-reranker 对召回片段逐条与问题算相关性分，
 * 比向量/关键词的"粗召回"更准（它同时看问题和片段全文）。
 * 不可用/失败时返回 null，调用方回退为 RRF 结果——重排是增强不是依赖。
 */
@Injectable()
export class RerankService {
  private readonly logger = new Logger(RerankService.name);

  constructor(private configService: ConfigService) {}

  private get baseUrl(): string {
    return this.configService.get<string>('SILICONFLOW_BASE_URL', 'https://api.siliconflow.cn/v1');
  }

  private get apiKey(): string | undefined {
    return this.configService.get<string>('SILICONFLOW_API_KEY');
  }

  private get model(): string {
    return this.configService.get<string>('SILICONFLOW_RERANK_MODEL', 'BAAI/bge-reranker-v2-m3');
  }

  /** 是否配置了重排（没配 key/模型则整个重排环节跳过） */
  get enabled(): boolean {
    return !!this.apiKey && !!this.model;
  }

  /**
   * 对候选片段重排：返回按相关性降序的 { index, score } 列表；任何异常返回 null
   * score 是交叉编码器的相关性分（实测 bge-reranker-v2-m3：相关≈0.9+，无关≈0.00x），
   * 调用方用分数做"相关性门控"，把噪声片段拦在回答之外。
   * @param documents 候选片段内容（与来源数组一一对应）
   * @param topN 要返回的最相关条数
   */
  async rerank(
    query: string,
    documents: string[],
    topN: number,
  ): Promise<Array<{ index: number; score: number }> | null> {
    if (!this.enabled || documents.length === 0) {
      return null;
    }
    try {
      const res = await fetch(`${this.baseUrl}/rerank`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          query,
          documents,
          top_n: topN,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        this.logger.warn(`重排接口返回 ${res.status}`);
        return null;
      }
      const data = (await res.json()) as {
        results?: Array<{ index: number; relevance_score: number }>;
      };
      const results = (data.results ?? []).sort((a, b) => b.relevance_score - a.relevance_score);
      return results.map((r) => ({ index: r.index, score: r.relevance_score }));
    } catch (err) {
      this.logger.warn(`重排失败，回退 RRF: ${(err as Error).message}`);
      return null;
    }
  }
}
