import { reactive } from 'vue';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  duration: number; // 毫秒；0 = 不自动关闭
}

// 模块级响应式状态：任何组件/非组件代码都能用，无需 Pinia 上下文
const state = reactive<{ toasts: ToastItem[] }>({ toasts: [] });

let seed = 0;

function push(type: ToastType, message: string, duration?: number) {
  const id = ++seed;
  state.toasts.push({
    id,
    type,
    message,
    duration: duration ?? (type === 'error' ? 5000 : 3000),
  });
  const item = state.toasts.find((t) => t.id === id);
  if (item && item.duration > 0) {
    setTimeout(() => dismiss(id), item.duration);
  }
}

function dismiss(id: number) {
  const idx = state.toasts.findIndex((t) => t.id === id);
  if (idx >= 0) state.toasts.splice(idx, 1);
}

/** 全站 Toast 反馈：toast.success('已保存') / toast.error('出错了') / toast.info('提示') */
export const toast = {
  success: (message: string, duration?: number) => push('success', message, duration),
  error: (message: string, duration?: number) => push('error', message, duration),
  info: (message: string, duration?: number) => push('info', message, duration),
  dismiss,
};

/** 供 ToastContainer 读取状态 */
export function useToastState() {
  return state;
}
