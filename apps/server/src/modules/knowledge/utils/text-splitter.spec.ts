import { splitText, splitCode } from './text-splitter';

describe('splitText 递归字符分块', () => {
  it('500 字以内的文本整块返回', () => {
    expect(splitText('你好，世界')).toEqual(['你好，世界']);
  });

  it('超长文本切成多块，每块不超过 chunkSize + overlap（重叠尾巴拼在新块前）', () => {
    const chunks = splitText('x'.repeat(1200));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 500 + 100)).toBe(true);
  });

  it('重叠：相邻块尾部带 overlap 字尾巴，边界内容不丢', () => {
    const text = 'a'.repeat(400) + '边界词' + 'b'.repeat(400);
    const chunks = splitText(text, { chunkSize: 300, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    // 边界词至少出现在一个块里（拼接后可找回）
    expect(chunks.join('')).toContain('边界词');
    // 重叠生效：某块以重叠尾巴开头
    const tail = chunks[0].slice(-50);
    expect(chunks[1].startsWith(tail)).toBe(true);
  });

  it('优先按段落/句号自然边界切，不硬劈句子', () => {
    const text = Array.from({ length: 40 }, () => '第一句话内容测试。').join('');
    const chunks = splitText(text, { chunkSize: 200 });
    // 每块都应保留完整句号（句号不丢）
    for (const c of chunks) {
      const trimmed = c.replace(/^[\s\S]*?(?=第一句话)/, ''); // 重叠尾巴不算
      expect(trimmed).toMatch(/。$/);
    }
  });

  it('空文本/纯空白返回空数组', () => {
    expect(splitText('')).toEqual([]);
    expect(splitText('   \n  ')).toEqual([]);
  });
});

describe('splitCode 代码分块', () => {
  it('短代码整块返回', () => {
    expect(splitCode('const a = 1;')).toEqual(['const a = 1;']);
  });

  it('超长代码切成多块', () => {
    const code = Array.from({ length: 100 }, (_, i) => `line ${i} const x = ${i};`).join('\n');
    const chunks = splitCode(code);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('prefix 拼到每块开头（检索时知道来源文件）', () => {
    const code = Array.from({ length: 100 }, (_, i) => `const x${i} = ${i};`).join('\n');
    const chunks = splitCode(code, '文件: src/Button.ts');
    for (const c of chunks) expect(c.startsWith('文件: src/Button.ts')).toBe(true);
  });

  it('超长单行（压缩代码）按字符窗口硬切，不产生巨无霸块', () => {
    const oneLine = 'a'.repeat(5000);
    const chunks = splitCode(oneLine);
    for (const c of chunks) expect(c.length).toBeLessThan(2000);
  });
});
