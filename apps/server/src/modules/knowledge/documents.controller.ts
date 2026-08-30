import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { DocumentsService } from './documents.service';
import { UpdateDocumentDto } from './dto/update-document.dto';
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
  // 上传是批量操作（目录可能几百上千个文件），按"请求次数"限流会误伤，豁免全局 60/min 限流
  @SkipThrottle()
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
          description:
            '文档/代码/项目目录均可（md/txt/pdf/docx/代码文件参与检索，其余类型作为附件保管；单文件大小由 .env 的 MAX_FILE_SIZE_MB 控制，默认 20MB）',
        },
      },
    },
  })
  upload(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) knowledgeBaseId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    // 可选：自定义文档名（目录上传时前端把相对路径放这里，绕过浏览器对文件名的路径剥离）
    @Body('name') name?: string,
  ) {
    return this.documentsService.upload(userId, knowledgeBaseId, file, name);
  }

  @Get(':id/documents')
  @ApiOperation({ summary: '知识库的文档列表' })
  findAll(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) knowledgeBaseId: string) {
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

  @Get(':id/documents/:documentId/content')
  @ApiOperation({ summary: '获取文档可编辑文本内容（重新解析原文件）' })
  getContent(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) knowledgeBaseId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.documentsService.getContent(userId, knowledgeBaseId, documentId);
  }

  @Get('documents/:documentId/chunks')
  @ApiOperation({ summary: '获取文档文本块列表（预览 + 引用定位，按 documentId 直接取）' })
  getChunks(
    @CurrentUser('id') userId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.documentsService.getChunks(userId, documentId);
  }

  @Patch(':id/documents/:documentId')
  // 目录重命名 = 批量改名（一次可能几十上百个 PATCH），豁免全局限流
  @SkipThrottle()
  @ApiOperation({ summary: '编辑文档（改名 / 改内容后重新分块向量化）' })
  updateContent(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) knowledgeBaseId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: UpdateDocumentDto,
  ) {
    return this.documentsService.updateContent(userId, knowledgeBaseId, documentId, dto);
  }

  @Delete(':id/documents/:documentId')
  // 目录删除 = 批量删除（一次可能几百上千个 DELETE），豁免全局限流
  @SkipThrottle()
  @ApiOperation({ summary: '删除文档（级联删除其 chunk 和磁盘文件）' })
  remove(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) knowledgeBaseId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.documentsService.remove(userId, knowledgeBaseId, documentId);
  }
}
