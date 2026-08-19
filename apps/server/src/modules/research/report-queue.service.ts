import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { ReportProcessor, ReportJobData } from './report-processor.service';

const QUEUE_NAME = 'report-generate';

/**
 * 研究报告任务队列（BullMQ + Redis）：
 * 创建接口立即返回 pending，worker 后台执行"拆解→检索→撰写→汇总"，
 * 前端轮询 status/step 展示进度。单并发（每份报告很重），失败自动重试一次。
 */
@Injectable()
export class ReportQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReportQueueService.name);
  private queue!: Queue;
  private worker!: Worker;

  constructor(
    private configService: ConfigService,
    private processor: ReportProcessor,
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
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        await this.processor.processReport(job.data as ReportJobData);
      },
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('completed', (job) => this.logger.log(`研究报告任务完成: ${job.id}`));
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`研究报告任务失败(重试后将再次执行): ${job?.id} → ${err.message}`),
    );
    this.logger.log('研究报告队列已启动（BullMQ + Redis）');
  }

  /** 提交报告生成任务（立即返回，不等待生成结果） */
  async addReportJob(data: ReportJobData): Promise<void> {
    await this.queue.add('generate', data, {
      attempts: 2, // 瞬时网络错误自动重试一次（整份报告重跑）
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: true,
      removeOnFail: 50,
    });
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
  }
}
