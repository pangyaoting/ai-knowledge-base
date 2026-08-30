import { IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UploadAvatarDto {
  @ApiProperty({
    example: 'data:image/jpeg;base64,...',
    description: '头像图片（data URL，png/jpeg/webp，≤2MB）',
  })
  @IsString({ message: '头像必须是字符串' })
  @MaxLength(3_000_000, { message: '头像过大' })
  avatar!: string;
}
