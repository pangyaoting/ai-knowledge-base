import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { RagService } from './rag.service';
import { KnowledgeModule } from '../knowledge/knowledge.module';

@Module({
  imports: [KnowledgeModule], // RagService 依赖 KnowledgeService（校验知识库归属）
  controllers: [ChatController],
  providers: [ChatService, RagService],
})
export class ChatModule {}
