import { IsOptional, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** 修改会话绑定的模型配置（null = 回退系统默认模型） */
export class UpdateSessionModelDto {
  @ApiProperty({
    example: 'uuid',
    description: '模型配置ID；null/不传 = 使用系统默认模型',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsUUID('4', { message: '模型配置ID格式不正确' })
  modelConfigId?: string | null;
}
