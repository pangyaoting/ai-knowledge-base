import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { MulterError } from 'multer';

/**
 * 全局异常过滤器：统一错误响应格式
 * 所有异常都会被捕获，返回 { code, message, data: null } 格式
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = '服务器内部错误';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      // class-validator 的校验错误是一个对象，取其中的 message
      message =
        typeof res === 'string'
          ? res
          : (res as Record<string, unknown>).message instanceof Array
            ? ((res as Record<string, unknown>).message as string[]).join('; ')
            : ((res as Record<string, unknown>).message as string) || exception.message;
    } else if (exception instanceof MulterError) {
      // 文件上传错误（multer 抛的），给友好提示而不是 500
      status = HttpStatus.BAD_REQUEST;
      message =
        exception.code === 'LIMIT_FILE_SIZE'
          ? '文件过大，不能超过 10MB'
          : `上传错误: ${exception.message}`;
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(`未处理的异常: ${exception.stack}`);
    }

    response.status(status).json({
      code: status,
      message,
      data: null,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
