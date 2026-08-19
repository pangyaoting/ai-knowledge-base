import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { EmailCodeService } from './email-code.service';

@Module({
  imports: [
    PassportModule,
    // JWT 模块注册，默认配置（accessToken 用）
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, EmailCodeService],
  exports: [AuthService],
})
export class AuthModule {}
