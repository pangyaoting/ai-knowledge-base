import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ModelConfigService } from './model-config.service';
import { CreateModelConfigDto } from './dto/create-model-config.dto';
import { UpdateModelConfigDto } from './dto/update-model-config.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('模型配置')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('model-configs')
export class ModelConfigController {
  constructor(private readonly modelConfigService: ModelConfigService) {}

  @Post()
  @ApiOperation({ summary: '新增模型配置（API Key 加密存储）' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateModelConfigDto) {
    return this.modelConfigService.create(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: '我的模型配置列表（key 只返回掩码）' })
  list(@CurrentUser('id') userId: string) {
    return this.modelConfigService.list(userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新模型配置（不传 apiKey 则保留原 key）' })
  update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateModelConfigDto,
  ) {
    return this.modelConfigService.update(userId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除模型配置' })
  remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.modelConfigService.remove(userId, id);
  }

  @Post(':id/test')
  @ApiOperation({ summary: '测试连接（最小补全请求验证 key 可用）' })
  test(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.modelConfigService.test(userId, id);
  }
}
