import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class DeleteAccountDto {
  @ApiProperty({ example: 'myPassword', description: '当前密码（注销前确认身份）' })
  @IsString({ message: '密码格式不正确' })
  @IsNotEmpty({ message: '请输入当前密码' })
  password!: string;
}
