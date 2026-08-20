import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** 单次追加 token 上限：50 万 */
export const AGENT_EXTEND_TOKEN_MAX = 500_000;
/** 单次续时上限：720 分钟（12 小时） */
export const AGENT_EXTEND_MINUTE_MAX = 720;

export class ExtendAgentTaskDto {
  @ApiProperty({
    example: 100_000,
    description: '追加的 token 预算（1 ~ 50 万）',
    required: false,
  })
  @IsOptional()
  @IsInt({ message: '追加预算必须是整数' })
  @Min(1, { message: '追加预算至少 1 个 token' })
  @Max(AGENT_EXTEND_TOKEN_MAX, {
    message: `单次最多追加 ${AGENT_EXTEND_TOKEN_MAX / 10000} 万 token`,
  })
  extraTokens?: number;

  @ApiProperty({
    example: 60,
    description: '追加的研究时长（分钟，1 ~ 720）',
    required: false,
  })
  @IsOptional()
  @IsInt({ message: '续时必须是整数分钟' })
  @Min(1, { message: '续时至少 1 分钟' })
  @Max(AGENT_EXTEND_MINUTE_MAX, { message: `单次最多续时 ${AGENT_EXTEND_MINUTE_MAX} 分钟` })
  extraMinutes?: number;
}
