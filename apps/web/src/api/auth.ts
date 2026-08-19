import request from './request';
import type {
  AuthResult,
  UserInfo,
  LoginPayload,
  RegisterPayload,
  LoginStep1Result,
  TwoFactorSetup,
  TwoFactorEnabled,
} from '@/types/auth';

// 登录（开启 2FA 的用户返回 need2fa + loginToken）
export function login(data: LoginPayload) {
  return request.post<unknown, AuthResult | LoginStep1Result>('/auth/login', data);
}

// 登录第二步：动态码 / 恢复码 → 正式 Token
export function login2fa(data: { loginToken: string; code: string }) {
  return request.post<unknown, AuthResult>('/auth/login/2fa', data);
}

// 注册
export function register(data: RegisterPayload) {
  return request.post<unknown, AuthResult>('/auth/register', data);
}

// 登出
export function logout(refreshToken: string) {
  return request.post('/auth/logout', { refreshToken });
}

// 获取当前用户信息
export function getProfile() {
  return request.get<unknown, UserInfo>('/auth/profile');
}

// ==================== 双因素认证（TOTP）====================

/** 生成 2FA 绑定材料（密钥 + otpauth URI） */
export function generate2fa() {
  return request.post<unknown, TwoFactorSetup>('/auth/2fa/generate');
}

/** 启用：校验动态码，返回一次性恢复码 */
export function enable2fa(code: string) {
  return request.post<unknown, TwoFactorEnabled>('/auth/2fa/enable', { code });
}

/** 实时校验当前动态码 */
export function verify2fa(code: string) {
  return request.post<unknown, { valid: boolean }>('/auth/2fa/verify', { code });
}

/** 关闭 2FA（需验证密码） */
export function disable2fa(password: string) {
  return request.post<unknown, { success: boolean }>('/auth/2fa/disable', { password });
}
