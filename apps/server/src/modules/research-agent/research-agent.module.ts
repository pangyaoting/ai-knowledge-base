import { Module } from '@nestjs/common';
import { ResearchAgentController } from './research-agent.controller';
import { AgentTaskService } from './agent-task.service';
import { AgentRunner } from './agent-runner.service';
import { AgentQueueService } from './agent-queue.service';
import { ChatModule } from '../chat/chat.module'; // 复用 WebSearchService（联网搜索 + 正文提取）
import { ModelsModule } from '../models/models.module'; // 解析用户默认模型配置（BYO key）

@Module({
  imports: [ChatModule, ModelsModule],
  controllers: [ResearchAgentController],
  providers: [AgentTaskService, AgentRunner, AgentQueueService],
})
export class ResearchAgentModule {}
