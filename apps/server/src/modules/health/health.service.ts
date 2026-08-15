import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

@Injectable()
export class HealthService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }

  async checkDatabase() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', message: '数据库连接正常' };
    } catch (e) {
      return { status: 'error', message: (e as Error).message };
    }
  }

  async checkRedis() {
    try {
      const pong = await this.redis.ping();
      return { status: 'ok', message: `Redis 连接正常: ${pong}` };
    } catch (e) {
      return { status: 'error', message: (e as Error).message };
    }
  }
}
