import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(private configService: ConfigService) {
    super({
      host: configService.get<string>('REDIS_HOST', 'localhost'),
      port: configService.get<number>('REDIS_PORT', 6379),
      password: configService.get<string>('REDIS_PASSWORD') || undefined,
      // 断线自动重连
      retryStrategy: (times) => Math.min(times * 500, 5000),
      maxRetriesPerRequest: 3,
    });

    this.on('connect', () => this.logger.log('Redis 连接成功'));
    this.on('error', (err) => this.logger.error(`Redis 连接失败: ${err.message}`));
  }

  async onModuleDestroy() {
    await this.quit();
  }
}
