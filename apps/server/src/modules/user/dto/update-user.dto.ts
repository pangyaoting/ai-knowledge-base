import { IsString, MaxLength, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateUserDto {
  @ApiProperty({ example: '张三', description: '昵称', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(20, { message: '昵称最多20个字符' })
  nickname?: string;

  @ApiProperty({
    example: 'https://example.com/avatar.png',
    description: '头像URL',
    required: false,
  })
  @IsOptional()
  @IsString()
  avatar?: string;
}
