/**
 * Markdown 结构化分块器（手写，无第三方依赖）
 *
 * 为什么需要它（P1 结构感知切片）：
 * 字符级分块（splitText）会把文档拦腰切断——表格行被切碎成无头碎片、
 * 章节标题与正文分离，检索命中一块时模型不知道它属于哪个章节、哪个表，
 * 语义上下文全丢（本项目实测：docs/41 这类表格文档检索质量差）。
 *
 * 做法：
 * 1. 按标题（# ~ ######）建层级栈，把文档切成"章节段"，每段携带完整章节路径前缀
 *    （如 "W1 JavaScript 核心（上） > 周一 变量作用域与闭包"）；
 * 2. 表格（| ... | 行组）作为整体保留；超长表格按行切时把"表头行"重复注入每块，
 *    让检索命中的任意几行都带表头上下文；
 * 3. 没有标题的文档退化为普通字符分块（不阻塞）。
 */

import { splitText } from './text-splitter';

export interface StructuredSplitOptions {
  /** 单块目标长度（字符），默认 1200（比纯字符切大：结构块应保留整段上下文） */
  maxChars?: number;
}

interface Heading {
  level: number;
  title: string;
}

/** 段落类型：普通文本段 或 表格段 */
type Para = { kind: 'text'; lines: string[] } | { kind: 'table'; header: string; body: string[] };

/** 行是否可能是表格分隔行（| --- | --- |） */
const TABLE_SEP_RE = /^\|[\s:\-|]+\|?$/;

/** 解析 md 文本 → 带章节路径前缀的文本块列表 */
export function splitStructuredMd(text: string, options: StructuredSplitOptions = {}): string[] {
  const maxChars = options.maxChars ?? 1200;
  const lines = text.split('\n');
  const out: string[] = [];

  // 标题栈 + 当前章节收集
  const stack: Heading[] = [];
  let cur: string[] = [];
  let curPath = '';

  const sectionPath = (): string => stack.map((h) => h.title.trim()).join(' > ');

  const flush = () => {
    if (cur.length === 0) return;
    const body = cur.join('\n').trim();
    cur = [];
    if (body) {
      out.push(...chunkSection(body, curPath, maxChars));
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      const title = m[2].trim();
      // 弹出比当前标题更深的层级（同级或更浅的标题结束上一节）
      while (stack.length && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      stack.push({ level, title });
      curPath = sectionPath();
      continue;
    }
    cur.push(line);
  }
  flush();

  return out.length ? out : splitText(text);
}

/**
 * 把一个章节的正文切成块（每块开头带章节路径前缀）。
 * 内部把"表格行组"与"普通文本"区分开：表格整表保留；超长表格按行切并重复表头。
 */
function chunkSection(body: string, path: string, maxChars: number): string[] {
  const paras = parseParas(body);
  const prefix = path ? `${path}\n` : '';
  const chunks: string[] = [];

  const pushBlock = (text: string) => {
    const t = text.trim();
    if (t) chunks.push(`${prefix}${t}`);
  };

  let buf: string[] = [];
  let bufLen = 0;

  const flushBuf = () => {
    if (buf.length === 0) return;
    pushBlock(buf.join('\n'));
    buf = [];
    bufLen = 0;
  };

  for (const para of paras) {
    if (para.kind === 'table') {
      flushBuf();
      // 表格块：整表保留；超长则按行切，每块带表头（表头上下文不丢）
      const tableText = [para.header, ...para.body].join('\n');
      if (tableText.length <= maxChars) {
        pushBlock(tableText);
        continue;
      }
      let group: string[] = [];
      let groupLen = para.header.length;
      for (const row of para.body) {
        if (group.length && groupLen + row.length + 1 > maxChars) {
          pushBlock([para.header, ...group].join('\n'));
          group = [];
          groupLen = para.header.length;
        }
        group.push(row);
        groupLen += row.length + 1;
      }
      if (group.length) pushBlock([para.header, ...group].join('\n'));
      continue;
    }
    // 普通文本：累积到接近上限再开新块；单个超长段按行切
    for (const line of para.lines) {
      // 超长单行（无换行的长文本/压缩内容）：字符硬切，避免"巨无霸块"
      if (line.length > maxChars) {
        flushBuf();
        for (const piece of splitText(line, { chunkSize: maxChars, overlap: 100 })) {
          pushBlock(piece);
        }
        continue;
      }
      if (buf.length && bufLen + line.length + 1 > maxChars) {
        flushBuf();
      }
      buf.push(line);
      bufLen += line.length + 1;
    }
  }
  flushBuf();
  return chunks;
}

/** 把一个章节正文解析成 文本段/表格段 交替的列表 */
function parseParas(body: string): Para[] {
  const lines = body.split('\n');
  const paras: Para[] = [];
  let textBuf: string[] = [];

  const flushText = () => {
    if (textBuf.length) {
      paras.push({ kind: 'text', lines: textBuf });
      textBuf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith('|')) {
      // 收集连续 | 行，确认是表格（≥2 行且第 2 行是分隔行）
      const rows: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        rows.push(lines[i].trim());
        i++;
      }
      if (rows.length >= 2 && TABLE_SEP_RE.test(rows[1] ?? '')) {
        flushText();
        paras.push({ kind: 'table', header: rows[0], body: rows.slice(2) });
      } else {
        textBuf.push(...rows);
      }
      continue;
    }
    // 空行：结束当前文本段
    if (line.trim() === '') {
      flushText();
      i++;
      continue;
    }
    textBuf.push(line);
    i++;
  }
  flushText();
  return paras;
}
