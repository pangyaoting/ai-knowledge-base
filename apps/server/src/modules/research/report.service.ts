import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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

  /** 创建研究报告任务（立即返回 pending；模型快照随创建写入） */
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
    // 模型快照校验：配置必须存在且属于当前用户（无默认配置兜底 → 创建即失败，不留坏任务）
    if (dto.modelConfigId) {
      const cfg = await this.prisma.modelConfig.findFirst({
        where: { id: dto.modelConfigId, ownerId: userId },
        select: { id: true },
      });
      if (!cfg) throw new BadRequestException('所选模型配置不存在或不属于你');
    }
    // 注：快照列为新加列，本地 client 未重生成 → any 兼容（CI/部署端 generate 后真实存在）
    const report = await (this.prisma.report as any).create({
      data: {
        ownerId: userId,
        topic: dto.topic.trim(),
        modelConfigId: dto.modelConfigId ?? null,
        model: dto.model?.trim() || null,
        // P1-7：持久化创建时的检索范围——失败后"重新生成"可精确回填同一范围（不退化成全库）
        kbScope: {
          scope: kbIds ? 'specific' : 'all',
          knowledgeBaseIds: kbIds ?? [],
        },
      },
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

  /** 取消生成中的报告（P1-4）：标记 cancelled，processor 在节间检查后中止 */
  async cancel(userId: string, id: string) {
    const report = await this.findOne(userId, id);
    if (!['pending', 'processing'].includes(report.status)) {
      throw new BadRequestException('当前状态不可取消（仅生成中可取消）');
    }
    return this.prisma.report.update({
      where: { id },
      data: { status: 'cancelled' },
    });
  }
}
