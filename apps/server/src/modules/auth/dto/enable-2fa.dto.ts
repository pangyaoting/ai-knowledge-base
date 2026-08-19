import { IsNotEmpty, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class Enable2faDto {
  @ApiProperty({ example: '123456', description: '验证器 App 上的 6 位动态码' })
  @IsString({ message: '验证码格式不正确' })
  @Length(6, 6, { message: '验证码为 6 位数字' })
  code!: string;
}
