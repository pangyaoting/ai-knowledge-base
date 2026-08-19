import { Body, Controller, Post, HttpCode, HttpStatus, UseGuards, Get } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { Login2faDto } from './dto/login-2fa.dto';
import { Enable2faDto } from './dto/enable-2fa.dto';
import { Disable2faDto } from './dto/disable-2fa.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '注册' })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '登录（开启 2FA 的用户返回 need2fa + loginToken，走第二步）' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Public()
  @Post('login/2fa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '登录第二步：动态码 / 恢复码换取正式 Token' })
  login2fa(@Body() dto: Login2faDto) {
    return this.authService.login2fa(dto.loginToken, dto.code);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '刷新 Token' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '登出' })
  logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('profile')
  @ApiOperation({ summary: '获取当前登录用户信息（含 2FA 状态）' })
  getProfile(@CurrentUser('id') userId: string) {
    return this.authService.getProfile(userId);
  }

  // ==================== 双因素认证（TOTP）====================

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('2fa/generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '生成 2FA 绑定材料（base32 密钥 + otpauth URI）' })
  generate2fa(@CurrentUser('id') userId: string) {
    return this.authService.generate2fa(userId);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('2fa/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '绑定：校验动态码后启用 2FA，返回一次性恢复码' })
  enable2fa(@CurrentUser('id') userId: string, @Body() dto: Enable2faDto) {
    return this.authService.enable2fa(userId, dto.code);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '校验当前动态码（设置页实时验证）' })
  verify2fa(@CurrentUser('id') userId: string, @Body() dto: Enable2faDto) {
    return this.authService.verify2fa(userId, dto.code);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '关闭 2FA（需验证当前密码）' })
  disable2fa(@CurrentUser('id') userId: string, @Body() dto: Disable2faDto) {
    return this.authService.disable2fa(userId, dto.password);
  }
}
