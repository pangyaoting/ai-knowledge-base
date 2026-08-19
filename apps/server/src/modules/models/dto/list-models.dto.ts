import { IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** 探测模型列表（创建时传 baseURL+apiKey；编辑时传 configId 用已存 Key） */
export class ListModelsDto {
  @ApiPropertyOptional({
    example: 'https://api.deepseek.com',
    description: '接口地址（与 apiKey 二选一配 configId）',
  })
  @IsOptional()
  @IsString()
  baseURL?: string;

  @ApiPropertyOptional({
    example: 'sk-xxx',
    description: 'API Key（与 baseURL 二选一配 configId）',
  })
  @IsOptional()
  @IsString()
  apiKey?: string;

  @ApiPropertyOptional({ description: '已有配置 id：用其已存的 baseURL + 解密后的 Key 探测' })
  @IsOptional()
  @IsUUID()
  configId?: string;
}
