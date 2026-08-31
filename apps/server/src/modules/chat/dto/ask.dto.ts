import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AskDto {
  @ApiProperty({
    example: 'Vue3 的响应式原理是什么？',
    description: '问题内容（可含上传文件提取的文本，只发图片/文件时可省略）',
  })
  @IsOptional()
  @IsString({ message: '问题必须是字符串' })
  @MaxLength(400_000, { message: '内容过长' })
  content?: string;

  @ApiProperty({ example: true, description: '是否启用联网检索（默认 false）', required: false })
  @IsOptional()
  @IsBoolean({ message: 'useWebSearch 必须是布尔值' })
  useWebSearch?: boolean;

  @ApiProperty({
    example: 'data:image/jpeg;base64,...',
    description: '单张图片（data URL，需支持视觉的模型；兼容旧客户端）',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '图片必须是字符串' })
  @MaxLength(6_000_000, { message: '图片过大' })
  imageDataUrl?: string;

  @ApiProperty({
    example: ['data:image/jpeg;base64,...'],
    description: '图片数组（一次最多 9 张，data URL）',
    required: false,
  })
  @IsOptional()
  @IsArray({ message: '图片必须是数组' })
  @ArrayMaxSize(9, { message: '一次最多 9 张图片' })
  @IsString({ each: true, message: '图片必须是字符串' })
  @MaxLength(6_000_000, { each: true, message: '单张图片过大' })
  imageDataUrls?: string[];
}
