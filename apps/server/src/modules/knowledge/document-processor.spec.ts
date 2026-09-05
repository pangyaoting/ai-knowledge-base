import { planParentChildren } from './document-processor.service';

describe('planParentChildren 父子分块规划（P2）', () => {
  it('小父块（≤ 子块大小）自身即叶子：直接向量化，不切子块', () => {
    const { embed, childRows } = planParentChildren([{ id: 'p1', content: '短内容' }]);
    expect(embed).toEqual([{ id: 'p1', content: '短内容' }]);
    expect(childRows).toEqual([]);
  });

  it('大父块切成多个子块，子块挂 parentId，父块不直接向量化', () => {
    const big = '字'.repeat(1200);
    const { embed, childRows } = planParentChildren([{ id: 'p1', content: big }]);
    expect(embed).toEqual([]); // 父块本身不向量化
    expect(childRows.length).toBeGreaterThan(1);
    for (const r of childRows) {
      expect(r.parentId).toBe('p1');
      expect(r.content.length).toBeLessThanOrEqual(500 + 100); // 不超过 chunkSize + overlap
    }
    // 拼接可还原全文（overlap 会导致少量重复，但内容不丢）
    const joined = childRows.map((r) => r.content).join('');
    expect(joined.length).toBeGreaterThanOrEqual(big.length);
    expect(joined).toContain('字');
  });

  it('混合：小父块直接 embed，大父块出子块', () => {
    const { embed, childRows } = planParentChildren([
      { id: 'small', content: '短' },
      { id: 'big', content: '甲'.repeat(900) },
    ]);
    expect(embed.map((e) => e.id)).toEqual(['small']);
    expect(childRows.every((r) => r.parentId === 'big')).toBe(true);
  });

  it('空输入返回空', () => {
    expect(planParentChildren([])).toEqual({ embed: [], childRows: [] });
  });
});
