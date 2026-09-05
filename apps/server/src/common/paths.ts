/**
 * 上传文件目录（头像 + 知识库文档附件）统一出口。
 *
 * 为什么目录可配置：CI 部署会 rm -rf 整个代码目录再解压，如果 uploads 在代码目录里，
 * 上传的头像/文档会随部署丢失（表现为"每次改代码后头像要重新上传"）。
 * 生产环境在 .env 配 UPLOAD_DIR 指向代码目录之外（如 /opt/kb/data/uploads），
 * 代码目录变成纯代码，部署随便删都不影响用户数据。
 *
 * 注意：@nestjs/config 要到 bootstrap 才读 .env，而模块顶层常量（AVATAR_DIR 等）
 * 在 import 时就要用——这里用 Node 内置 process.loadEnvFile() 提前加载 .env（20.12+）。
 */
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile();
  }
} catch {
  // .env 不存在（如单测环境）时忽略，走默认目录
}

import { basename, join, resolve } from 'node:path';

const envDir = process.env.UPLOAD_DIR;
/** 上传根目录：.env UPLOAD_DIR（绝对或相对 cwd）→ 解析；缺省 cwd/uploads（本地开发兼容） */
export const UPLOAD_DIR = envDir ? resolve(process.cwd(), envDir) : join(process.cwd(), 'uploads');
/** 头像目录（公开静态服务，与知识库附件分开） */
export const AVATAR_DIR = join(UPLOAD_DIR, 'avatars');

/**
 * 数据库 filepath（'uploads/xxx' 相对路径）→ 磁盘绝对路径。
 * 只取 basename 拼接 UPLOAD_DIR：目录迁移后旧记录（相对旧位置）依然能正确定位。
 */
export function storedPath(filepath: string): string {
  return join(UPLOAD_DIR, basename(filepath));
}
