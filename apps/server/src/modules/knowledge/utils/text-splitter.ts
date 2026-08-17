/**
 * 递归字符分块器（手写）
 *
 * 参考 LangChain RecursiveCharacterTextSplitter 的思路：
 * 优先按"自然边界"切分（段落 → 句子 → 短语），保证语义完整；
 * 只有所有边界都用完了才按字符硬切。
 *
 * 参数：
 * - chunkSize: 每块目标长度（字符数），默认 500
 * - overlap:   相邻块重叠长度（字符数），默认 100
 *
 * 为什么需要 overlap？
 * 如果答案内容恰好被切在块的边界上，检索时可能只取到一半。
 * 重叠一段尾巴，让边界附近的内容在相邻块里各出现一次，不丢上下文。
 */

const DEFAULT_SEPARATORS = ['\n\n', '\n', '。', '！', '？', '；', '，', ' '];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface SplitOptions {
  chunkSize?: number;
  overlap?: number;
}

/** 把一段长文本切成若干 chunk */
export function splitText(text: string, options: SplitOptions = {}): string[] {
  const chunkSize = options.chunkSize ?? 500;
  const overlap = options.overlap ?? 100;
  const chunks: string[] = [];
  recursiveSplit(text, DEFAULT_SEPARATORS, chunkSize, overlap, chunks);
  return chunks.filter((c) => c.trim().length > 0);
}

function recursiveSplit(
  text: string,
  separators: string[],
  chunkSize: number,
  overlap: number,
  chunks: string[],
): void {
  // 本身就不超长：直接并进上一块（或作为第一块）
  if (text.length <= chunkSize) {
    mergeChunk(text, chunks, chunkSize, overlap);
    return;
  }

  const [sep, ...rest] = separators;
  // 没有可用分隔符了：按 chunkSize 硬切（step 带 overlap，保证边界不丢）
  if (!sep) {
    let pos = 0;
    while (pos < text.length) {
      mergeChunk(text.slice(pos, pos + chunkSize), chunks, chunkSize, overlap);
      pos += chunkSize - overlap;
    }
    return;
  }

  // 用"向后断言"分割，让每个片段保留末尾的分隔符（如 "第一句。" 的句号不丢）
  // 例: "你好。世界" split(/(?<=。)/) → ["你好。", "世界"]
  const parts = text.split(new RegExp(`(?<=${escapeRegExp(sep)})`));
  for (const part of parts) {
    if (part.length > chunkSize) {
      // 这块还是太长：换下一个更细的分隔符递归切
      recursiveSplit(part, rest, chunkSize, overlap, chunks);
    } else {
      mergeChunk(part, chunks, chunkSize, overlap);
    }
  }
}

/** 把 part 合并进 chunks：能塞进上一块就塞，塞不下就开新块（带 overlap） */
function mergeChunk(part: string, chunks: string[], chunkSize: number, overlap: number): void {
  if (chunks.length === 0) {
    chunks.push(part);
    return;
  }
  const last = chunks[chunks.length - 1];
  if (last.length + part.length <= chunkSize) {
    chunks[chunks.length - 1] = last + part;
  } else {
    const tail = overlap > 0 ? last.slice(-overlap) : '';
    chunks.push(tail + part);
  }
}
