import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { FACT_CATEGORIES } from '../memory-fact.service';

/** 手动新增一条用户事实记忆（B 档案）：抽取侧与手写侧共用同一内容上限与分类集合 */
export class CreateUserMemoryDto {
  @ApiProperty({
    example: '我是 2024 级前端方向学生，2027 年 1 月开始求职',
    description: '事实内容（一句话，≤120 字）',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120, { message: '记忆内容请在 120 字以内' })
  content!: string;

  @ApiProperty({
    example: 'background',
    description: '分类：general / preference / background / goal',
    required: false,
    default: 'general',
  })
  @IsOptional()
  @IsIn([...FACT_CATEGORIES], {
    message: 'category 只能是 general / preference / background / goal',
  })
  category?: (typeof FACT_CATEGORIES)[number];
}
