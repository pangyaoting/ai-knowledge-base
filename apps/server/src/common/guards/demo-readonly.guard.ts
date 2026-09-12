import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

/**
 * 演示 / 审核账号「只读」守卫。
 *
 * 场景：公安联网备案审核员、面试官需要一个能进门看东西的账号，但**不该**改任何数据、
 * 也不该花平台的钱 —— 注意"没绑模型 Key"只挡住了大模型调用，**上传文档仍会用系统 Key
 * 做 bge-m3 向量化**（`embedding.service.ts` 读 SILICONFLOW_API_KEY），所以必须在服务端
 * 真正拦住写操作，而不是靠前端藏按钮（藏按钮 curl 一下就绕过了）。
 *
 * 识别方式：环境变量 `DEMO_READONLY_EMAILS`（逗号分隔的邮箱）。
 * 用邮箱而不是加数据库字段，是为了**不改 schema、不加迁移**；演示账号本来就是一个运维约定。
 * 未配置该变量时守卫完全不生效（对普通部署零影响）。
 *
 * 规则：只放行 GET/HEAD/OPTIONS；其余方法一律 403，少数"只读账号也必须有"的写接口见白名单。
 */
@Injectable()
export class DemoReadonlyGuard implements CanActivate {
  private readonly logger = new Logger(DemoReadonlyGuard.name);
  private readonly demoEmails: Set<string>;

  /**
   * 白名单：登出与刷新令牌。
   * 不放开登出的话，审核员登进来就**退不出去**（会看到"演示账号为只读"的报错）；
   * 刷新令牌是会话续期的正常动作，不涉及数据变更。
   */
  private static readonly SAFE_WRITE_PATHS = ['/auth/logout', '/auth/refresh'];

  private static readonly READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  constructor(private readonly config: ConfigService) {
    const raw = this.config.get<string>('DEMO_READONLY_EMAILS', '');
    this.demoEmails = new Set(
      raw
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    );
    if (this.demoEmails.size > 0) {
      this.logger.log(`演示只读账号已启用：${[...this.demoEmails].join(', ')}`);
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.demoEmails.size === 0) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: { email?: string } }>();
    // 未登录 / @Public 接口：没有 user，交给 JwtAuthGuard 与业务自己判断
    const email = req.user?.email?.toLowerCase();
    if (!email || !this.demoEmails.has(email)) return true;

    if (DemoReadonlyGuard.READ_ONLY_METHODS.has(req.method)) return true;

    // 去掉全局前缀 /api 后再比对白名单（req.path 形如 /api/auth/logout）
    const path = (req.path ?? '').replace(/^\/api/, '');
    if (DemoReadonlyGuard.SAFE_WRITE_PATHS.includes(path)) return true;

    this.logger.warn(`演示只读账号尝试写操作已拦截：${req.method} ${req.path}`);
    throw new ForbiddenException(
      '演示账号为只读：可以浏览全部页面与已有数据，写操作（上传、新建、修改、AI 功能）已关闭。',
    );
  }
}
