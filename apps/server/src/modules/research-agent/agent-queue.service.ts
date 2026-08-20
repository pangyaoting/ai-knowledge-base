import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { AgentRunner, AgentJobData } from './agent-runner.service';

const QUEUE_NAME = 'agent-task';

/**
 * 自主研究 Agent 任务队列（BullMQ + Redis）：
 * 创建接口立即返回 pending，worker 后台执行"搜索→筛选→精读→提炼→成稿"，
 * 前端轮询 status/progress 展示实时进度。单并发（一个研究任务很重）。
 * 失败自动重试一次；重试时从 progress 断点续跑（不是从零开始）。
 */
@Injectable()
export class AgentQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AgentQueueService.name);
  private queue!: Queue;
  private worker!: Worker;

  constructor(
    private configService: ConfigService,
    private runner: AgentRunner,
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
        await this.runner.processTask(job.data as AgentJobData);
      },
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('completed', (job) => this.logger.log(`自主研究任务完成: ${job.id}`));
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`自主研究任务失败(重试后将再次执行): ${job?.id} → ${err.message}`),
    );
    this.logger.log('自主研究队列已启动（BullMQ + Redis）');
  }

  /** 提交自主研究任务；delayMs > 0 = 延迟到开始时间再执行 */
  async addAgentJob(data: AgentJobData, delayMs = 0): Promise<void> {
    await this.queue.add(
      'run',
      data,
      delayMs > 0
        ? {
            delay: delayMs,
            attempts: 2,
            backoff: { type: 'exponential', delay: 3000 },
            removeOnComplete: true,
            removeOnFail: 50,
          }
        : {
            attempts: 2,
            backoff: { type: 'exponential', delay: 3000 },
            removeOnComplete: true,
            removeOnFail: 50,
          },
    );
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
  }
}
