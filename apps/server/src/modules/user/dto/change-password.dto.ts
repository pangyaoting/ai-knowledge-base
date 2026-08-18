import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({ example: '旧密码', description: '当前密码' })
  @IsString({ message: '当前密码不能为空' })
  @MaxLength(72, { message: '密码最多72个字符' })
  oldPassword!: string;

  @ApiProperty({ example: '新密码', description: '新密码（至少6位）' })
  @IsString({ message: '新密码不能为空' })
  @MinLength(6, { message: '新密码至少6位' })
  @MaxLength(72, { message: '密码最多72个字符' })
  newPassword!: string;
}
