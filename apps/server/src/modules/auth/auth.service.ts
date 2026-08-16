import { Injectable, ConflictException, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
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
   * 登录
   */
  async login(dto: LoginDto): Promise<AuthResult> {
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
