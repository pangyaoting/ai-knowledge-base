import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';
import { RedisService } from '../../common/redis/redis.service';

export type EmailCodeType = 'register' | 'forgot' | 'bind';

const CODE_PREFIX = 'email_code:'; // email_code:{type}:{email}
const CODE_TTL = 10 * 60; // 验证码 10 分钟有效
const RESEND_INTERVAL = 60; // 同一邮箱同一场景 60 秒内不能重发

/**
 * 邮箱验证码服务：
 * - 生成 6 位验证码，Redis 存储（10 分钟有效、60 秒重发限制）；
 * - 发送：配置了 SMTP（MAIL_HOST 等）→ 真实邮件；未配置 → 开发模式，验证码随响应返回
 *   （方便本地联调；生产环境配置 SMTP 后自动切换真实邮件，验证码绝不回传）。
 */
@Injectable()
export class EmailCodeService {
  private transporter: Transporter | null = null;

  constructor(
    private redis: RedisService,
    private configService: ConfigService,
  ) {
    const host = this.configService.get<string>('MAIL_HOST');
    if (host) {
      this.transporter = createTransport({
        host,
        port: Number(this.configService.get<string>('MAIL_PORT', '465')),
        secure: this.configService.get<string>('MAIL_SECURE', 'true') === 'true',
        auth: {
          user: this.configService.get<string>('MAIL_USER', ''),
          pass: this.configService.get<string>('MAIL_PASS', ''),
        },
      });
    }
  }

  /** 是否已配置 SMTP（false = 开发模式，验证码随响应返回） */
  get isConfigured(): boolean {
    return !!this.transporter;
  }

  /**
   * 发送验证码；返回 { sent: true }，开发模式额外带 code 供界面展示。
   * 60 秒内重发 → 抛错（防刷）。
   */
  async sendCode(email: string, type: EmailCodeType) {
    const key = CODE_PREFIX + type + ':' + email.toLowerCase();
    const lastSent = await this.redis.get(key + ':sent');
    if (lastSent) {
      throw new BadRequestException('验证码发送过于频繁，请稍后再试');
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await this.redis.set(key, code, 'EX', CODE_TTL);
    await this.redis.set(key + ':sent', String(Date.now()), 'EX', RESEND_INTERVAL);

    if (this.transporter) {
      const subject =
        type === 'register'
          ? '【AI 知识库】注册验证码'
          : type === 'forgot'
            ? '【AI 知识库】重置密码验证码'
            : '【AI 知识库】更换邮箱验证码';
      await this.transporter.sendMail({
        from: this.configService.get<string>('MAIL_FROM'),
        to: email,
        subject,
        html: `你的验证码是 <b>${code}</b>，10 分钟内有效。如非本人操作请忽略。`,
      });
      return { sent: true };
    }
    // 开发模式：未配置 SMTP，验证码随响应返回（生产绝不返回）
    return { sent: true, devMode: true, code };
  }

  /** 校验验证码并消费（一次性）：通过返回 true，否则抛错 */
  async verifyCode(email: string, type: EmailCodeType, code: string) {
    this.verifyOnly(email, type, code);
    const key = CODE_PREFIX + type + ':' + email.toLowerCase();
    await this.redis.del(key);
    await this.redis.del(key + ':sent');
    return true;
  }

  /**
   * 只校验不消费（不删键）：注册第一步"点下一步"时先验证邮箱唯一 + 验证码正确/未过期，
   * 验证码保留到第二步提交注册时再真正消费。
   */
  async verifyOnly(email: string, type: EmailCodeType, code: string) {
    const key = CODE_PREFIX + type + ':' + email.toLowerCase();
    const stored = await this.redis.get(key);
    if (!stored || stored !== code.trim()) {
      throw new BadRequestException('验证码错误或已过期');
    }
    return true;
  }
}
