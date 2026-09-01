import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateModelConfigDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString({ message: '名称格式不正确' })
  @MaxLength(50, { message: '名称最多50个字符' })
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl(
    { require_protocol: true, protocols: ['http', 'https'] },
    { message: '接口地址必须是 http(s) 链接' },
  )
  @MaxLength(200, { message: '接口地址最多200个字符' })
  baseURL?: string;

  @ApiProperty({ required: false, description: '新 API Key（不传则保留原 key）' })
  @IsOptional()
  @IsString({ message: 'API Key 格式不正确' })
  apiKey?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString({ message: '模型名格式不正确' })
  @MaxLength(100, { message: '模型名最多100个字符' })
  model?: string;

  @ApiProperty({ required: false, description: '该 Key 下的全部模型名' })
  @IsOptional()
  @IsArray({ message: 'models 格式不正确' })
  @ArrayMaxSize(20, { message: '一个配置最多 20 个模型' })
  @IsString({ each: true, message: '模型名格式不正确' })
  models?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean({ message: 'isDefault 格式不正确' })
  isDefault?: boolean;
}
