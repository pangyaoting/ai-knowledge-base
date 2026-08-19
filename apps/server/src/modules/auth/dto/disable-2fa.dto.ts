import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class Disable2faDto {
  @ApiProperty({ description: '当前登录密码（关闭 2FA 需二次确认）' })
  @IsString({ message: '密码格式不正确' })
  @IsNotEmpty({ message: '请填写密码' })
  password!: string;
}
