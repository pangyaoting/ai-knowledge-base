import { IsArray, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateReportDto {
  @ApiProperty({ example: 'RAG 技术全景分析', description: '研究主题' })
  @IsString({ message: '研究主题格式不正确' })
  @IsNotEmpty({ message: '请填写研究主题' })
  @MaxLength(200, { message: '研究主题最多200个字符' })
  topic!: string;

  @ApiProperty({
    example: ['uuid1'],
    description: '限定检索的知识库ID列表（可选；空 = 检索全部知识库）',
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray({ message: '知识库ID列表格式不正确' })
  @IsUUID('4', { each: true, message: '知识库ID格式不正确' })
  knowledgeBaseIds?: string[];
}
