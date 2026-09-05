import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AVATAR_DIR } from '../../common/paths';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

  /**
   * 根据 ID 查找用户（不返回密码）
   */
  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        nickname: true,
        avatar: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    return user;
  }

  /**
   * 更新用户资料
   */
  async update(id: string, dto: UpdateUserDto) {
    return this.prisma.user.update({
      where: { id },
      data: dto,
      select: {
        id: true,
        email: true,
        nickname: true,
        avatar: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
  }

  /** 上传头像：base64 data URL → 存 uploads/avatars/{userId}.{ext}（固定名，自动覆盖旧头像） */
  async uploadAvatar(id: string, avatar: string) {
    const m = /^data:image\/(png|jpeg|webp);base64,([\s\S]+)$/.exec(avatar);
    if (!m) {
      throw new BadRequestException('头像格式不正确（仅支持 png / jpeg / webp）');
    }
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 2 * 1024 * 1024) {
      throw new BadRequestException('头像不能超过 2MB');
    }
    await mkdir(AVATAR_DIR, { recursive: true });
    await writeFile(join(AVATAR_DIR, `${id}.${ext}`), buf);
    const avatarUrl = `/avatars/${id}.${ext}`;
    return this.prisma.user.update({
      where: { id },
      data: { avatar: avatarUrl },
      select: {
        id: true,
        email: true,
        nickname: true,
        avatar: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
  }

  /** 修改密码：校验旧密码 → 写入新密码 bcrypt 哈希 */
  async changePassword(id: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    const ok = await bcrypt.compare(dto.oldPassword, user.password);
    if (!ok) {
      throw new BadRequestException('当前密码不正确');
    }
    const hash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({ where: { id }, data: { password: hash } });
    return { success: true };
  }
}
