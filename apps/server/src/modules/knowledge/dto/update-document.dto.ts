import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateDocumentDto {
  @ApiProperty({ example: '新的文件名.txt', description: '新的文件名（可选）', required: false })
  @IsOptional()
  @IsString({ message: '文件名格式不正确' })
  @MaxLength(255, { message: '文件名最多255个字符' })
  filename?: string;

  @ApiProperty({
    example: '编辑后的文档内容...',
    description: '新的文本内容（可选，传入则重新分块+向量化）',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '内容格式不正确' })
  @MaxLength(500_000, { message: '内容过大（最多 50 万字符）' })
  content?: string;
}
