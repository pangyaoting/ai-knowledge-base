import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  controllers: [KnowledgeController, DocumentsController],
  providers: [KnowledgeService, DocumentsService],
})
export class KnowledgeModule {}
