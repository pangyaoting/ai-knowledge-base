import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateSessionDto {
  @ApiProperty({ example: 'Vue3 学习问答', description: '会话标题', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '标题最多50个字符' })
  title?: string;

  @ApiProperty({ example: 'uuid', description: '限定检索的知识库ID（可选）', required: false })
  @IsOptional()
  @IsString()
  knowledgeBaseId?: string;
}
