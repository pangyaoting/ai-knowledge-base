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
import { AgentTaskService } from './agent-task.service';
import { CreateAgentTaskDto } from './dto/create-agent-task.dto';
import { ExtendAgentTaskDto } from './dto/extend-agent-task.dto';
import { ConfirmAgentTaskDto } from './dto/confirm-agent-task.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('自主研究 Agent')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('research-agent')
export class ResearchAgentController {
  constructor(private readonly agentTaskService: AgentTaskService) {}

  @Post('tasks')
  @ApiOperation({ summary: '创建自主研究任务（异步执行，返回 pending）' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateAgentTaskDto) {
    return this.agentTaskService.create(userId, dto);
  }

  @Get('tasks')
  @ApiOperation({ summary: '我的自主研究任务列表' })
  list(@CurrentUser('id') userId: string) {
    return this.agentTaskService.list(userId);
  }

  @Get('tasks/:id')
  @ApiOperation({ summary: '任务详情（轮询研究进度用）' })
  findOne(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.agentTaskService.findOne(userId, id);
  }

  @Post('tasks/:id/stop')
  @ApiOperation({ summary: '手动停止（保留阶段成果，可续时/加预算后继续）' })
  stop(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.agentTaskService.stop(userId, id);
  }

  @Post('tasks/:id/confirm')
  @ApiOperation({ summary: '确认方向并开始研究（仅限待确认任务，可选选中方向下标）' })
  confirm(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmAgentTaskDto,
  ) {
    return this.agentTaskService.confirm(userId, id, dto);
  }

  @Post('tasks/:id/redecompose')
  @ApiOperation({ summary: '重新拆解方向（仅限待确认任务，重新消耗一次拆解 token）' })
  redecompose(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.agentTaskService.redecompose(userId, id);
  }

  @Patch('tasks/:id/extend')
  @ApiOperation({ summary: '续时/加预算（仅限已停止任务，从断点续跑）' })
  extend(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExtendAgentTaskDto,
  ) {
    return this.agentTaskService.extend(userId, id, dto);
  }

  @Delete('tasks/:id')
  @ApiOperation({ summary: '删除任务' })
  remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.agentTaskService.remove(userId, id);
  }
}
