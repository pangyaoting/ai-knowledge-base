import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReportService } from './report.service';
import { CreateReportDto } from './dto/create-report.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('研究报告')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('research')
export class ResearchController {
  constructor(private readonly reportService: ReportService) {}

  @Post('reports')
  @ApiOperation({ summary: '创建研究报告任务（异步生成，返回 pending）' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateReportDto) {
    return this.reportService.create(userId, dto);
  }

  @Get('reports')
  @ApiOperation({ summary: '我的研究报告列表' })
  list(@CurrentUser('id') userId: string) {
    return this.reportService.list(userId);
  }

  @Get('reports/:id')
  @ApiOperation({ summary: '报告详情（轮询生成进度用）' })
  findOne(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.reportService.findOne(userId, id);
  }

  @Delete('reports/:id')
  @ApiOperation({ summary: '删除报告' })
  remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.reportService.remove(userId, id);
  }
}
