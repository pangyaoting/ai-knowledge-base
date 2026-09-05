import { aggregateFulltext } from './rag.service';

describe('aggregateFulltext 全文聚合（P0 全文模式）', () => {
  it('多文档按 chunkIndex 排序拼接，每文档一条全文', () => {
    const rows = [
      { document_id: 'a', filename: 'a.md', content: 'A2', chunk_index: 1 },
      { document_id: 'b', filename: 'b.md', content: 'B1', chunk_index: 0 },
      { document_id: 'a', filename: 'a.md', content: 'A1', chunk_index: 0 },
    ];
    const { sources, totalChars } = aggregateFulltext(rows);
    expect(sources).toHaveLength(2);
    const a = sources.find((s) => s.documentId === 'a')!;
    expect(a.content).toBe('A1\nA2'); // 按 chunk_index 升序拼接
    expect(a.filename).toBe('a.md');
    expect(a.chunkIndex).toBe(-1); // 全文块标记
    expect(a.similarity).toBeNull(); // 非检索命中标记
    const b = sources.find((s) => s.documentId === 'b')!;
    expect(b.content).toBe('B1');
    expect(totalChars).toBe('A1\nA2'.length + 'B1'.length);
  });

  it('空输入返回空结果', () => {
    expect(aggregateFulltext([])).toEqual({ sources: [], totalChars: 0 });
  });
});
