import { IsEmail, IsIn, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** 发送邮箱验证码（注册 / 忘记密码 / 换绑邮箱） */
export class SendCodeDto {
  @ApiProperty({ example: 'user@example.com', description: '邮箱' })
  @IsEmail({}, { message: '邮箱格式不正确' })
  email!: string;

  @ApiProperty({ example: 'register', description: '场景：register / forgot / bind' })
  @IsString({ message: '场景格式不正确' })
  @IsIn(['register', 'forgot', 'bind'], { message: '场景必须是 register / forgot / bind' })
  type!: 'register' | 'forgot' | 'bind';
}
