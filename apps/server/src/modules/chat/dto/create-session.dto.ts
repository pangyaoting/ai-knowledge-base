import { IsArray, IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateSessionDto {
  @ApiProperty({ example: 'Vue3 学习问答', description: '会话标题', required: false })
  @IsOptional()
  @IsString({ message: '标题格式不正确' })
  @MaxLength(50, { message: '标题最多50个字符' })
  title?: string;

  @ApiProperty({
    example: ['uuid1', 'uuid2'],
    description: '限定检索的知识库ID列表（可选；空数组 + useKnowledgeBase=true = 检索全部知识库）',
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray({ message: '知识库ID列表格式不正确' })
  @IsUUID('4', { each: true, message: '知识库ID格式不正确' })
  knowledgeBaseIds?: string[];

  @ApiProperty({
    example: true,
    description: '是否使用知识库检索（false = 纯对话模式，不检索任何知识库）',
    required: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'useKnowledgeBase 格式不正确' })
  useKnowledgeBase?: boolean;
}
