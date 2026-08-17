import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { EmbeddingService } from './embedding.service';

@Module({
  controllers: [KnowledgeController, DocumentsController],
  providers: [KnowledgeService, DocumentsService, EmbeddingService],
  exports: [KnowledgeService, EmbeddingService], // 供 ChatModule 的 RagService 注入
})
export class KnowledgeModule {}
