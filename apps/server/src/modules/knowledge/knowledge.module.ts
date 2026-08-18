import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { EmbeddingService } from './embedding.service';
import { DocumentProcessor } from './document-processor.service';
import { DocumentQueueService } from './document-queue.service';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';

@Module({
  controllers: [KnowledgeController, DocumentsController, DemoController],
  providers: [
    KnowledgeService,
    DocumentsService,
    EmbeddingService,
    DocumentProcessor,
    DocumentQueueService,
    DemoService,
  ],
  exports: [KnowledgeService, EmbeddingService], // 供 ChatModule 的 RagService 注入
})
export class KnowledgeModule {}
