import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AskDto {
  @ApiProperty({ example: 'Vue3 的响应式原理是什么？', description: '问题内容' })
  @IsString({ message: '问题必须是字符串' })
  @MinLength(1, { message: '问题不能为空' })
  @MaxLength(2000, { message: '问题最多2000个字符' })
  content!: string;
}
