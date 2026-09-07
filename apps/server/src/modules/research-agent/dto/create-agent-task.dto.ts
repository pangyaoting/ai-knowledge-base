import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** token 预算下限：1 万 */
export const AGENT_BUDGET_MIN = 10_000;
/** token 预算上限：50 万（自定义档位上限） */
export const AGENT_BUDGET_MAX = 500_000;

export class CreateAgentTaskDto {
  @ApiProperty({
    example: 'targeted',
    enum: ['targeted', 'open'],
    description: 'targeted=定向研究（需填目标）/ open=自主探索（无目标，从知识库挖掘方向）',
  })
  @IsEnum(['targeted', 'open'], { message: '研究模式不正确' })
  mode!: 'targeted' | 'open';

  @ApiProperty({
    example: '2026-2030 年 RAG 技术的演进趋势',
    description: '研究目标（open 模式可省略）',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '研究目标格式不正确' })
  @IsNotEmpty({ message: '研究目标不能为空' })
  @MaxLength(500, { message: '研究目标最多 500 个字符' })
  goal?: string;

  @ApiProperty({
    example: '2026-08-19T10:00:00.000Z',
    description: '时间窗开始（ISO，可省略 = 立即开始）',
    required: false,
  })
  @IsOptional()
  @IsDateString({}, { message: '开始时间格式不正确' })
  startAt?: string;

  @ApiProperty({
    example: '2026-08-19T11:30:00.000Z',
    description: '时间窗结束（ISO），停止硬上限',
    required: false,
  })
  @IsOptional()
  @IsDateString({}, { message: '结束时间格式不正确' })
  endAt?: string;

  @ApiProperty({
    example: 100_000,
    description: `token 预算（${AGENT_BUDGET_MIN / 10000} 万 ~ ${AGENT_BUDGET_MAX / 10000} 万）`,
  })
  @IsInt({ message: 'token 预算必须是整数' })
  @Min(AGENT_BUDGET_MIN, { message: `token 预算最少 ${AGENT_BUDGET_MIN / 10000} 万` })
  @Max(AGENT_BUDGET_MAX, { message: `token 预算最多 ${AGENT_BUDGET_MAX / 10000} 万` })
  tokenBudget!: number;

  @ApiProperty({
    example: 'uuid',
    description: '研究所用模型的配置ID（模型快照；页面顶部选择器选定后随创建提交）',
    required: false,
  })
  @IsOptional()
  @IsUUID('4', { message: '模型配置ID格式不正确' })
  modelConfigId?: string;

  @ApiProperty({
    example: 'deepseek-chat',
    description: '研究所用模型名（与 modelConfigId 同存为快照）',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '模型名格式不正确' })
  @MaxLength(100, { message: '模型名最多100个字符' })
  model?: string;
}
