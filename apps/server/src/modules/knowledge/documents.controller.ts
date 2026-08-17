import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { DocumentsService } from './documents.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

// multer 的兜底上限（装饰器在类加载时求值，读不到运行期的 ConfigService，
// 所以这里给一个宽松固定值；真正的限制在 documents.service 里按 .env 的 MAX_FILE_SIZE_MB 校验）
const MULTER_FILE_LIMIT = 50 * 1024 * 1024;

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
      limits: { fileSize: MULTER_FILE_LIMIT },
    }),
  )
  @ApiOperation({ summary: '上传文档（自动解析 + 分块入库）' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'PDF/Word/Markdown/TXT（大小限制由 .env 的 MAX_FILE_SIZE_MB 控制，默认 20MB）',
        },
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

  @Get(':id/documents/:documentId/file')
  @ApiOperation({ summary: '下载/查看文档原文件' })
  async downloadFile(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) knowledgeBaseId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Res() res: Response,
  ) {
    const { filename, absPath } = await this.documentsService.getFile(
      userId,
      knowledgeBaseId,
      documentId,
    );
    // RFC 5987 编码文件名，中文文件名不乱码
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.sendFile(absPath);
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
