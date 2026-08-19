import { IsEmail, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BindEmailDto {
  @ApiProperty({ example: 'new@example.com', description: '新邮箱' })
  @IsEmail({}, { message: '邮箱格式不正确' })
  email!: string;

  @ApiProperty({ example: '123456', description: '发送到新邮箱的验证码' })
  @IsString({ message: '验证码格式不正确' })
  @Length(6, 6, { message: '验证码为 6 位数字' })
  code!: string;
}
