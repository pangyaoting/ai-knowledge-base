/**
 * 浏览器通知工具（P2-11：长任务完成提醒）
 *
 * - 仅在用户已授权时弹出，避免打扰；
 * - 已拒绝/不支持时静默降级（不抛错、不弹系统询问）。
 */

/** 当前是否已获得通知权限 */
export function notifySupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notifyGranted(): boolean {
  return notifySupported() && Notification.permission === 'granted';
}

/** 请求通知权限（用于用户点击"开始生成/创建任务"后调用） */
export async function ensureNotifyPermission(): Promise<boolean> {
  if (!notifySupported()) return false;
  try {
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const p = await Notification.requestPermission();
    return p === 'granted';
  } catch {
    return false;
  }
}

/** 弹出系统通知（未授权则静默跳过） */
export function notifyUser(title: string, body?: string): void {
  if (!notifyGranted()) return;
  try {
    const n = new Notification(title, {
      body,
      tag: 'kb-long-task',
    });
    // 点击通知聚焦到本窗口
    n.onclick = () => {
      window.focus();
      n.close();
    };
    // 部分浏览器自动关闭，避免堆积
    setTimeout(() => n.close(), 15000);
  } catch {
    // 静默降级：通知只是锦上添花，失败不影响主流程
  }
}
