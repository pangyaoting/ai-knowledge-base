// 用户信息
export interface UserInfo {
  id: string;
  email: string;
  nickname: string | null;
  avatar: string | null;
  totpEnabled?: boolean;
}

// 登录/注册返回
export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: UserInfo;
}

/** 登录第一步：开启 2FA 的用户返回 need2fa + loginToken，走第二步 */
export interface LoginStep1Result {
  need2fa: true;
  loginToken: string;
  user: { email: string };
}

/** 2FA 绑定材料 */
export interface TwoFactorSetup {
  secret: string;
  otpauthUrl: string;
}

/** 启用 2FA 后的一次性恢复码 */
export interface TwoFactorEnabled {
  recoveryCodes: string[];
}

// 登录参数
export interface LoginPayload {
  email: string;
  password: string;
}

// 注册参数
export interface RegisterPayload {
  email: string;
  password: string;
  nickname?: string;
}

// 统一响应格式
export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
}
