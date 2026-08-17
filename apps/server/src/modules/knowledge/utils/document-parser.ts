/**
 * 文档解析工具：把上传的文件变成纯文本
 *
 * 支持类型（与前端约定一致）：
 * - pdf  : pdf-parse（服务端轻量提取）
 * - docx : mammoth（微软 Word 格式）
 * - md   : 直接读（Markdown 本身就是文本）
 * - txt  : 直接读
 *
 * 边界说明（面试可讲"我清楚技术边界"）：
 * - .doc 老格式不支持（需要 COM 调用，成本高），前端提示转 .docx
 * - PDF 里纯图片内容（扫描件）提取不到文字 → 会报"未能提取到文本"
 * - OCR 识别图片文字留作扩展
 */
import pdfParse from 'pdf-parse';
import * as mammoth from 'mammoth';

export type DocType = 'pdf' | 'docx' | 'md' | 'txt';

/** 根据文件名判断文件类型，不支持返回 null */
export function detectFileType(filename: string): DocType | null {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'txt') return 'txt';
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
      return buffer.toString('utf-8');
    default:
      throw new Error(`不支持的文件类型: ${fileType}`);
  }
}

/** 文本清洗：去多余空行/空格/控制字符，统一换行 */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n') // Windows 换行 → Unix 换行
    .replace(/[ \t]+/g, ' ') // 连续空格/制表符 → 单个空格
    .replace(/\n{3,}/g, '\n\n') // 多余空行 → 最多一个空行
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') // 控制字符
    .trim();
}
