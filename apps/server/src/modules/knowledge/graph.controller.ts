import { Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GraphService } from './graph.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('知识图谱')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('knowledge')
export class GraphController {
  constructor(private readonly graphService: GraphService) {}

  @Get(':id/graph')
  @ApiOperation({ summary: '知识库图谱（节点 + 边，聚合后供可视化）' })
  getGraph(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) knowledgeBaseId: string) {
    return this.graphService.getGraph(knowledgeBaseId, userId);
  }

  @Get(':id/graph/entity-chunks')
  @ApiOperation({ summary: '某实体的原文片段（节点详情面板）' })
  getEntityChunks(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) knowledgeBaseId: string,
    @Query('name') name: string,
  ) {
    return this.graphService.getEntityChunks(knowledgeBaseId, userId, name);
  }

  @Post(':id/graph/rebuild')
  @ApiOperation({ summary: '重建知识库图谱（对全部已完成文档重新抽取，异步）' })
  rebuild(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) knowledgeBaseId: string) {
    return this.graphService.rebuild(knowledgeBaseId, userId);
  }
}
