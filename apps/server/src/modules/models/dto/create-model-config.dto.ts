import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateModelConfigDto {
  @ApiProperty({ example: '我的 DeepSeek', description: '配置备注名' })
  @IsString({ message: '名称格式不正确' })
  @IsNotEmpty({ message: '请填写名称' })
  @MaxLength(50, { message: '名称最多50个字符' })
  name!: string;

  @ApiProperty({
    example: 'https://api.deepseek.com',
    description: 'OpenAI 兼容接口地址',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '接口地址格式不正确' })
  @IsUrl(
    { require_protocol: true, protocols: ['http', 'https'] },
    { message: '接口地址必须是 http(s) 链接' },
  )
  @MaxLength(200, { message: '接口地址最多200个字符' })
  baseURL?: string;

  @ApiProperty({ example: 'sk-xxxx', description: 'API Key（加密存储，永不返回明文）' })
  @IsString({ message: 'API Key 格式不正确' })
  @IsNotEmpty({ message: '请填写 API Key' })
  apiKey!: string;

  @ApiProperty({ example: 'deepseek-chat', description: '默认模型名' })
  @IsString({ message: '模型名格式不正确' })
  @IsNotEmpty({ message: '请填写模型名' })
  @MaxLength(100, { message: '模型名最多100个字符' })
  model!: string;

  @ApiProperty({
    example: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash-vision-exp'],
    description: '该 Key 下的全部模型名（同一配置可挂多个模型，对话页下拉切换）',
    required: false,
  })
  @IsOptional()
  @IsArray({ message: 'models 格式不正确' })
  @ArrayMaxSize(20, { message: '一个配置最多 20 个模型' })
  @IsString({ each: true, message: '模型名格式不正确' })
  models?: string[];

  @ApiProperty({ example: false, description: '是否设为默认（新建会话默认使用）', required: false })
  @IsOptional()
  @IsBoolean({ message: 'isDefault 格式不正确' })
  isDefault?: boolean;
}
