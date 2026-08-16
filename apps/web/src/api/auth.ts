import request from './request';
import type { AuthResult, UserInfo, LoginPayload, RegisterPayload } from '@/types/auth';

// 登录
export function login(data: LoginPayload) {
  return request.post<unknown, AuthResult>('/auth/login', data);
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
