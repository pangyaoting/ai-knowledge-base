import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { EmbeddingService } from './embedding.service';
import { DocumentProcessor } from './document-processor.service';
import { DocumentQueueService } from './document-queue.service';
import { RerankService } from './rerank.service';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';

@Module({
  imports: [],
  controllers: [KnowledgeController, DocumentsController, DemoController],
  providers: [
    KnowledgeService,
    DocumentsService,
    EmbeddingService,
    DocumentProcessor,
    DocumentQueueService,
    RerankService,
    DemoService,
  ],
  exports: [KnowledgeService, EmbeddingService, RerankService], // RagService / 聊天检索注入
})
export class KnowledgeModule {}
