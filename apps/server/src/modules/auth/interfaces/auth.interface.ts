/**
 * JWT Token 中存储的用户信息
 */
export interface JwtPayload {
  sub: string; // 用户 ID
  email: string;
  nickname?: string | null;
}

/**
 * 登录/刷新成功后返回给前端的数据
 */
export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    nickname: string | null;
    avatar: string | null;
  };
}
