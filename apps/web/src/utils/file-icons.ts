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
