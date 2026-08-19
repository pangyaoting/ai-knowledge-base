// 用户信息
export interface UserInfo {
  id: string;
  email: string;
  nickname: string | null;
  avatar: string | null;
}

// 登录/注册返回
export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: UserInfo;
}

// 登录参数
export interface LoginPayload {
  email: string;
  password: string;
}

// 注册参数（邮箱 + 验证码 + 密码）
export interface RegisterPayload {
  email: string;
  code: string;
  password: string;
  nickname?: string;
}

// 统一响应格式
export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
}
