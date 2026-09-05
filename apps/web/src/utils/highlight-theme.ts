/**
 * 代码高亮主题动态切换：亮色用 Atom One Light、暗色用 Atom One Dark（VSCode 同款配色）。
 * 为什么动态注入而不是静态 import：highlight.js 的主题 css 是全局 .hljs-xxx 规则，
 * 静态 import 两个会互相覆盖且无法跟随 UI 主题；用 <link> 按当前主题切换，保证
 * 亮/暗模式 token 色都丰富可区分（接近 VSCode 的代码着色体验）。
 */
import darkCss from 'highlight.js/styles/atom-one-dark.css?url';
import lightCss from 'highlight.js/styles/atom-one-light.css?url';

const THEME_LINK_ID = 'hljs-theme-link';

/** 按当前 UI 主题设置代码高亮主题（无副作用：重复调用只更新 href） */
export function applyHighlightTheme(isDark: boolean): void {
  if (typeof document === 'undefined') return;
  let link = document.getElementById(THEME_LINK_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = THEME_LINK_ID;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  link.href = isDark ? darkCss : lightCss;
}
