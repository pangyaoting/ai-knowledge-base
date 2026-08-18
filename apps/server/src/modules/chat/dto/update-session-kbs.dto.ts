import { IsArray, IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateSessionKbsDto {
  @ApiProperty({
    example: ['uuid1', 'uuid2'],
    description: '会话绑定的知识库ID列表（空数组 + useKnowledgeBase=true = 检索全部知识库）',
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
