import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

const EMBEDDING_MODEL = 'BAAI/bge-m3'; // 硅基流动，中文顶尖，1024 维
const BATCH_SIZE = 10; // 每批 10 个文本（bge-m3 支持批量，减少请求次数）
const MAX_RETRIES = 3; // 指数退避重试上限
const BATCH_DELAY_MS = 300; // 批次间延时，防止触发免费额度 QPS 限制

/**
 * Embedding 向量化服务
 * 通过 OpenAI 兼容协议调用硅基流动（SiliconFlow）的 BGE-M3 模型
 *
 * 面试点：
 * - 批量：100 个 chunk 只调 10 次 API（每批 10 个），而不是 100 次
 * - 指数退避：失败后 500ms → 1s → 2s 重试，最多 3 次
 * - 限速：批次间固定延时，避免触发免费额度 QPS 上限
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private client: OpenAI;

  constructor(private configService: ConfigService) {
    this.client = new OpenAI({
      apiKey: this.configService.get<string>('SILICONFLOW_API_KEY'),
      baseURL: this.configService.get<string>('SILICONFLOW_BASE_URL'),
    });
  }

  /** 批量向量化：文本数组 → 向量数组（顺序一致） */
  async embedTexts(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      results.push(...(await this.embedBatch(batch)));
      // 批次间限速（最后一组不用等）
      if (i + BATCH_SIZE < texts.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }
    return results;
  }

  /** 单个批次向量化，带指数退避重试 */
  private async embedBatch(batch: string[]): Promise<number[][]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await this.client.embeddings.create({
          model: EMBEDDING_MODEL,
          input: batch,
        });
        // 返回顺序与输入一致（按 index 排序，保险起见）
        return resp.data
          .sort((a, b) => a.index - b.index)
          .map((item) => item.embedding);
      } catch (err) {
        lastError = err;
        const delay = 500 * 2 ** (attempt - 1); // 500ms, 1s, 2s
        this.logger.warn(
          `Embedding 批次请求失败(第 ${attempt}/${MAX_RETRIES} 次): ${(err as Error).message}，${delay}ms 后重试`,
        );
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Embedding 请求失败');
  }
}
