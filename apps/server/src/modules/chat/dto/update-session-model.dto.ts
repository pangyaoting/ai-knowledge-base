import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** 推理等级：low=关闭（最低推理，最快最省）/ high=高 / max=最高（思考更深，token 更多） */
export const REASONING_EFFORTS = ['low', 'high', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** 修改会话绑定的模型配置 + 具体模型名 + 推理等级（null = 解除绑定，会话未选模型） */
export class UpdateSessionModelDto {
  @ApiProperty({
    example: 'uuid',
    description: '模型配置ID；null/不传 = 解除绑定（会话未选模型，提问时会提示先选）',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsUUID('4', { message: '模型配置ID格式不正确' })
  modelConfigId?: string | null;

  @ApiProperty({
    example: 'deepseek-chat',
    description: '该配置下选中的模型名（同一配置可切换多个模型；不传 = 用该配置主 model）',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: '模型名格式不正确' })
  @MaxLength(100, { message: '模型名最多100个字符' })
  model?: string | null;

  @ApiProperty({
    example: 'high',
    enum: REASONING_EFFORTS,
    description: '推理等级：low=关闭(最低) / high / max；null/不传 = 不修改',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsEnum(REASONING_EFFORTS, { message: '推理等级只能是 low / high / max' })
  reasoningEffort?: ReasoningEffort | null;
}
