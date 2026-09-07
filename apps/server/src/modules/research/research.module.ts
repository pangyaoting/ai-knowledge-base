import { Module } from '@nestjs/common';
import { ResearchController } from './research.controller';
import { ReportService } from './report.service';
import { ReportProcessor } from './report-processor.service';
import { ReportQueueService } from './report-queue.service';
import { ChatModule } from '../chat/chat.module'; // 复用 RagService（研究报告按子问题检索知识库）
import { ModelsModule } from '../models/models.module'; // 按报告行快照解析模型配置（BYO key）

@Module({
  imports: [ChatModule, ModelsModule],
  controllers: [ResearchController],
  providers: [ReportService, ReportProcessor, ReportQueueService],
})
export class ResearchModule {}
