<script setup lang="ts">
/**
 * 文档预览抽屉：右侧滑出，展示文档的全部文本块（"第 N 段"）。
 * 支持引用定位：highlightChunkIndex 变化时滚动到对应文本块并高亮闪烁。
 * 打开方式：父组件把 documentId 设为非空；关闭时 emit('close')。
 */
import { ref, watch, nextTick } from 'vue';
import { FileText, Loader2, X, AlertCircle } from 'lucide-vue-next';
import { getDocumentChunks } from '@/api/knowledge';
import type { DocumentChunk } from '@/types/knowledge';

const props = defineProps<{
  /** 要预览的文档 id；null = 关闭 */
  documentId: string | null;
  /** 需要定位高亮的文本块序号（chunkIndex），null = 不高亮 */
  highlightChunkIndex?: number | null;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const loading = ref(false);
const error = ref('');
const filename = ref('');
const fileType = ref('');
const chunks = ref<DocumentChunk[]>([]);
const highlighted = ref<number | null>(null); // 当前高亮的 chunkIndex
const flashTimer = ref<ReturnType<typeof setTimeout> | null>(null);

/** 打开抽屉：拉取文本块 */
async function open(documentId: string) {
  loading.value = true;
  error.value = '';
  filename.value = '';
  fileType.value = '';
  chunks.value = [];
  try {
    const res = await getDocumentChunks(documentId);
    filename.value = res.filename;
    fileType.value = res.fileType;
    chunks.value = res.chunks;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

/** 定位高亮：滚动到目标块 + 闪烁 2.5 秒 */
async function flashTo(index: number) {
  await nextTick();
  if (flashTimer.value) clearTimeout(flashTimer.value);
  highlighted.value = null;
  await nextTick();
  highlighted.value = index;
  const el = document.querySelector(`[data-chunk="${index}"]`);
  if (el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flashTimer.value = setTimeout(() => {
      highlighted.value = null;
    }, 3000);
  }
}

// documentId 变化：打开新文档（重新拉取）
watch(
  () => props.documentId,
  (id) => {
    if (id) open(id);
  },
  { immediate: true },
);

// highlightChunkIndex 变化：同一文档内切换定位，或首次定位（等数据加载完）
watch(
  () => props.highlightChunkIndex,
  (idx) => {
    if (idx == null) return;
    if (!loading.value && chunks.value.length) {
      flashTo(idx);
    } else {
      // 数据还没加载完：等 open() 完成后再定位
      const unwatch = watch(
        () => loading.value,
        (l) => {
          if (!l && chunks.value.length) {
            flashTo(idx);
            unwatch();
          }
        },
      );
    }
  },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="documentId" class="fixed inset-0 z-50 flex justify-end">
      <!-- 半透明遮罩：点击关闭 -->
      <div class="absolute inset-0 bg-black/40" @click="emit('close')" />
      <!-- 右侧抽屉 -->
      <div
        class="relative flex h-full w-full max-w-xl flex-col border-l bg-card shadow-2xl"
        role="dialog"
        aria-label="文档预览"
      >
        <!-- 头部：文件名 + 文本块数 + 关闭 -->
        <div class="flex items-center gap-2 border-b px-4 py-3">
          <FileText class="h-4 w-4 shrink-0 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">{{ filename || '文档预览' }}</p>
            <p v-if="!loading && chunks.length" class="text-[11px] text-muted-foreground">
              共 {{ chunks.length }} 个文本块
              <template v-if="fileType"> · {{ fileType.toUpperCase() }}</template>
            </p>
          </div>
          <button
            class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="关闭"
            @click="emit('close')"
          >
            <X class="h-4 w-4" />
          </button>
        </div>

        <!-- 正文：文本块列表 -->
        <div class="flex-1 overflow-y-auto p-4">
          <div v-if="loading" class="flex justify-center py-16">
            <Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
          </div>

          <p
            v-else-if="error"
            class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle class="mr-1 inline h-4 w-4" /> {{ error }}
          </p>

          <p
            v-else-if="chunks.length === 0"
            class="py-16 text-center text-sm text-muted-foreground"
          >
            文档还在解析中，或没有可预览的文本内容
          </p>

          <div v-else class="space-y-3">
            <div
              v-for="c in chunks"
              :key="c.id"
              :data-chunk="c.chunkIndex"
              class="rounded-lg border p-3 transition-colors duration-500"
              :class="
                highlighted === c.chunkIndex
                  ? 'border-primary bg-primary/10 shadow-sm'
                  : 'bg-muted/30'
              "
            >
              <p class="mb-1 text-[11px] font-medium text-muted-foreground">
                第 {{ c.chunkIndex + 1 }} 段
              </p>
              <p class="whitespace-pre-wrap text-sm leading-relaxed">{{ c.content }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
