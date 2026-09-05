import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { AVATAR_DIR } from './common/paths';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('SERVER_PORT', 3000);

  // 全局路由前缀
  app.setGlobalPrefix('api');

  // 用户头像静态目录（与知识库附件分开：附件保持鉴权，头像公开可访问）。
  // 不直接 import express（pnpm 严格依赖会报错），用 app.use 挂一个简单静态处理器。
  const avatarDir = AVATAR_DIR;
  // Express 中间件签名（Nest 的 use 接收 any[]；因 pnpm 严格依赖不能 import express 类型）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use('/avatars', (req: any, res: any) => {
    const name = String(req.path ?? '').replace(/^\/+/, '');
    if (!/^[\w-]+\.(png|jpeg|jpg|webp)$/i.test(name)) {
      res.status(404).end();
      return;
    }
    res.sendFile(join(avatarDir, name), (err: unknown) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  // CORS：允许前端开发服务器跨域
  app.enableCors({
    origin: ['http://localhost:5173', 'http://localhost:4173'],
    credentials: true,
  });

  // 全局参数校验管道
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // 自动剥离 DTO 未定义的属性
      transform: true, // 自动类型转换
      forbidNonWhitelisted: true, // 出现未定义属性直接报错
    }),
  );

  // 全局异常过滤器 + 统一响应格式拦截器
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  // Swagger 接口文档：http://localhost:3000/api/docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('AI 知识库 API')
    .setDescription('AI 知识库问答平台接口文档')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(port);
  logger.log(`后端服务已启动: http://localhost:${port}`);
  logger.log(`Swagger 文档: http://localhost:${port}/api/docs`);
}

bootstrap();
