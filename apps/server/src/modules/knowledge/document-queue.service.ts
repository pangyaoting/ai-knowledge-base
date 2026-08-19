import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { DocumentProcessor, DocumentJobData } from './document-processor.service';

const QUEUE_NAME = 'document-process';

/**
 * 文档处理任务队列（BullMQ + Redis）：
 * 上传接口只负责"校验 + 存盘 + 建记录 + 入队"并立即返回，
 * 解析/分块/向量化由 worker 后台执行——大文件不再卡住 HTTP 请求。
 * 失败自动重试（指数退避），任务在 Redis 里持久化。
 */
@Injectable()
export class DocumentQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DocumentQueueService.name);
  private queue!: Queue;
  private worker!: Worker;

  constructor(
    private configService: ConfigService,
    private processor: DocumentProcessor,
  ) {}

  private get connection() {
    return {
      host: this.configService.get<string>('REDIS_HOST', 'localhost'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
      password: this.configService.get<string>('REDIS_PASSWORD') || undefined,
      maxRetriesPerRequest: null, // BullMQ 必需：等待期间不限制重试
      // 显式重连策略：Redis 重启（如 WSL 冷启动后 docker 恢复）时 worker 才能可靠恢复消费
      retryStrategy: (times: number) => Math.min(times * 500, 5000),
    };
  }

  onApplicationBootstrap() {
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
    // concurrency 2：两个任务并行处理（embedding 是外部 API，并行能显著提速）
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        await this.processor.processDocument(job.data as DocumentJobData);
      },
      { connection: this.connection, concurrency: 2 },
    );
    this.worker.on('completed', (job) => this.logger.log(`任务完成: ${job.id}`));
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`任务失败(重试后将再次执行): ${job?.id} → ${err.message}`),
    );
    this.logger.log('文档处理队列已启动（BullMQ + Redis）');
  }

  /** 提交文档处理任务（立即返回，不等待处理结果） */
  async addDocumentJob(data: DocumentJobData): Promise<void> {
    await this.queue.add('process', data, {
      attempts: 3, // 失败自动重试（如 embedding 临时网络错误）
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
  }
}
