import { IsEmail, IsString, Length, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'user@example.com', description: '注册邮箱' })
  @IsEmail({}, { message: '邮箱格式不正确' })
  email!: string;

  @ApiProperty({ example: '123456', description: '邮箱验证码' })
  @IsString({ message: '验证码格式不正确' })
  @Length(6, 6, { message: '验证码为 6 位数字' })
  code!: string;

  @ApiProperty({ example: 'newpass123', description: '新密码（至少6位）' })
  @IsString()
  @MinLength(6, { message: '密码至少6位' })
  @MaxLength(32, { message: '密码最多32位' })
  newPassword!: string;
}
