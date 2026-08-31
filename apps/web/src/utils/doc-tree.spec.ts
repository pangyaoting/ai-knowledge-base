import { describe, it, expect } from 'vitest';
import {
  buildDocTree,
  flattenTree,
  countFolders,
  collectFolderFiles,
  type DocTreeNode,
} from './doc-tree';
import type { Document } from '@/types/knowledge';

function doc(id: string, filename: string): Document {
  return {
    id,
    filename,
    fileType: 'text',
    fileSize: 100,
    status: 'done',
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    knowledgeBaseId: 'kb-1',
    _count: { chunks: 2 },
  } as Document;
}

describe('buildDocTree 目录树构建', () => {
  it('根目录文件直接挂根', () => {
    const tree = buildDocTree([doc('a', 'readme.md')]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ type: 'file', name: 'readme.md', path: 'readme.md' });
  });

  it('嵌套路径生成文件夹层级，文件夹排前、按名称排序', () => {
    const tree = buildDocTree([
      doc('1', 'src/Button.ts'),
      doc('2', 'a.txt'),
      doc('3', 'src/utils/format.ts'),
    ]);
    expect(tree[0].type).toBe('folder'); // 文件夹排前
    expect(tree[1]).toMatchObject({ type: 'file', name: 'a.txt' });
    const src = tree[0] as DocTreeNode;
    expect(src.name).toBe('src');
    expect(src.children).toHaveLength(2);
    const utils = src.children!.find((n) => n.name === 'utils') as DocTreeNode;
    expect(utils.type).toBe('folder');
    expect(utils.children).toHaveLength(1);
  });

  it('文件夹统计 docCount / totalSize / chunkCount', () => {
    const tree = buildDocTree([doc('1', 'src/a.md'), doc('2', 'src/b.md')]);
    const src = tree[0] as DocTreeNode;
    expect(src.docCount).toBe(2);
    expect(src.totalSize).toBe(200);
    expect(src.chunkCount).toBe(4);
  });
});

describe('flattenTree 展开摊平', () => {
  const tree = buildDocTree([
    doc('1', 'src/a.ts'),
    doc('2', 'src/utils/b.ts'),
    doc('3', 'readme.md'),
  ]);

  it('不展开时只显示顶层（文件夹 + 根文件）', () => {
    const flat = flattenTree(tree, () => false);
    expect(flat.map((n) => n.name)).toEqual(['src', 'readme.md']);
    expect(flat[0].depth).toBe(0);
  });

  it('展开文件夹后显示子节点并递增深度', () => {
    const flat = flattenTree(tree, (n) => n.name === 'src');
    const names = flat.map((n) => n.name);
    expect(names).toContain('utils');
    expect(names).toContain('a.ts');
    expect(flat.find((n) => n.name === 'a.ts')!.depth).toBe(1);
  });
});

describe('countFolders / collectFolderFiles', () => {
  const tree = buildDocTree([
    doc('1', 'src/a.ts'),
    doc('2', 'src/utils/b.ts'),
    doc('3', 'readme.md'),
  ]);

  it('统计文件夹总数（含嵌套）', () => {
    expect(countFolders(tree)).toBe(2); // src + src/utils
  });

  it('收集文件夹下全部文件（含子文件夹）', () => {
    const src = tree[0] as DocTreeNode;
    const files = collectFolderFiles(src);
    // 文件夹先于同层文件遍历（utils/b.ts 先于 a.ts），用集合断言
    expect(files.map((f) => f.id).sort()).toEqual(['1', '2']);
  });
});
