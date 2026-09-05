import { ref } from 'vue';
import { applyHighlightTheme } from '@/utils/highlight-theme';

const THEME_KEY = 'kb-theme';
type Theme = 'light' | 'dark';

const isDark = ref(false);

/** 应用当前主题到 <html>，并持久化（同时切换代码高亮主题） */
function applyTheme(theme: Theme) {
  isDark.value = theme === 'dark';
  document.documentElement.classList.toggle('dark', isDark.value);
  localStorage.setItem(THEME_KEY, theme);
  applyHighlightTheme(isDark.value);
}

/** 初始化主题：优先用户保存的选择，否则跟随系统偏好 */
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) as Theme | null;
  const prefersDark =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
  applyTheme(saved ?? (prefersDark ? 'dark' : 'light'));
}

function toggleTheme() {
  applyTheme(isDark.value ? 'light' : 'dark');
}

export function useTheme() {
  return { isDark, initTheme, toggleTheme };
}
