import { splitStructuredMd } from './structured-splitter';

describe('splitStructuredMd 结构化分块（P1）', () => {
  it('按标题分节，每块带章节路径前缀', () => {
    const md = `# 计划\n\n## W1 语言重修\n\n周一学闭包。\n\n## W2 异步\n\n周二学事件循环。`;
    const chunks = splitStructuredMd(md);
    const w1 = chunks.find((c) => c.includes('周一学闭包'))!;
    expect(w1.startsWith('计划 > W1 语言重修')).toBe(true);
    const w2 = chunks.find((c) => c.includes('周二学事件循环'))!;
    expect(w2.startsWith('计划 > W2 异步')).toBe(true);
  });

  it('表格作为整体保留，且带章节前缀', () => {
    const md = `## 周计划\n\n| 天 | 内容 |\n| --- | --- |\n| 周一 | 闭包 |\n| 周二 | 事件循环 |`;
    const chunks = splitStructuredMd(md);
    const table = chunks.find((c) => c.includes('周一') && c.includes('周二'))!;
    expect(table).toContain('| 天 | 内容 |'); // 表头保留
    expect(table.startsWith('周计划')).toBe(true);
  });

  it('超长表格按行切分时，每块都重复表头（表头上下文不丢）', () => {
    // 表头 + 很多行 → 必然超 maxChars（设小阈值强制切分）
    const header = '| 天 | 学习内容 |';
    const rows = Array.from({ length: 40 }, (_, i) => `| 周${i + 1} | 内容${i + 1} |`);
    const md = `## 表格\n\n${[header, '| --- | --- |', ...rows].join('\n')}`;
    const chunks = splitStructuredMd(md, { maxChars: 120 });
    // 至少两块，且每块都有表头
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c).toContain(header);
    }
    // 内容不丢（行都在某块里）
    const all = chunks.join('');
    for (const r of rows) {
      expect(all).toContain(r);
    }
  });

  it('无标题文档退化为普通分块（不阻塞）', () => {
    const text = '没有标题的一段文本。'.repeat(200);
    const chunks = splitStructuredMd(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('标题层级：子标题追加到路径', () => {
    const md = `# 根\n\n## 一级\n\n### 二级\n\n内容在二级。`;
    const chunk = splitStructuredMd(md).find((c) => c.includes('内容在二级'))!;
    expect(chunk.startsWith('根 > 一级 > 二级')).toBe(true);
  });
});
