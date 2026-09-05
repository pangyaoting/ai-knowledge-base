/**
 * 复制文本工具：优先现代 clipboard API，失败降级老式 execCommand。
 * 为什么需要降级：navigator.clipboard 只在 HTTPS / localhost（安全上下文）可用，
 * 纯 http:// 部署（如备案前用 IP 访问）会被浏览器禁用 → 抛错；
 * document.execCommand('copy') 老 API 在 http 下仍可用，作为兜底。
 */
export async function copyText(text: string): Promise<boolean> {
  // 1. 现代 API（安全上下文）
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    throw new Error('clipboard API 不可用');
  } catch {
    // 2. 降级：临时 textarea + execCommand（http 环境可用）
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      // 移出视口且不可见（不能 display:none，否则 select() 无效）
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
