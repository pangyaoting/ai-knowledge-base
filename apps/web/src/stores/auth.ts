import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  login as loginApi,
  register as registerApi,
  logout as logoutApi,
  getProfile,
} from '@/api/auth';
import type { LoginPayload, RegisterPayload, UserInfo, AuthResult } from '@/types/auth';

export const useAuthStore = defineStore('auth', () => {
  // 状态
  const user = ref<UserInfo | null>(null);
  const accessToken = ref<string>(localStorage.getItem('accessToken') || '');
  const refreshToken = ref<string>(localStorage.getItem('refreshToken') || '');

  // 计算属性
  const isLoggedIn = computed(() => !!accessToken.value);

  // 保存 token
  function setTokens(access: string, refresh: string) {
    accessToken.value = access;
    refreshToken.value = refresh;
    localStorage.setItem('accessToken', access);
    localStorage.setItem('refreshToken', refresh);
  }

  // 清除登录状态
  function clearAuth() {
    user.value = null;
    accessToken.value = '';
    refreshToken.value = '';
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
  }

  // 登录（邮箱 + 密码，一步完成）
  async function login(payload: LoginPayload): Promise<AuthResult> {
    const result = await loginApi(payload);
    setTokens(result.accessToken, result.refreshToken);
    user.value = result.user;
    return result;
  }

  // 注册
  async function register(payload: RegisterPayload) {
    const result = await registerApi(payload);
    setTokens(result.accessToken, result.refreshToken);
    user.value = result.user;
    return result;
  }

  // 拉取用户信息
  async function fetchProfile() {
    const profile = await getProfile();
    user.value = profile;
    return profile;
  }

  // 登出
  async function logout() {
    try {
      if (refreshToken.value) {
        await logoutApi(refreshToken.value);
      }
    } finally {
      clearAuth();
    }
  }

  return {
    user,
    accessToken,
    refreshToken,
    isLoggedIn,
    login,
    register,
    fetchProfile,
    logout,
    clearAuth,
  };
});
