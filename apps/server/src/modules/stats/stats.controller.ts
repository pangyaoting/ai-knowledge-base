import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { StatsService, type StatsRange } from './stats.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('数据看板')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get('overview')
  @ApiQuery({
    name: 'range',
    required: false,
    enum: ['7', '30', 'all'],
    description: '时间范围：7=近7天（默认）/ 30=近30天 / all=全部（按月分桶）',
  })
  @ApiOperation({ summary: '数据看板总览（KPI/资产/健康度/趋势/模型归因/研究/记忆）' })
  overview(@CurrentUser('id') userId: string, @Query('range') range?: string) {
    const r: StatsRange = range === '30' || range === 'all' ? range : '7';
    return this.statsService.overview(userId, r);
  }
}
