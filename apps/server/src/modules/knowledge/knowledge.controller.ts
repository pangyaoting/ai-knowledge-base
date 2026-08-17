import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { KnowledgeService } from './knowledge.service';
import { CreateKnowledgeDto } from './dto/create-knowledge.dto';
import { UpdateKnowledgeDto } from './dto/update-knowledge.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('知识库')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Post()
  @ApiOperation({ summary: '创建知识库' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateKnowledgeDto) {
    return this.knowledgeService.create(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: '我的知识库列表' })
  findAll(@CurrentUser('id') userId: string) {
    return this.knowledgeService.findAll(userId);
  }

  @Get(':id')
  @ApiOperation({ summary: '知识库详情' })
  findOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.knowledgeService.findOne(userId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新知识库' })
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateKnowledgeDto,
  ) {
    return this.knowledgeService.update(userId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除知识库（级联删除其下文档）' })
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.knowledgeService.remove(userId, id);
  }
}
