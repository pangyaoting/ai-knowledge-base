import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * 统一响应格式拦截器
 * Controller return 的数据会被包装成 { code: 0, message: 'success', data: ... }
 * 例外：SSE 流式接口（response 已开始写出）跳过包装，保持 text/event-stream 协议
 */
@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, { code: number; message: string; data: T }>
{
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<{ code: number; message: string; data: T }> {
    const response = context.switchToHttp().getResponse();
    // 响应已开始写出（SSE 或手动管理），不包装
    if (response.headersSent) {
      return next.handle() as Observable<{ code: number; message: string; data: T }>;
    }
    return next.handle().pipe(
      map((data) => ({
        code: 0,
        message: 'success',
        data,
      })),
    );
  }
}
