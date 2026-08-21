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
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { EmailCodeService } from './email-code.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { BindEmailDto } from './dto/bind-email.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';
import { JwtPayload, AuthResult } from './interfaces/auth.interface';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  // refreshToken 在 Redis 中的 key 前缀
  private readonly REFRESH_PREFIX = 'refresh_token:';

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private emailCodeService: EmailCodeService,
  ) {}

  /**
   * 发送邮箱验证码（注册 / 忘记密码 / 换绑邮箱共用）
   */
  async sendCode(email: string, type: 'register' | 'forgot' | 'bind') {
    if (type === 'register') {
      const exists = await this.prisma.user.findUnique({ where: { email } });
      if (exists) throw new ConflictException('该邮箱已被注册');
    }
    return this.emailCodeService.sendCode(email, type);
  }

  /**
   * 校验验证码（只校验不消费）：注册流程"点下一步"时用——
   * 先查邮箱是否已注册，再验证验证码正确且未过期；通过后进入设置密码步骤，
   * 验证码保留到提交注册时再真正消费。
   */
  async verifyCode(dto: VerifyCodeDto) {
    const email = dto.email.toLowerCase();
    if (dto.type === 'register') {
      const existing = await this.prisma.user.findUnique({ where: { email } });
      if (existing) {
        throw new ConflictException('该邮箱已被注册');
      }
    }
    await this.emailCodeService.verifyOnly(email, dto.type, dto.code);
    return { success: true };
  }

  /**
   * 注册：邮箱 + 验证码 + 密码（先查重，再校验验证码——已注册邮箱直接提示，避免"验证码错误"误导）
   */
  async register(dto: RegisterDto): Promise<AuthResult> {
    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('该邮箱已被注册');
    }

    await this.emailCodeService.verifyCode(email, 'register', dto.code);

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        nickname: dto.nickname || email.split('@')[0],
      },
      select: { id: true, email: true, nickname: true, avatar: true },
    });

    this.logger.log(`新用户注册: ${user.email}`);
    return this.generateTokens(user);
  }

  /**
   * 登录：邮箱 + 密码（验证码只在注册/忘记密码/换邮箱时用）
   */
  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (!user) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('邮箱或密码错误');
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

  /**
   * 忘记密码：邮箱 + 验证码 → 设置新密码
   */
  async forgotPassword(dto: ForgotPasswordDto) {
    const email = dto.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new BadRequestException('该邮箱尚未注册');
    }
    await this.emailCodeService.verifyCode(email, 'forgot', dto.code);
    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });
    this.logger.log(`用户 ${email} 已重置密码`);
    return { success: true };
  }

  /**
   * 更换邮箱绑定：验证新邮箱 + 验证码（新邮箱未被占用）
   */
  async bindEmail(userId: string, dto: BindEmailDto) {
    const email = dto.email.toLowerCase();
    await this.emailCodeService.verifyCode(email, 'bind', dto.code);
    const occupied = await this.prisma.user.findUnique({ where: { email } });
    if (occupied && occupied.id !== userId) {
      throw new ConflictException('该邮箱已被其他账号使用');
    }
    await this.prisma.user.update({ where: { id: userId }, data: { email } });
    this.logger.log(`用户 ${userId} 更换邮箱为 ${email}`);
    return this.getProfile(userId);
  }

  /** 当前用户信息 */
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, nickname: true, avatar: true },
    });
    if (!user) throw new UnauthorizedException('用户不存在');
    return user;
  }

  /**
   * 刷新 Token：用 refreshToken 换新的 accessToken + refreshToken
   */
  async refresh(refreshToken: string): Promise<AuthResult> {
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('refreshToken 无效或已过期，请重新登录');
    }

    const stored = await this.redis.get(this.REFRESH_PREFIX + refreshToken);
    // 容错：Redis 重启会清空键，但 JWT 本身仍有效 → 允许换新，避免用户被莫名踢出登录
    // （登出吊销依然生效：logout 会删除键，删除后再 refresh 才会被拒）
    if (stored) {
      await this.redis.del(this.REFRESH_PREFIX + refreshToken);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, nickname: true, avatar: true },
    });
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }

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

    const accessToken = await this.jwtService.signAsync(jwtPayload, {
      secret: this.configService.get<string>('JWT_SECRET'),
      expiresIn: this.configService.get<string>('JWT_EXPIRES_IN', '15m'),
    });

    const refreshToken = await this.jwtService.signAsync(jwtPayload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRES_IN', '7d'),
    });

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
