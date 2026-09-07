import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserMemoriesService } from './user-memories.service';
import { CreateUserMemoryDto } from './dto/create-user-memory.dto';

/**
 * 用户事实记忆（记忆模块 B）：跨会话档案的查看/手写/删除。
 * 自动抽取在回答后异步进行（MemoryFactService），这里提供人工管理入口。
 */
@ApiTags('用户记忆')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('user-memories')
export class UserMemoriesController {
  constructor(private readonly userMemoriesService: UserMemoriesService) {}

  @Get()
  @ApiOperation({ summary: '我的用户事实记忆列表（可按分类过滤）' })
  list(@CurrentUser('id') userId: string, @Query('category') category?: string) {
    return this.userMemoriesService.list(userId, category);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '手动添加一条用户事实记忆' })
  add(@CurrentUser('id') userId: string, @Body() dto: CreateUserMemoryDto) {
    return this.userMemoriesService.add(userId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除一条用户事实记忆' })
  remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.userMemoriesService.remove(userId, id);
  }
}
