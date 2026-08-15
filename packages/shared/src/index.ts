/**
 * 前后端共享类型定义
 * 后端 DTO 和前端 API 调用都可以引用这里的类型，保证类型一致
 */

// 统一响应格式
export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
}

// 分页响应
export interface PaginatedResponse<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}
