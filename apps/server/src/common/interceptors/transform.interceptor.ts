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
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, { code: number; message: string; data: T }> {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<{ code: number; message: string; data: T }> {
    return next.handle().pipe(
      map((data) => ({
        code: 0,
        message: 'success',
        data,
      })),
    );
  }
}
