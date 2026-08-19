import { IsNotEmpty, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class Login2faDto {
  @ApiProperty({ description: '第一步登录返回的临时 loginToken（5 分钟有效）' })
  @IsString({ message: 'loginToken 格式不正确' })
  @IsNotEmpty({ message: '缺少 loginToken' })
  loginToken!: string;

  @ApiProperty({ example: '123456', description: '6 位动态码，或一次性恢复码（如 ABCD-EF12）' })
  @IsString({ message: '验证码格式不正确' })
  @IsNotEmpty({ message: '请填写验证码' })
  code!: string;
}
