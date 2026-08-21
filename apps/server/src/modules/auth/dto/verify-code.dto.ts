import { IsEmail, IsEnum, IsNotEmpty, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyCodeDto {
  @ApiProperty({ example: 'user@example.com', description: '邮箱' })
  @IsEmail({}, { message: '邮箱格式不正确' })
  email!: string;

  @ApiProperty({
    example: 'register',
    enum: ['register', 'forgot', 'bind'],
    description: '验证码场景',
  })
  @IsEnum(['register', 'forgot', 'bind'], { message: '场景类型不正确' })
  type!: 'register' | 'forgot' | 'bind';

  @ApiProperty({ example: '123456', description: '6 位验证码' })
  @IsString({ message: '验证码格式不正确' })
  @IsNotEmpty({ message: '请填写验证码' })
  @Length(6, 6, { message: '验证码为 6 位数字' })
  code!: string;
}
