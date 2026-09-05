/**
 * 文档解析工具：把上传的文件变成纯文本
 *
 * 支持类型（与前端约定一致）：
 * - pdf  : pdf-parse（服务端轻量提取）
 * - docx : mammoth（微软 Word 格式）
 * - md   : 直接读（Markdown 本身就是文本）
 * - txt  : 直接读
 * - code : 代码/配置文件（ts/vue/js/html/css/py/json…），按纯文本读，
 *          分块用代码专用分块器（按行、空行边界），并跳过图谱抽取
 *
 * 边界说明（面试可讲"我清楚技术边界"）：
 * - .doc 老格式不支持（需要 COM 调用，成本高），前端提示转 .docx
 * - PDF 里纯图片内容（扫描件）提取不到文字 → 会报"未能提取到文本"
 * - OCR 识别图片文字留作扩展
 * - 不在识别清单内的文件（图片/二进制/未知扩展名）由上传服务作为"附件"原样保管，
 *   不参与解析与检索（detectFileType 返回 null）
 */
import pdfParse from 'pdf-parse';
import * as mammoth from 'mammoth';

export type DocType = 'pdf' | 'docx' | 'md' | 'txt' | 'code';

/** 代码/配置文件扩展名（大小写不敏感，比较前已 lower） */
const CODE_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'vue',
  'html',
  'css',
  'scss',
  'less',
  'json',
  'py',
  'java',
  'go',
  'rs',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'sh',
  'bash',
  'zsh',
  'yml',
  'yaml',
  'toml',
  'sql',
  'xml',
  'svg',
  'ini',
  'conf',
  'cfg',
  'proto',
  'graphql',
  'prisma',
  'dockerfile',
  'makefile',
  'env',
  'lock',
  'gitignore',
]);

/** 根据文件名判断文件类型：可解析返回对应类型，无法解析（附件）返回 null */
export function detectFileType(filename: string): DocType | null {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'txt') return 'txt';
  if (CODE_EXTS.has(ext)) return 'code';
  return null;
}

/** 提取纯文本 */
export async function extractText(buffer: Buffer, fileType: DocType): Promise<string> {
  switch (fileType) {
    case 'pdf': {
      const result = await pdfParse(buffer);
      return result.text;
    }
    case 'docx': {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    case 'md':
    case 'txt':
    case 'code':
      return buffer.toString('utf-8');
    default:
      throw new Error(`不支持的文件类型: ${fileType}`);
  }
}

/**
 * 删除文本中的 C0 控制字符（保留 \t \n）。
 * 为什么必要：PostgreSQL 的 text 类型明文禁止 \u0000（NUL），含 NUL 的字符串落库会报
 * 22P05 "unsupported Unicode escape sequence"；二进制/损坏文件解出来的文本常夹带这类不可见字符。
 * 所有要进数据库的文本（知识库入库、对话上传、消息落库）都应先过这一层。
 */
export function sanitizeControlChars(raw: string): string {
  return raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** 文本清洗：去多余空行/空格/控制字符，统一换行 */
export function cleanText(raw: string): string {
  return sanitizeControlChars(
    raw
      .replace(/\r\n/g, '\n') // Windows 换行 → Unix 换行
      .replace(/[ \t]+/g, ' ') // 连续空格/制表符 → 单个空格
      .replace(/\n{3,}/g, '\n\n'), // 多余空行 → 最多一个空行
  ).trim();
}
