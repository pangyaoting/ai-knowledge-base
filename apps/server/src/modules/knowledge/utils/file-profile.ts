/**
 * 文件档案生成器（A 语义层，纯函数可测）
 *
 * 每个文档入库时生成一段"档案"文本并单独向量化，用于"先定位文件、再文件内检索"：
 * - md 文档：档案 = 文件名 + 章节标题地图（让"中文泛化问题"能语义命中这个文件）
 * - 代码文件：档案 = 文件名 + 符号清单（函数/类/组件…），与 C 符号表配合
 * - 其他：档案 = 文件名 + 开头摘要
 */

export type ProfileFileType = 'md' | 'code' | 'text';

export interface ProfileSymbol {
  kind: string;
  name: string;
  signature?: string;
}

export interface BuildProfileOptions {
  filename: string;
  fileType: ProfileFileType;
  source: string;
  symbols?: ProfileSymbol[];
}

const KIND_CN: Record<string, string> = {
  function: '函数',
  const: '变量/常量',
  class: '类',
  interface: '接口',
  type: '类型',
  enum: '枚举',
  component: 'Vue 组件',
};

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** 生成文件档案文本（300-800 字，向量化友好） */
export function buildFileProfile(opts: BuildProfileOptions): string {
  const { filename, fileType, source } = opts;
  const typeName = fileType === 'md' ? 'Markdown 文档' : fileType === 'code' ? '代码文件' : '文档';
  const parts: string[] = [`文件：${filename}`, `类型：${typeName}`];

  if (fileType === 'md') {
    const headings = source
      .split('\n')
      .map((line) => HEADING_RE.exec(line))
      .filter((m): m is RegExpExecArray => !!m)
      .slice(0, 40);
    if (headings.length > 0) {
      parts.push('文档章节结构：');
      for (const m of headings) {
        const depth = Math.max(m[1].length - 1, 0);
        parts.push(`${'  '.repeat(depth)}${m[2].trim()}`);
      }
    } else {
      parts.push('内容摘要：');
      parts.push(source.replace(/\s+/g, ' ').slice(0, 300));
    }
    return parts.join('\n');
  }

  if (fileType === 'code') {
    const symbols = (opts.symbols ?? []).slice(0, 60);
    if (symbols.length > 0) {
      parts.push(`包含 ${symbols.length} 个符号：`);
      for (const s of symbols) {
        const kind = KIND_CN[s.kind] ?? s.kind;
        const sig = s.signature ? `（${s.signature.slice(0, 80)}）` : '';
        parts.push(`- ${kind} ${s.name}${sig}`);
      }
      return parts.join('\n');
    }
  }

  // 兜底：开头摘要
  parts.push('内容摘要：');
  parts.push(source.replace(/\s+/g, ' ').slice(0, 300));
  return parts.join('\n');
}
