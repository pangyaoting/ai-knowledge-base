import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserService } from './user.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UploadAvatarDto } from './dto/upload-avatar.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('用户')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('profile')
  @ApiOperation({ summary: '获取个人信息' })
  getProfile(@CurrentUser('id') userId: string) {
    return this.userService.findById(userId);
  }

  @Patch('profile')
  @ApiOperation({ summary: '修改个人信息' })
  updateProfile(@CurrentUser('id') userId: string, @Body() dto: UpdateUserDto) {
    return this.userService.update(userId, dto);
  }

  @Post('avatar')
  @ApiOperation({ summary: '上传头像（base64 data URL，png/jpeg/webp）' })
  uploadAvatar(@CurrentUser('id') userId: string, @Body() dto: UploadAvatarDto) {
    return this.userService.uploadAvatar(userId, dto.avatar);
  }

  @Post('change-password')
  @ApiOperation({ summary: '修改密码' })
  changePassword(@CurrentUser('id') userId: string, @Body() dto: ChangePasswordDto) {
    return this.userService.changePassword(userId, dto);
  }
}
