import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { TotpService } from './totp.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { JwtPayload, AuthResult } from './interfaces/auth.interface';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  // refreshToken 在 Redis 中的 key 前缀
  private readonly REFRESH_PREFIX = 'refresh_token:';
  // 2FA：绑定暂存的密钥 / 登录第一步的临时令牌
  private readonly TOTP_SETUP_PREFIX = '2fa_setup:';
  private readonly LOGIN2FA_PREFIX = '2fa_login:';
  private readonly LOGIN2FA_TTL = 5 * 60; // 登录第一步临时令牌 5 分钟有效

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private totpService: TotpService,
  ) {}

  /**
   * 注册
   */
  async register(dto: RegisterDto): Promise<AuthResult> {
    // 检查邮箱是否已注册
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('该邮箱已被注册');
    }

    // 密码加密（salt 轮数 10）
    const hashedPassword = await bcrypt.hash(dto.password, 10);

    // 创建用户
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password: hashedPassword,
        nickname: dto.nickname || dto.email.split('@')[0],
      },
      select: { id: true, email: true, nickname: true, avatar: true },
    });

    this.logger.log(`新用户注册: ${user.email}`);

    // 生成双 Token
    return this.generateTokens(user);
  }

  /**
   * 登录（两步验证支持）：
   * 开启 2FA 的用户，密码验证通过后返回 need2fa + loginToken，
   * 前端再调 login2fa 用动态码/恢复码换取正式 Token。
   */
  async login(
    dto: LoginDto,
  ): Promise<AuthResult | { need2fa: true; loginToken: string; user: { email: string } }> {
    // 查找用户
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    // 验证密码
    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    // 开启 2FA：第一步只发临时令牌，第二步验动态码/恢复码后才发正式 Token
    if (user.totpEnabled) {
      const loginToken = randomUUID();
      await this.redis.set(this.LOGIN2FA_PREFIX + loginToken, user.id, 'EX', this.LOGIN2FA_TTL);
      this.logger.log(`用户 ${user.email} 密码通过，等待 2FA 验证`);
      return { need2fa: true, loginToken, user: { email: user.email } };
    }

    // 更新最后登录时间
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    this.logger.log(`用户登录: ${user.email}`);

    return this.generateTokens({
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      avatar: user.avatar,
    });
  }

  /**
   * 登录第二步：动态码 或 一次性恢复码 → 换取正式 Token
   */
  async login2fa(loginToken: string, code: string): Promise<AuthResult> {
    const userId = await this.redis.get(this.LOGIN2FA_PREFIX + loginToken);
    if (!userId) {
      throw new UnauthorizedException('登录已过期，请重新输入邮箱密码');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.totpEnabled || !user.totpSecret) {
      throw new UnauthorizedException('用户状态异常');
    }

    // 动态码
    if (this.totpService.verify(user.totpSecret, code)) {
      await this.redis.del(this.LOGIN2FA_PREFIX + loginToken);
    } else {
      // 恢复码（一次性：命中后移除）
      const storedHashes = (user.recoveryCodes as string[]) ?? [];
      const { hashes, ok } = this.totpService.consumeRecoveryCode(storedHashes, code);
      if (!ok) {
        throw new UnauthorizedException('验证码错误');
      }
      await this.prisma.user.update({
        where: { id: user.id },
        data: { recoveryCodes: JSON.parse(JSON.stringify(hashes)) },
      });
      await this.redis.del(this.LOGIN2FA_PREFIX + loginToken);
      this.logger.log(`用户 ${user.email} 使用恢复码登录`);
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    this.logger.log(`用户登录: ${user.email}`);

    return this.generateTokens({
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      avatar: user.avatar,
    });
  }

  // ==================== 2FA 设置管理 ====================

  /** 当前用户信息（含 2FA 开启状态，供前端设置页展示） */
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        nickname: true,
        avatar: true,
        totpEnabled: true,
      },
    });
    if (!user) throw new UnauthorizedException('用户不存在');
    return user;
  }

  /** 生成绑定材料：base32 密钥 + otpauth URI（暂存 Redis，启用时才落库） */
  async generate2fa(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, totpEnabled: true },
    });
    if (!user) throw new UnauthorizedException('用户不存在');
    if (user.totpEnabled) {
      throw new BadRequestException('已启用双因素认证');
    }
    const secret = this.totpService.generateSecret();
    await this.redis.set(this.TOTP_SETUP_PREFIX + userId, secret, 'EX', 10 * 60);
    return { secret, otpauthUrl: this.totpService.buildUri(secret, user.email) };
  }

  /** 绑定：校验动态码 → 启用 + 存密钥 + 生成恢复码（明文只返回这一次） */
  async enable2fa(userId: string, code: string) {
    const secret = await this.redis.get(this.TOTP_SETUP_PREFIX + userId);
    if (!secret) {
      throw new BadRequestException('绑定已过期，请重新生成二维码');
    }
    if (!this.totpService.verify(secret, code)) {
      throw new BadRequestException('验证码错误，请检查验证器 App 与当前时间');
    }
    const recoveryCodes = this.totpService.generateRecoveryCodes();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        totpSecret: secret,
        totpEnabled: true,
        recoveryCodes: JSON.parse(
          JSON.stringify(recoveryCodes.map((c) => this.totpService.hashRecovery(c))),
        ),
      },
    });
    await this.redis.del(this.TOTP_SETUP_PREFIX + userId);
    this.logger.log(`用户 ${userId} 已开启双因素认证`);
    return { recoveryCodes }; // 仅此一次明文，请用户保存
  }

  /** 设置页实时校验动态码 */
  async verify2fa(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { totpSecret: true, totpEnabled: true },
    });
    if (!user?.totpEnabled || !user.totpSecret) {
      return { valid: false };
    }
    return { valid: this.totpService.verify(user.totpSecret, code) };
  }

  /** 关闭 2FA：需验证密码（再可选验证码，这里以密码为准） */
  async disable2fa(userId: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('用户不存在');
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) throw new UnauthorizedException('密码错误');
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: null, totpEnabled: false, recoveryCodes: Prisma.DbNull },
    });
    this.logger.log(`用户 ${user.email} 已关闭双因素认证`);
    return { success: true };
  }

  /**
   * 刷新 Token
   * 用 refreshToken 换新的 accessToken + refreshToken
   */
  async refresh(refreshToken: string): Promise<AuthResult> {
    let payload: JwtPayload;
    try {
      // 验证 refreshToken 签名和有效期
      payload = await this.jwtService.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('refreshToken 无效或已过期，请重新登录');
    }

    // 检查 Redis 中是否存在这个 refreshToken（防止被盗用）
    const jti = payload.sub; // 我们用 sub + jti 来定位，这里简化用 token hash
    const stored = await this.redis.get(this.REFRESH_PREFIX + refreshToken);
    if (!stored) {
      throw new UnauthorizedException('refreshToken 已失效，请重新登录');
    }

    // 查用户
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, nickname: true, avatar: true },
    });
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }

    // 删除旧 refreshToken，生成新的（轮换机制）
    await this.redis.del(this.REFRESH_PREFIX + refreshToken);

    return this.generateTokens(user);
  }

  /**
   * 登出：删除 Redis 中的 refreshToken
   */
  async logout(refreshToken: string): Promise<void> {
    await this.redis.del(this.REFRESH_PREFIX + refreshToken);
  }

  /**
   * 生成 accessToken + refreshToken，并把 refreshToken 存入 Redis
   */
  private async generateTokens(user: {
    id: string;
    email: string;
    nickname: string | null;
    avatar: string | null;
  }): Promise<AuthResult> {
    const jwtPayload: JwtPayload = {
      sub: user.id,
      email: user.email,
      nickname: user.nickname,
    };

    // accessToken：短期（15分钟）
    const accessToken = await this.jwtService.signAsync(jwtPayload, {
      secret: this.configService.get<string>('JWT_SECRET'),
      expiresIn: this.configService.get<string>('JWT_EXPIRES_IN', '15m'),
    });

    // refreshToken：长期（7天）
    const refreshToken = await this.jwtService.signAsync(jwtPayload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRES_IN', '7d'),
    });

    // refreshToken 存入 Redis，设置 7 天过期
    const refreshExpiresIn = 7 * 24 * 60 * 60; // 秒
    await this.redis.set(this.REFRESH_PREFIX + refreshToken, user.id, 'EX', refreshExpiresIn);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        avatar: user.avatar,
      },
    };
  }
}
