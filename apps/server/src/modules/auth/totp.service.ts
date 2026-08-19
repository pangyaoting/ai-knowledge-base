import { Injectable } from '@nestjs/common';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { createHash, randomBytes } from 'node:crypto';

const RECOVERY_COUNT = 8; // 恢复码数量（一次性，防丢手机）

/**
 * TOTP 双因素认证封装（RFC 6238，Google Authenticator 兼容，otplib v13）：
 * - 生成 base32 密钥 / otpauth:// URI（验证器 App 扫码或手动输入）
 * - 校验 6 位动态码（30s 一变，tolerance=30s 容忍前后各一个时间窗，防设备时钟偏差）
 * - 恢复码：8 个随机 xxxx-xxxx 码，服务端只存 sha256 哈希，登录时可当验证码用一次
 */
@Injectable()
export class TotpService {
  /** 生成 base32 密钥 */
  generateSecret(): string {
    return generateSecret();
  }

  /** 生成 otpauth:// 链接（App 扫码） */
  buildUri(secret: string, account: string, issuer = 'AI 知识库'): string {
    return generateURI({ issuer, label: account, secret });
  }

  /** 校验动态码（epochTolerance=30s 容忍前后各一个时间窗，防设备时钟偏差） */
  verify(secret: string, code: string): boolean {
    if (!secret || !/^\d{6}$/.test(code)) return false;
    try {
      // 注意：verifySync 返回 { valid: boolean } 对象（永远 truthy），必须取 .valid
      return verifySync({ token: code, secret, epochTolerance: 30 }).valid === true;
    } catch {
      return false;
    }
  }

  /** 生成 8 个恢复码（形如 xxxx-xxxx，一次展示后服务端只存哈希） */
  generateRecoveryCodes(count = RECOVERY_COUNT): string[] {
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const hex = randomBytes(4).toString('hex').toUpperCase();
      codes.push(`${hex.slice(0, 4)}-${hex.slice(4)}`);
    }
    return codes;
  }

  /** 恢复码哈希（服务端只存哈希；码本身高熵随机，无需加盐） */
  hashRecovery(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  /** 校验恢复码：命中则从数组中移除该码（一次性） */
  consumeRecoveryCode(storedHashes: string[], code: string): { hashes: string[]; ok: boolean } {
    const normalized = code.trim().toUpperCase();
    const hashes = Array.isArray(storedHashes) ? [...storedHashes] : [];
    const idx = hashes.findIndex((h) => h === this.hashRecovery(normalized));
    if (idx === -1) return { hashes, ok: false };
    hashes.splice(idx, 1);
    return { hashes, ok: true };
  }
}
