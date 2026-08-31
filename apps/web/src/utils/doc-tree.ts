/**
 * 目录树：把扁平文档列表构建成文件夹树（文件夹上传保持文件夹形态）
 */
import type { Document } from '@/types/knowledge';

export interface DocTreeNode {
  type: 'folder' | 'file';
  name: string;
  path: string;
  doc?: Document;
  children?: DocTreeNode[];
  docCount?: number;
  totalSize?: number;
  chunkCount?: number;
}

export function buildDocTree(docs: Document[]): DocTreeNode[] {
  const root: DocTreeNode[] = [];
  const dirMap = new Map<string, DocTreeNode>();

  const ensureDir = (dirPath: string): DocTreeNode => {
    const cached = dirMap.get(dirPath);
    if (cached) return cached;
    const segs = dirPath.split('/');
    const node: DocTreeNode = {
      type: 'folder',
      name: segs[segs.length - 1],
      path: dirPath,
      children: [],
      docCount: 0,
      totalSize: 0,
      chunkCount: 0,
    };
    dirMap.set(dirPath, node);
    const parentPath = segs.slice(0, -1).join('/');
    if (parentPath) ensureDir(parentPath).children!.push(node);
    else root.push(node);
    return node;
  };

  for (const doc of docs) {
    const idx = doc.filename.lastIndexOf('/');
    if (idx < 0) {
      root.push({ type: 'file', name: doc.filename, path: doc.filename, doc });
    } else {
      const dir = ensureDir(doc.filename.slice(0, idx));
      dir.docCount! += 1;
      dir.totalSize! += doc.fileSize;
      dir.chunkCount! += doc._count?.chunks ?? 0;
      dir.children!.push({
        type: 'file',
        name: doc.filename.slice(idx + 1),
        path: doc.filename,
        doc,
      });
    }
  }

  const sortLevel = (nodes: DocTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh');
    });
    nodes.forEach((n) => n.type === 'folder' && sortLevel(n.children!));
  };
  sortLevel(root);
  return root;
}

/** 按展开状态摊平成表格行（带缩进层级） */
export function flattenTree(
  tree: DocTreeNode[],
  isExpanded: (node: DocTreeNode) => boolean,
): Array<DocTreeNode & { depth: number }> {
  const out: Array<DocTreeNode & { depth: number }> = [];
  const walk = (nodes: DocTreeNode[], depth: number) => {
    for (const n of nodes) {
      out.push({ ...n, depth });
      if (n.type === 'folder' && isExpanded(n) && n.children?.length) {
        walk(n.children, depth + 1);
      }
    }
  };
  walk(tree, 0);
  return out;
}

/** 文件夹总数 */
export function countFolders(tree: DocTreeNode[]): number {
  let n = 0;
  const walk = (nodes: DocTreeNode[]) => {
    for (const node of nodes) {
      if (node.type === 'folder') {
        n++;
        walk(node.children!);
      }
    }
  };
  walk(tree);
  return n;
}

/** 收集文件夹下的所有文件节点（含子文件夹） */
export function collectFolderFiles(node: DocTreeNode): Document[] {
  const docs: Document[] = [];
  const walk = (n: DocTreeNode) => {
    if (n.type === 'file' && n.doc) docs.push(n.doc);
    else n.children?.forEach(walk);
  };
  walk(node);
  return docs;
}
