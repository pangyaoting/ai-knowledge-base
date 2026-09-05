/**
 * 文件图标工具：按扩展名着色 + 徽标 + 图标类别（html/css/ts…）
 */
import { File as FileIcon, FileText, FileCode, FileImage, FileArchive } from 'lucide-vue-next';

const EXT_COLORS: Record<string, string> = {
  html: '#e44d26',
  htm: '#e44d26',
  css: '#2965f1',
  scss: '#c6538c',
  less: '#1d365d',
  ts: '#3178c6',
  tsx: '#3178c6',
  js: '#d9b225',
  jsx: '#d9b225',
  vue: '#42b883',
  json: '#b58a00',
  py: '#3572a5',
  java: '#b07219',
  go: '#00add8',
  rs: '#dea584',
  c: '#5a5a5a',
  cpp: '#f34b7d',
  h: '#5a5a5a',
  hpp: '#f34b7d',
  sh: '#4eaa25',
  bash: '#4eaa25',
  yml: '#cb171e',
  yaml: '#cb171e',
  toml: '#9c4221',
  sql: '#e38c00',
  md: '#519aba',
  markdown: '#519aba',
  txt: '#8a94a6',
  pdf: '#e74c3c',
  docx: '#2b579a',
  png: '#e91e8c',
  jpg: '#e91e8c',
  jpeg: '#e91e8c',
  gif: '#e91e8c',
  webp: '#e91e8c',
  svg: '#e91e8c',
  ico: '#e91e8c',
  zip: '#d4a017',
  rar: '#d4a017',
  '7z': '#d4a017',
  tar: '#d4a017',
  gz: '#d4a017',
};

export function fileExtOf(name: string): string {
  return (name.split('.').pop() ?? '').toLowerCase();
}

export function fileColorOf(name: string): string {
  return EXT_COLORS[fileExtOf(name)] ?? '#8a94a6';
}

/**
 * Material Icon Theme 风格徽标：品牌色实底 + 缩写/符号（TS/VUE/JSON→{}…）。
 * 识别不到的扩展名返回 null（调用方回退 lucide 图标）。
 */
const EXT_BADGES: Record<string, string> = {
  ts: 'TS',
  tsx: 'TS',
  js: 'JS',
  jsx: 'JS',
  vue: 'VUE',
  html: 'H5',
  htm: 'H5',
  css: 'CSS',
  scss: 'SCSS',
  less: 'LESS',
  json: '{}',
  md: 'MD',
  markdown: 'MD',
  py: 'PY',
  java: 'JAVA',
  go: 'GO',
  rs: 'RS',
  c: 'C',
  cpp: 'C++',
  h: 'H',
  hpp: 'H++',
  sh: '>_',
  bash: '>_',
  yml: 'YML',
  yaml: 'YML',
  toml: 'TOML',
  sql: 'SQL',
  pdf: 'PDF',
  txt: 'TXT',
  zip: 'ZIP',
  rar: 'RAR',
  gz: 'GZ',
};

export interface FileBadge {
  text: string;
  color: string;
  /** 底是浅色（如 JS 黄）时用深色字，否则白字 */
  darkText: boolean;
}

export function fileBadgeOf(name: string): FileBadge | null {
  const ext = fileExtOf(name);
  const text = EXT_BADGES[ext];
  if (!text) return null;
  const color = EXT_COLORS[ext] ?? '#8a94a6';
  return { text, color, darkText: isLightHex(color) };
}

/** hex 颜色亮度判断（>0.7 视为浅色，配深色文字） */
function isLightHex(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  // 相对亮度（sRGB 近似）
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62;
}

/** 按扩展名返回图标类别（代码/图片/压缩包/文档） */
export function fileIconOf(name: string) {
  const t = fileExtOf(name);
  if (
    /^(ts|tsx|js|jsx|vue|html?|css|s[ca]ss|less|json|py|java|go|rs|c|cpp|h|hpp|sh|bash|ya?ml|toml|ini|sql|xml|proto|graphql|prisma|env)$/.test(
      t,
    )
  ) {
    return FileCode;
  }
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico|avif|pdf)$/.test(t)) {
    return FileImage;
  }
  if (/^(zip|rar|7z|tar|gz|bz2|xz)$/.test(t)) {
    return FileArchive;
  }
  if (/^(md|markdown|txt|docx)$/.test(t)) {
    return FileText;
  }
  return FileIcon;
}
