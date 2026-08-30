import { ArrayMaxSize, IsArray, IsInt, IsOptional, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ConfirmAgentTaskDto {
  @ApiProperty({
    example: [0, 2, 4, 6, 8],
    description: '选中的方向下标（对应方向列表顺序），1~5 个；省略 = 保留全部方向',
    required: false,
  })
  @IsOptional()
  @IsArray({ message: 'directionIndexes 必须是数组' })
  @ArrayMaxSize(10, { message: '最多选择 10 个方向' })
  @IsInt({ each: true, message: '方向下标必须是整数' })
  @Min(0, { each: true, message: '方向下标不能为负' })
  directionIndexes?: number[];
}
