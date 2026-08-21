import request from './request';
import type { AuthResult, UserInfo, LoginPayload, RegisterPayload } from '@/types/auth';

// 发送邮箱验证码（register 注册 / forgot 忘记密码 / bind 更换邮箱）
export function sendCode(email: string, type: 'register' | 'forgot' | 'bind') {
  return request.post<unknown, { sent: boolean; devMode?: boolean; code?: string }>(
    '/auth/send-code',
    { email, type },
  );
}

// 登录（邮箱 + 密码，无验证码环节）
export function login(data: LoginPayload) {
  return request.post<unknown, AuthResult>('/auth/login', data);
}

// 校验验证码（只校验不消费：注册第一步"点下一步"先验证邮箱唯一 + 验证码有效）
export function verifyCode(data: {
  email: string;
  type: 'register' | 'forgot' | 'bind';
  code: string;
}) {
  return request.post<unknown, { success: boolean }>('/auth/verify-code', data);
}

// 注册（邮箱 + 验证码 + 密码）
export function register(data: RegisterPayload) {
  return request.post<unknown, AuthResult>('/auth/register', data);
}

// 忘记密码（邮箱 + 验证码 → 设置新密码）
export function forgotPassword(data: { email: string; code: string; newPassword: string }) {
  return request.post<unknown, { success: boolean }>('/auth/forgot-password', data);
}

// 更换邮箱绑定（验证新邮箱 + 验证码）
export function bindEmail(data: { email: string; code: string }) {
  return request.post<unknown, UserInfo>('/auth/bind-email', data);
}

// 登出
export function logout(refreshToken: string) {
  return request.post('/auth/logout', { refreshToken });
}

// 获取当前用户信息
export function getProfile() {
  return request.get<unknown, UserInfo>('/auth/profile');
}
