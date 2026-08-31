/**
 * RRF（Reciprocal Rank Fusion）融合算法 —— 纯函数，便于单测
 *
 * 只依赖排名，不依赖分数量纲 → 向量相似度(0~1)和关键词相似度(0~1)可直接融合，无需归一化
 */

export const RRF_K = 60; // RRF 平滑常数（论文默认值）

export interface RrfRow {
  chunk_id: string;
  content: string;
  chunk_index: number;
  document_id: string;
  filename: string;
  similarity: number;
}

/**
 * 把两路（向量 + 关键词）按排名合并为总分，返回融合后的 Top-K。
 * 融合分相同时，向量路（先 add）优先展示——语义命中优先。
 */
export function rrfMerge(vectorRows: RrfRow[], keywordRows: RrfRow[], topK: number): RrfRow[] {
  const scores = new Map<string, { score: number; row: RrfRow }>();
  const add = (rows: RrfRow[]) => {
    rows.forEach((row, i) => {
      const rank = i + 1;
      const contribution = 1 / (RRF_K + rank);
      const cur = scores.get(row.chunk_id);
      if (cur) {
        cur.score += contribution;
      } else {
        scores.set(row.chunk_id, { score: contribution, row });
      }
    });
  };
  add(vectorRows); // 先加向量：融合分相同时，语义命中优先展示
  add(keywordRows);
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.row);
}
