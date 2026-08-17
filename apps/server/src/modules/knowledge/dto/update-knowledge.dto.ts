import { IsString, MinLength, MaxLength, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateKnowledgeDto {
  @ApiProperty({ example: 'Vue3 学习笔记（整理版）', description: '知识库名称', required: false })
  @IsOptional()
  @IsString({ message: '名称必须是字符串' })
  @MinLength(1, { message: '名称不能为空' })
  @MaxLength(50, { message: '名称最多50个字符' })
  name?: string;

  @ApiProperty({ example: '更新后的描述', description: '知识库描述', required: false })
  @IsOptional()
  @IsString({ message: '描述必须是字符串' })
  @MaxLength(200, { message: '描述最多200个字符' })
  description?: string;
}
