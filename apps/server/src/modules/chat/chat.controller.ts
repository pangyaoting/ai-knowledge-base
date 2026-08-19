import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ChatService } from './chat.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionKbsDto } from './dto/update-session-kbs.dto';
import { UpdateSessionModelDto } from './dto/update-session-model.dto';
import { AskDto } from './dto/ask.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('对话')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // ==================== 会话管理 ====================

  @Get('sessions')
  @ApiOperation({ summary: '我的会话列表（可按标题/消息内容搜索）' })
  listSessions(@CurrentUser('id') userId: string, @Query('q') q?: string) {
    return this.chatService.listSessions(userId, q);
  }

  @Post('sessions')
  @ApiOperation({ summary: '新建会话' })
  createSession(@CurrentUser('id') userId: string, @Body() dto: CreateSessionDto) {
    return this.chatService.createSession(userId, dto);
  }

  @Get('sessions/:id/messages')
  @ApiOperation({ summary: '会话历史消息' })
  getMessages(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) sessionId: string) {
    return this.chatService.getMessages(userId, sessionId);
  }

  @Delete('sessions/:id')
  @ApiOperation({ summary: '删除会话' })
  removeSession(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) sessionId: string) {
    return this.chatService.removeSession(userId, sessionId);
  }

  @Patch('sessions/:id/knowledge-bases')
  @ApiOperation({ summary: '修改会话绑定的知识库（问答范围）' })
  updateKnowledgeBases(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Body() dto: UpdateSessionKbsDto,
  ) {
    return this.chatService.updateSessionKnowledgeBases(
      userId,
      sessionId,
      dto.knowledgeBaseIds ?? [],
      dto.useKnowledgeBase ?? true,
    );
  }

  @Patch('sessions/:id/model')
  @ApiOperation({ summary: '修改会话绑定的模型配置（BYO key；null = 系统默认）' })
  updateSessionModel(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Body() dto: UpdateSessionModelDto,
  ) {
    return this.chatService.updateSessionModel(userId, sessionId, dto.modelConfigId);
  }

  @Get('sessions/:id/export')
  @ApiOperation({ summary: '导出会话为 Markdown 文件' })
  async exportSession(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Res() res: Response,
  ) {
    const { filename, content } = await this.chatService.exportSession(userId, sessionId);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(content);
  }

  // ==================== RAG 问答（SSE 流式） ====================

  @Post('sessions/:id/messages')
  @HttpCode(HttpStatus.OK) // SSE 流返回 200（NestJS 默认 POST 是 201，SSE 语义应为 200）
  @ApiOperation({ summary: '提问（SSE 流式回答）' })
  async ask(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Body() dto: AskDto,
    @Res() res: Response,
  ) {
    // 先校验会话归属（此时还没写 SSE 头，出错会被全局过滤器转成 JSON 错误）
    await this.chatService.getSession(userId, sessionId);

    // 进入 SSE 模式
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 兼容 Nginx
    res.flushHeaders();

    // SSE 事件写入器
    const write = (event: string, data: unknown) => {
      res.write(`data: ${JSON.stringify({ event, data })}\n\n`);
    };

    try {
      // 客户端断开时 abort（由 ChatService 里监听 signal）
      const abortController = new AbortController();
      res.on('close', () => abortController.abort());

      await this.chatService.askAndStream(
        userId,
        sessionId,
        dto.content,
        dto.useWebSearch ?? false,
        (event, data) => write(event, data),
        abortController.signal,
      );
      res.end();
    } catch (err) {
      // 流中出错：发 error 事件优雅结束，不把连接挂死
      const message = (err as Error).message || '服务器错误';
      write('error', { message });
      res.end();
    }
  }
}
