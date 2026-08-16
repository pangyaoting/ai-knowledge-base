import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import type { ApiResponse } from '@/types/auth';

const request: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 15000,
});

// 是否正在刷新 token（防止并发请求同时刷新）
let isRefreshing = false;
// 等待 token 刷新的请求队列
let pendingQueue: Array<(token: string) => void> = [];

// 请求拦截器：自动带上 accessToken
request.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = localStorage.getItem('accessToken');
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error),
);

// 响应拦截器：统一解包 + 401 自动刷新 token
request.interceptors.response.use(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (response): any => {
    // 后端统一返回 { code, message, data }，直接解包返回 data
    const res = response.data as ApiResponse;
    if (res.code !== 0) {
      return Promise.reject(new Error(res.message || '请求失败'));
    }
    return res.data;
  },
  async (error) => {
    const originalRequest = error.config;

    // 如果是 401 且不是刷新 token 的请求、且没有重试过
    if (error.response?.status === 401 && !originalRequest._retry) {
      // 如果已经在刷新，把当前请求加入队列等待
      if (isRefreshing) {
        return new Promise((resolve) => {
          pendingQueue.push((token: string) => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            resolve(request(originalRequest));
          });
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const refreshToken = localStorage.getItem('refreshToken');
        if (!refreshToken) {
          throw new Error('no refresh token');
        }

        // 用 refreshToken 换新的 accessToken（用原生 axios 避免拦截器死循环）
        const { data } = await axios.post('/api/auth/refresh', { refreshToken });
        const accessToken = data.data.accessToken as string;

        localStorage.setItem('accessToken', accessToken);

        // 执行队列中等待的请求
        pendingQueue.forEach((cb) => cb(accessToken));
        pendingQueue = [];

        // 重发原来的请求
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return request(originalRequest);
      } catch (refreshError) {
        // refreshToken 也过期了，清除登录状态，跳登录页
        pendingQueue = [];
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        window.location.href = '/login';
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    // 其他错误直接抛出
    const message = error.response?.data?.message || error.message || '网络错误';
    return Promise.reject(new Error(message));
  },
);

export default request;
