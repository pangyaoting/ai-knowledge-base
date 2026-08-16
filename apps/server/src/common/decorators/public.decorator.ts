import { SetMetadata } from '@nestjs/common';

/**
 * 标记某个接口为公开接口，不需要登录就能访问
 * 用法：@Public() 加在 Controller 方法上
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
