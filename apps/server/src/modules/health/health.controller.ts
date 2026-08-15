import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthService } from './health.service';

@ApiTags('健康检查')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: '服务健康检查' })
  check() {
    return this.healthService.check();
  }

  @Get('db')
  @ApiOperation({ summary: '数据库连接检查' })
  async checkDb() {
    return this.healthService.checkDatabase();
  }

  @Get('redis')
  @ApiOperation({ summary: 'Redis 连接检查' })
  async checkRedis() {
    return this.healthService.checkRedis();
  }
}
