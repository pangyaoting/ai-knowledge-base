import { reactive } from 'vue';

/**
 * 全局确认对话框（P1-6：替换 window.confirm）
 *
 * 用法（任意 async 函数内）：
 *   if (!(await confirmDialog('确定要删除吗？'))) return;
 *   if (!(await confirmDialog({ title: '危险操作', message: '...', danger: true }))) return;
 *
 * 与 toast 相同架构：模块级响应式状态 + 全局挂载的 <ConfirmDialogHost />（App.vue 已挂），
 * 组件内直接调用，无需 Pinia 上下文。
 */

export interface ConfirmDialogOptions {
  title?: string;
  message: string;
  /** 确认按钮文案，默认「删除」场景自动推断；显式传入覆盖 */
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（红色确认按钮），默认 true（绝大多数调用是删除/不可恢复） */
  danger?: boolean;
}

interface ConfirmDialogState {
  open: boolean;
  options: Required<Omit<ConfirmDialogOptions, 'message'>> & { message: string };
}

const state = reactive<ConfirmDialogState>({
  open: false,
  options: {
    title: '确认操作',
    message: '',
    confirmText: '确定',
    cancelText: '取消',
    danger: true,
  },
});

let resolver: ((ok: boolean) => void) | null = null;

/** 弹出确认框，返回用户选择（true=确认，false=取消）。支持字符串或完整配置 */
export function confirmDialog(opts: string | ConfirmDialogOptions): Promise<boolean> {
  const o = typeof opts === 'string' ? { message: opts } : opts;
  state.options = {
    title: '确认操作',
    confirmText: '确定',
    cancelText: '取消',
    danger: true,
    ...o,
  };
  state.open = true;
  return new Promise((resolve) => {
    resolver = resolve;
  });
}

/** 关闭并返回结果（组件内部与外部兜底共用） */
export function resolveConfirm(ok: boolean): void {
  state.open = false;
  const r = resolver;
  resolver = null;
  r?.(ok);
}

/** 供 ConfirmDialogHost 读取状态 */
export function useConfirmDialogState() {
  return state;
}
