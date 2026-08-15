import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global() // 全局模块，其他模块不用再 import 就能直接注入 PrismaService
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
