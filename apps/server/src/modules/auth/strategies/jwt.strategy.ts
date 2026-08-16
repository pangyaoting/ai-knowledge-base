import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { JwtPayload } from '../interfaces/auth.interface';

/**
 * JWT 策略：验证 accessToken 是否有效
 * 有效时把用户信息挂到 request.user 上
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      // 从 Authorization: Bearer <token> 中提取 token
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false, // token 过期直接拒绝
      secretOrKey: configService.get<string>('JWT_SECRET', 'default_secret'),
    });
  }

  /**
   * token 验证通过后自动调用，返回值会挂到 request.user
   * 这里再查一次数据库，确保用户还存在（没被删除）
   */
  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, nickname: true, avatar: true },
    });

    if (!user) {
      throw new UnauthorizedException('用户不存在或已被删除');
    }

    return user;
  }
}
