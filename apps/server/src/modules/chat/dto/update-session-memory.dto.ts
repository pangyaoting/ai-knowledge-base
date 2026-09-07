import { IsBoolean, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** 会话记忆管理：清空摘要 / 停用或启用记忆 */
export class UpdateSessionMemoryDto {
  @ApiProperty({
    example: true,
    description: '清空本会话滚动摘要（聊天记录保留）',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  clearSummary?: boolean;

  @ApiProperty({
    example: true,
    description: '记忆开关（false = 停用本会话摘要折叠与注入）',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  memoryEnabled?: boolean;
}
