import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DemoService } from './demo.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('示例数据')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('demo')
export class DemoController {
  constructor(private readonly demoService: DemoService) {}

  @Post('seed')
  @ApiOperation({ summary: '一键导入示例知识库（含示例文档，幂等）' })
  seed(@CurrentUser('id') userId: string) {
    return this.demoService.seed(userId);
  }
}
