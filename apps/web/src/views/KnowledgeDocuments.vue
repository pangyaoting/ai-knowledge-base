<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft, FileText, Loader2, Trash2, Upload, AlertCircle } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import { getDocuments, uploadDocument, deleteDocument } from '@/api/knowledge';
import { formatFileSize, type Document } from '@/types/knowledge';

const route = useRoute();
const router = useRouter();
const knowledgeBaseId = route.params.id as string;

const list = ref<Document[]>([]);
const loading = ref(false);
const uploading = ref(false);
const error = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const selectedFile = ref<File | null>(null);

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  selectedFile.value = input.files?.[0] ?? null;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    list.value = await getDocuments(knowledgeBaseId);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function handleUpload() {
  if (!selectedFile.value) return;
  uploading.value = true;
  error.value = '';
  try {
    await uploadDocument(knowledgeBaseId, selectedFile.value);
    selectedFile.value = null;
    if (fileInput.value) fileInput.value.value = '';
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    uploading.value = false;
  }
}

async function handleDelete(docId: string, filename: string) {
  // eslint-disable-next-line no-alert
  if (!window.confirm(`删除文档「${filename}」及其向量数据？`)) return;
  try {
    await deleteDocument(knowledgeBaseId, docId);
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

const statusText: Record<string, string> = {
  pending: '排队中',
  processing: '解析中',
  done: '已完成',
  failed: '失败',
};

function statusClass(status: string): string {
  switch (status) {
    case 'done':
      return 'bg-green-50 text-green-700';
    case 'failed':
      return 'bg-red-50 text-red-700';
    default:
      return 'bg-yellow-50 text-yellow-700';
  }
}

onMounted(load);
</script>

<template>
  <div class="container py-10">
    <div class="mb-6 flex items-center gap-3">
      <Button variant="ghost" size="icon" @click="router.push('/knowledge')">
        <ArrowLeft class="h-4 w-4" />
      </Button>
      <div>
        <h1 class="text-2xl font-bold tracking-tight">文档管理</h1>
        <p class="mt-0.5 text-sm text-muted-foreground">
          支持 PDF / Word(.docx) / Markdown / TXT，单个文件 ≤ 10MB
        </p>
      </div>
    </div>

    <!-- 上传区 -->
    <div class="mb-8 rounded-lg border border-dashed bg-card p-6">
      <div class="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
        <input
          ref="fileInput"
          type="file"
          accept=".pdf,.docx,.md,.markdown,.txt"
          class="block w-full max-w-md text-sm file:mr-4 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
          @change="onFileChange"
        />
        <Button :disabled="!selectedFile || uploading" @click="handleUpload">
          <Loader2 v-if="uploading" class="h-4 w-4 animate-spin" />
          <Upload v-else class="h-4 w-4" />
          {{ uploading ? '解析向量化中...' : '上传并解析' }}
        </Button>
      </div>
      <p v-if="uploading" class="mt-3 text-center text-xs text-muted-foreground">
        上传后需要解析、分块并调用 AI 向量化，大文档可能需要十几秒
      </p>
      <p v-if="error" class="mt-3 flex items-center justify-center gap-1.5 text-center text-sm text-destructive">
        <AlertCircle class="h-4 w-4" /> {{ error }}
      </p>
    </div>

    <!-- 文档列表 -->
    <div v-if="loading" class="flex justify-center py-16">
      <Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
    </div>

    <div v-else-if="list.length === 0" class="rounded-lg border border-dashed py-16 text-center">
      <FileText class="mx-auto h-10 w-10 text-muted-foreground/50" />
      <p class="mt-3 text-sm text-muted-foreground">还没有文档，上传一个试试</p>
    </div>

    <div v-else class="overflow-hidden rounded-lg border">
      <table class="w-full text-sm">
        <thead class="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th class="px-4 py-3 font-medium">文件名</th>
            <th class="px-4 py-3 font-medium">类型</th>
            <th class="px-4 py-3 font-medium">大小</th>
            <th class="px-4 py-3 font-medium">状态</th>
            <th class="px-4 py-3 font-medium">Chunk 数</th>
            <th class="px-4 py-3 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="doc in list" :key="doc.id">
            <td class="max-w-[280px] truncate px-4 py-3 font-medium" :title="doc.filename">
              {{ doc.filename }}
            </td>
            <td class="px-4 py-3 uppercase text-muted-foreground">{{ doc.fileType }}</td>
            <td class="px-4 py-3 text-muted-foreground">{{ formatFileSize(doc.fileSize) }}</td>
            <td class="px-4 py-3">
              <span
                class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs"
                :class="statusClass(doc.status)"
                :title="doc.error ?? ''"
              >
                <span
                  v-if="doc.status === 'processing' || doc.status === 'pending'"
                  class="h-1.5 w-1.5 animate-pulse rounded-full bg-current"
                />
                {{ statusText[doc.status] }}
              </span>
            </td>
            <td class="px-4 py-3 text-muted-foreground">{{ doc._count?.chunks ?? 0 }}</td>
            <td class="px-4 py-3 text-right">
              <button
                class="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                :title="'删除 ' + doc.filename"
                @click="handleDelete(doc.id, doc.filename)"
              >
                <Trash2 class="h-4 w-4" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
