import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * 从请求中获取当前登录用户
 * 用法：在 Controller 方法参数里写 @CurrentUser() user: JwtPayload
 */
export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    return data ? user?.[data] : user;
  },
);
