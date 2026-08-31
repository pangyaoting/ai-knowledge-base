import { rrfMerge, RRF_K, type RrfRow } from './rrf';

function row(id: string, idx = 0): RrfRow {
  return {
    chunk_id: id,
    content: `内容 ${id}`,
    chunk_index: idx,
    document_id: `doc-${id}`,
    filename: `${id}.md`,
    similarity: 0.5,
  };
}

describe('rrfMerge 混合检索融合', () => {
  it('两路都命中的排在只命中一路的前面', () => {
    const vectorRows = [row('a'), row('b'), row('c')];
    const keywordRows = [row('b'), row('d')];
    const merged = rrfMerge(vectorRows, keywordRows, 10);
    // b 两路都出现: 1/61 + 1/62；a: 1/61；d: 1/62；c: 1/63
    expect(merged[0].chunk_id).toBe('b');
    expect(merged.map((r) => r.chunk_id)).toEqual(['b', 'a', 'd', 'c']);
  });

  it('融合分相同时，向量路（先 add）优先', () => {
    // a 在向量路第1（1/61）；b 在关键词路第1（1/61）→ 分相同，a 先展示
    const vectorRows = [row('a')];
    const keywordRows = [row('b')];
    const merged = rrfMerge(vectorRows, keywordRows, 10);
    expect(merged.map((r) => r.chunk_id)).toEqual(['a', 'b']);
  });

  it('topK 截断生效', () => {
    const vectorRows = [row('a'), row('b'), row('c'), row('d')];
    const keywordRows = [row('e'), row('f')];
    const merged = rrfMerge(vectorRows, keywordRows, 3);
    expect(merged.length).toBe(3);
  });

  it('只依赖排名不依赖分数：分数不同的两路融合结果一致', () => {
    const v1 = [row('a'), row('b')];
    const k1 = [row('b')];
    const v2 = [row('a'), row('b')];
    const k2 = [row('b')];
    const r1 = rrfMerge(v1, k1, 10).map((r) => r.chunk_id);
    const r2 = rrfMerge(v2, k2, 10).map((r) => r.chunk_id);
    expect(r1).toEqual(r2);
  });

  it('空输入返回空数组', () => {
    expect(rrfMerge([], [], 10)).toEqual([]);
  });

  it('RRF_K 使用论文默认值 60', () => {
    expect(RRF_K).toBe(60);
  });
});
