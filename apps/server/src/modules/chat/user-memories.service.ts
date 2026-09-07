import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  FACT_CATEGORIES,
  FACT_CHAR_CAP,
  MAX_FACTS,
  type FactCategory,
} from './memory-fact.service';

/**
 * 用户事实记忆管理（记忆模块 B 的"档案"侧）：
 * - 抽取由 MemoryFactService 在回答后异步进行（自动写入，见 memory-fact.service）；
 * - 这里是跨会话"档案"的管理接口：查看全部 / 手动补一条 / 删除（误抽取修正）。
 * 手动新增同样走"内容精确去重 + 上限 50"的约束。
 */
@Injectable()
export class UserMemoriesService {
  constructor(private prisma: PrismaService) {}

  /** 我的全部用户事实（按新→旧；category 可选过滤） */
  async list(userId: string, category?: string) {
    const cat =
      category && (FACT_CATEGORIES as readonly string[]).includes(category) ? category : undefined;
    // 注：userMemory 模型本地 prisma client 未重生成 → any 兼容（CI/部署端 generate 后真实存在）
    const rows = await (this.prisma as any).userMemory.findMany({
      where: { ownerId: userId, ...(cat ? { category: cat } : {}) },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        content: true,
        category: true,
        sourceSessionId: true,
        createdAt: true,
      },
    });
    return { items: rows, total: (rows as unknown[]).length };
  }

  /** 手动补一条事实（去重 + 上限校验与抽取侧一致） */
  async add(userId: string, dto: { content: string; category?: FactCategory }) {
    const prisma = this.prisma as any;
    const content = (dto.content ?? '').trim();
    if (!content) throw new BadRequestException('记忆内容不能为空');
    if (content.length > FACT_CHAR_CAP) {
      throw new BadRequestException(
        `记忆内容请在 ${FACT_CHAR_CAP} 字以内（当前 ${content.length} 字）`,
      );
    }
    const category = dto.category ?? 'general';

    const dup = await prisma.userMemory.findFirst({
      where: { ownerId: userId, content },
      select: { id: true },
    });
    if (dup) throw new BadRequestException('该记忆已存在（内容相同），无需重复添加');

    const total = await prisma.userMemory.count({ where: { ownerId: userId } });
    if (total >= MAX_FACTS) {
      throw new BadRequestException(
        `用户记忆已达上限 ${MAX_FACTS} 条：请先删除不再需要的记忆再添加`,
      );
    }

    return prisma.userMemory.create({
      data: { ownerId: userId, content, category, sourceSessionId: null },
      select: { id: true, content: true, category: true, createdAt: true },
    });
  }

  /** 删除一条（只允许删自己的；误抽取/不再需要时清理） */
  async remove(userId: string, id: string) {
    const prisma = this.prisma as any;
    const res = await prisma.userMemory.deleteMany({ where: { id, ownerId: userId } });
    if (res.count === 0) throw new NotFoundException('记忆不存在或不属于你');
    return { deleted: true };
  }
}
