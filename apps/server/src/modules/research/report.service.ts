import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReportQueueService } from './report-queue.service';
import { CreateReportDto } from './dto/create-report.dto';

/**
 * 研究报告服务：创建（校验主题/知识库归属 → 建 pending → 入队）、列表、详情、删除。
 * 生成逻辑在 ReportProcessor（队列 worker 后台执行）。
 */
@Injectable()
export class ReportService {
  constructor(
    private prisma: PrismaService,
    private queueService: ReportQueueService,
  ) {}

  /** 创建研究报告任务（立即返回 pending） */
  async create(userId: string, dto: CreateReportDto) {
    const kbIds = dto.knowledgeBaseIds?.length ? dto.knowledgeBaseIds : undefined;
    // 归属校验：绑定的知识库必须都属于当前用户
    if (kbIds) {
      const owned = await this.prisma.knowledgeBase.findMany({
        where: { id: { in: kbIds }, ownerId: userId },
        select: { id: true },
      });
      if (owned.length !== new Set(kbIds).size) {
        throw new NotFoundException('知识库不存在');
      }
    }
    const report = await this.prisma.report.create({
      data: { ownerId: userId, topic: dto.topic.trim() },
    });
    await this.queueService.addReportJob({ userId, reportId: report.id });
    return report;
  }

  /** 我的研究报告列表（倒序） */
  list(userId: string) {
    return this.prisma.report.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 单份报告（轮询进度用；归属校验，他人 404） */
  async findOne(userId: string, id: string) {
    const report = await this.prisma.report.findFirst({
      where: { id, ownerId: userId },
    });
    if (!report) {
      throw new NotFoundException('报告不存在');
    }
    return report;
  }

  async remove(userId: string, id: string) {
    await this.findOne(userId, id);
    await this.prisma.report.delete({ where: { id } });
    return { success: true };
  }
}
