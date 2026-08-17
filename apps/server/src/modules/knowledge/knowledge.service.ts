import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateKnowledgeDto } from './dto/create-knowledge.dto';
import { UpdateKnowledgeDto } from './dto/update-knowledge.dto';

/**
 * 知识库服务
 * 所有操作都带 ownerId 过滤，保证用户只能操作自己的知识库（数据隔离）
 */
@Injectable()
export class KnowledgeService {
  constructor(private prisma: PrismaService) {}

  /** 创建知识库 */
  async create(userId: string, dto: CreateKnowledgeDto) {
    return this.prisma.knowledgeBase.create({
      data: {
        name: dto.name,
        description: dto.description,
        ownerId: userId,
      },
    });
  }

  /** 我的知识库列表（带文档数量统计） */
  async findAll(userId: string) {
    return this.prisma.knowledgeBase.findMany({
      where: { ownerId: userId },
      include: {
        _count: { select: { documents: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 单个知识库（校验归属，不存在或不属于当前用户都报 404） */
  async findOne(userId: string, id: string) {
    const kb = await this.prisma.knowledgeBase.findFirst({
      where: { id, ownerId: userId },
      include: {
        _count: { select: { documents: true } },
      },
    });
    if (!kb) {
      throw new NotFoundException('知识库不存在');
    }
    return kb;
  }

  /** 更新知识库（先校验归属再更新） */
  async update(userId: string, id: string, dto: UpdateKnowledgeDto) {
    await this.findOne(userId, id);
    return this.prisma.knowledgeBase.update({
      where: { id },
      data: dto,
    });
  }

  /** 删除知识库（文档通过数据库外键 ON DELETE CASCADE 级联删除） */
  async remove(userId: string, id: string) {
    await this.findOne(userId, id);
    await this.prisma.knowledgeBase.delete({ where: { id } });
    return { success: true };
  }
}
