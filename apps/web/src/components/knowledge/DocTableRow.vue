<script setup lang="ts">
defineOptions({ name: 'DocTableRow' });

import {
  Loader2,
  Trash2,
  Download,
  RefreshCw,
  Pencil,
  ChevronRight,
  Folder,
} from 'lucide-vue-next';
import { fileIconOf, fileBadgeOf } from '@/utils/file-icons';
import type { DocTreeNode } from '@/utils/doc-tree';

const props = defineProps<{
  node: DocTreeNode & { depth: number };
  selectedIds: Set<string>;
  updatingId: string | null;
  expandedPaths: Set<string>;
}>();

const emit = defineEmits<{
  (e: 'toggle-folder', node: DocTreeNode): void;
  (e: 'toggle-select-folder', node: DocTreeNode): void;
  (e: 'toggle-select', id: string): void;
  (e: 'edit', doc: NonNullable<DocTreeNode['doc']>): void;
  (e: 'download', doc: NonNullable<DocTreeNode['doc']>): void;
  (e: 'replace', docId: string, file: File): void;
  (e: 'delete', id: string, filename: string): void;
  (e: 'rename-folder', node: DocTreeNode): void;
  (e: 'delete-folder', node: DocTreeNode): void;
}>();

const statusText: Record<string, string> = {
  pending: '排队中',
  processing: '解析中',
  replacing: '替换中',
  done: '已完成',
  failed: '失败',
};

function statusClass(status: string): string {
  switch (status) {
    case 'done':
      return 'bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-400';
    case 'failed':
      return 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-400';
    case 'replacing':
      return 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400';
    default:
      return 'bg-yellow-50 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-400';
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** 文件夹是否全选（用于复选框半选/全选态） */
function folderSelected(node: DocTreeNode): boolean {
  const collect = (n: DocTreeNode): Array<NonNullable<DocTreeNode['doc']>> => {
    const out: Array<NonNullable<DocTreeNode['doc']>> = [];
    const walk = (x: DocTreeNode) => {
      if (x.type === 'file' && x.doc) out.push(x.doc);
      else x.children?.forEach(walk);
    };
    walk(n);
    return out;
  };
  const docs = collect(node);
  return docs.length > 0 && docs.every((d) => props.selectedIds.has(d.id));
}

function isExpanded(node: DocTreeNode): boolean {
  return props.expandedPaths.has(node.path);
}

function onReplaceChange(e: Event, docId: string) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) emit('replace', docId, file);
}
</script>

<template>
  <tr :key="node.type === 'folder' ? 'dir:' + node.path : 'file:' + node.doc!.id">
    <!-- 文件夹行 -->
    <template v-if="node.type === 'folder'">
      <td
        class="cursor-pointer select-none px-4 py-2.5 transition-colors hover:bg-muted/50"
        @click="emit('toggle-folder', node)"
      >
        <div class="flex items-center gap-2" :style="{ paddingLeft: node.depth * 20 + 'px' }">
          <input
            type="checkbox"
            class="h-3.5 w-3.5 shrink-0 accent-blue-500"
            :checked="folderSelected(node)"
            @click.stop
            @change="emit('toggle-select-folder', node)"
          />
          <ChevronRight
            class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform"
            :class="{ 'rotate-90': isExpanded(node) }"
          />
          <Folder class="h-4 w-4 shrink-0 text-primary" />
          <span class="font-medium">{{ node.name }}</span>
        </div>
      </td>
      <td class="px-4 py-2.5 uppercase text-muted-foreground">文件夹</td>
      <td class="px-4 py-2.5 text-muted-foreground">{{ formatFileSize(node.totalSize ?? 0) }}</td>
      <td class="px-4 py-2.5 text-muted-foreground">{{ node.docCount }} 个文档</td>
      <td class="px-4 py-2.5 text-muted-foreground">{{ node.chunkCount ?? 0 }}</td>
      <td class="px-4 py-2.5 text-right">
        <div class="flex items-center justify-end gap-1">
          <button
            class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            :title="'重命名文件夹 ' + node.name"
            @click.stop="emit('rename-folder', node)"
          >
            <Pencil class="h-4 w-4" />
          </button>
          <button
            class="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            :title="'删除文件夹 ' + node.name"
            @click.stop="emit('delete-folder', node)"
          >
            <Trash2 class="h-4 w-4" />
          </button>
        </div>
      </td>
    </template>

    <!-- 文件行 -->
    <template v-else>
      <td class="max-w-[280px] truncate px-4 py-3 font-medium" :title="node.doc!.filename">
        <div class="flex items-center gap-1.5" :style="{ paddingLeft: node.depth * 20 + 'px' }">
          <input
            type="checkbox"
            class="h-3.5 w-3.5 shrink-0 accent-blue-500"
            :checked="props.selectedIds.has(node.doc!.id)"
            @change="emit('toggle-select', node.doc!.id)"
          />
          <!-- Material 风格：品牌色实底字母徽标（TS/VUE/JSON→{}）；识别不到回退彩色 lucide 图标 -->
          <span
            v-if="fileBadgeOf(node.doc!.filename)"
            class="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] text-[7px] font-bold leading-none"
            :style="{
              background: fileBadgeOf(node.doc!.filename)!.color,
              color: fileBadgeOf(node.doc!.filename)!.darkText ? '#1e1e1e' : '#ffffff',
            }"
            >{{ fileBadgeOf(node.doc!.filename)!.text }}</span
          >
          <component
            v-else
            :is="fileIconOf(node.doc!.filename)"
            class="h-4 w-4 shrink-0 text-muted-foreground"
          />
          <span class="truncate">{{ node.name }}</span>
        </div>
      </td>
      <td class="px-4 py-3 uppercase text-muted-foreground">{{ node.doc!.fileType }}</td>
      <td class="px-4 py-3 text-muted-foreground">{{ formatFileSize(node.doc!.fileSize) }}</td>
      <td class="px-4 py-3">
        <span
          class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs"
          :class="statusClass(node.doc!.status)"
          :title="node.doc!.error ?? ''"
        >
          <span
            v-if="node.doc!.status === 'processing' || node.doc!.status === 'pending'"
            class="h-1.5 w-1.5 animate-pulse rounded-full bg-current"
          />
          {{ statusText[node.doc!.status] }}
        </span>
      </td>
      <td class="px-4 py-3 text-muted-foreground">{{ node.doc!._count?.chunks ?? 0 }}</td>
      <td class="px-4 py-3 text-right">
        <div class="flex items-center justify-end gap-1">
          <button
            class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            :title="'编辑 ' + node.doc!.filename"
            @click="emit('edit', node.doc!)"
          >
            <Pencil class="h-4 w-4" />
          </button>
          <button
            class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            :title="'下载 ' + node.doc!.filename"
            @click="emit('download', node.doc!)"
          >
            <Download class="h-4 w-4" />
          </button>
          <label
            class="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            :title="'更新（重新上传替换）'"
          >
            <Loader2 v-if="props.updatingId === node.doc!.id" class="h-4 w-4 animate-spin" />
            <RefreshCw v-else class="h-4 w-4" />
            <input
              type="file"
              class="hidden"
              :disabled="props.updatingId !== null"
              @change="onReplaceChange($event, node.doc!.id)"
            />
          </label>
          <button
            class="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            :title="'删除 ' + node.doc!.filename"
            @click="emit('delete', node.doc!.id, node.doc!.filename)"
          >
            <Trash2 class="h-4 w-4" />
          </button>
        </div>
      </td>
    </template>
  </tr>
</template>
