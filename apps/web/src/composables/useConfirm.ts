import { reactive } from 'vue';

/**
 * 全局确认对话框（P1-6：替换 window.confirm）
 *
 * 用法（任意 async 函数内）：
 *   if (!(await confirmDialog('确定要删除吗？'))) return;
 *   if (!(await confirmDialog({ title: '危险操作', message: '...', danger: true }))) return;
 *   const name = await promptDialog({ title: '重命名', message: '输入新名称：', initial: oldName });
 *   if (name == null) return; // 取消
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

export interface PromptDialogOptions {
  title?: string;
  message?: string;
  /** 输入框预填值 */
  initial?: string;
  placeholder?: string;
  /** 确认按钮文案 */
  confirmText?: string;
  cancelText?: string;
}

interface ConfirmDialogState {
  open: boolean;
  options: Required<Omit<ConfirmDialogOptions, 'message'>> & { message: string };
  /** 输入模式（promptDialog）：显示一个文本框，确认返回输入值 */
  inputMode: boolean;
  inputText: string;
  inputPlaceholder: string;
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
  inputMode: false,
  inputText: '',
  inputPlaceholder: '',
});

type Resolver = ((value: boolean) => void) | ((value: string | null) => void);
let resolver: Resolver | null = null;

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
  state.inputMode = false;
  state.open = true;
  return new Promise((resolve) => {
    resolver = resolve as Resolver;
  });
}

/** 弹出带输入框的对话框（P2-2：替换 window.prompt）。确认返回输入值（去首尾空白）；取消/关闭返回 null */
export function promptDialog(opts: PromptDialogOptions | string): Promise<string | null> {
  const o = typeof opts === 'string' ? { title: '输入', message: opts } : opts;
  state.options = {
    title: o.title ?? '输入',
    message: o.message ?? '',
    confirmText: o.confirmText ?? '确定',
    cancelText: o.cancelText ?? '取消',
    danger: false,
  };
  state.inputMode = true;
  state.inputText = o.initial ?? '';
  state.inputPlaceholder = o.placeholder ?? '';
  state.open = true;
  return new Promise((resolve) => {
    resolver = resolve as Resolver;
  });
}

/** 关闭并返回结果（组件内部与外部兜底共用） */
export function resolveConfirm(ok: boolean): void {
  state.open = false;
  const r = resolver;
  resolver = null;
  if (r) (r as (value: boolean) => void)(ok);
}

/** 关闭并返回输入值（null = 取消） */
export function resolvePrompt(value: string | null): void {
  state.open = false;
  const r = resolver;
  resolver = null;
  if (r) (r as (value: string | null) => void)(value);
}

/** 供 ConfirmDialogHost 读取状态 */
export function useConfirmDialogState() {
  return state;
}
