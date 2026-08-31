import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

class SeedMessageDto {
  @IsIn(['user', 'assistant'], { message: '角色只能是 user / assistant' })
  role!: 'user' | 'assistant';

  @IsString({ message: '内容必须是字符串' })
  @MaxLength(100_000, { message: '单条内容过长' })
  content!: string;
}

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

  @ApiProperty({
    example: 'uuid',
    description: '会话绑定的用户模型配置ID（不传 = 系统默认模型）',
    required: false,
  })
  @IsOptional()
  @IsUUID('4', { message: '模型配置ID格式不正确' })
  modelConfigId?: string;

  @ApiProperty({
    example: [{ role: 'user', content: '…' }],
    description: '分支注入的历史消息（把之前的对话带进新会话，最多 20 条）',
    required: false,
    type: [SeedMessageDto],
  })
  @IsOptional()
  @IsArray({ message: 'seedMessages 必须是数组' })
  @ArrayMaxSize(20, { message: '最多注入 20 条历史消息' })
  @ValidateNested({ each: true })
  @Type(() => SeedMessageDto)
  seedMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
}
