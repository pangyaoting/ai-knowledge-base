import { IsEmail, IsString, MinLength, MaxLength, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com', description: '邮箱' })
  @IsEmail({}, { message: '邮箱格式不正确' })
  email!: string;

  @ApiProperty({ example: '123456', description: '密码（至少6位）' })
  @IsString()
  @MinLength(6, { message: '密码至少6位' })
  @MaxLength(32, { message: '密码最多32位' })
  password!: string;

  @ApiProperty({ example: '张三', description: '昵称', required: false })
  @IsOptional() // 不传昵称时跳过校验（否则不带 nickname 注册会 400）
  @IsString()
  @MaxLength(20, { message: '昵称最多20个字符' })
  nickname?: string;
}
