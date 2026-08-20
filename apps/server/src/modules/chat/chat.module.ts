import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { RagService } from './rag.service';
import { WebSearchService } from './web-search.service';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ModelsModule } from '../models/models.module'; // 解析会话绑定的模型配置（BYO key）

@Module({
  imports: [KnowledgeModule, ModelsModule], // RagService 依赖 KnowledgeService（校验知识库归属）
  controllers: [ChatController],
  providers: [ChatService, RagService, WebSearchService],
  exports: [RagService, WebSearchService], // 研究报告模块复用混合检索；自主研究 Agent 复用联网搜索/正文提取
})
export class ChatModule {}
