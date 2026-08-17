import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { DocumentsService } from './documents.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('文档')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('knowledge')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post(':id/documents')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(), // 先放内存，校验通过后才落盘（避免非法文件写盘）
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB，超过会抛 MulterError
    }),
  )
  @ApiOperation({ summary: '上传文档（自动解析 + 分块入库）' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary', description: 'PDF/Word/Markdown/TXT，≤10MB' },
      },
    },
  })
  upload(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) knowledgeBaseId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.documentsService.upload(userId, knowledgeBaseId, file);
  }

  @Get(':id/documents')
  @ApiOperation({ summary: '知识库的文档列表' })
  findAll(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) knowledgeBaseId: string,
  ) {
    return this.documentsService.findAll(userId, knowledgeBaseId);
  }

  @Delete(':id/documents/:documentId')
  @ApiOperation({ summary: '删除文档（级联删除其 chunk 和磁盘文件）' })
  remove(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) knowledgeBaseId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.documentsService.remove(userId, knowledgeBaseId, documentId);
  }
}
