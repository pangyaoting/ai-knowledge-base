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
import { GraphService } from './graph.service';
import { GraphController } from './graph.controller';

@Module({
  controllers: [KnowledgeController, DocumentsController, DemoController, GraphController],
  providers: [
    KnowledgeService,
    DocumentsService,
    EmbeddingService,
    DocumentProcessor,
    DocumentQueueService,
    RerankService,
    DemoService,
    GraphService,
  ],
  exports: [KnowledgeService, EmbeddingService, RerankService, GraphService], // RagService/报告/聊天多跳扩展注入
})
export class KnowledgeModule {}
