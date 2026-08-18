<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ArrowLeft,
  FileText,
  Loader2,
  Trash2,
  AlertCircle,
  Download,
  RefreshCw,
  Pencil,
  X,
  FolderOpen,
  FolderTree,
  Sparkles,
} from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
import {
  getDocuments,
  uploadDocument,
  deleteDocument,
  downloadDocumentFile,
  getDocumentContent,
  updateDocument,
} from '@/api/knowledge';
import { formatFileSize, type Document } from '@/types/knowledge';

const route = useRoute();
const router = useRouter();
const knowledgeBaseId = route.params.id as string;

const list = ref<Document[]>([]);
const loading = ref(false);
const uploading = ref(false);
const uploadPercent = ref<number | null>(null); // 当前文件上传进度（0-100）
const uploadIndex = ref(0); // 批量上传：第几个
const uploadTotal = ref(0);
const error = ref('');
const uploadErrors = ref<string[]>([]); // 批量上传中失败的文件
const fileInput = ref<HTMLInputElement | null>(null); // 多文件选择
const dirInput = ref<HTMLInputElement | null>(null); // 目录选择

interface PendingFile {
  id: string;
  file: File;
  name: string; // 显示名（目录上传时带相对路径）
}
const pendingFiles = ref<PendingFile[]>([]);

const ALLOWED_RE = /\.(pdf|docx|md|markdown|txt)$/i;

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  addPendingFiles(Array.from(input.files ?? []));
  input.value = '';
}

/** 目录上传：File.webkitRelativePath 保留目录结构（如 docs/子目录/a.md） */
function onDirChange(e: Event) {
  const input = e.target as HTMLInputElement;
  addPendingFiles(Array.from(input.files ?? []));
  input.value = '';
}

function addPendingFiles(files: File[]) {
  const allowed = files.filter((f) => ALLOWED_RE.test(f.name));
  if (allowed.length < files.length) {
    error.value = `已过滤 ${files.length - allowed.length} 个不支持的文件（仅支持 PDF/Word/Markdown/TXT）`;
  }
  const next = allowed.map((file) => ({
    id: crypto.randomUUID(),
    file,
    name: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));
  // 同名去重（重新选择的同路径文件视为覆盖旧选择）
  const existing = new Map(pendingFiles.value.map((p) => [p.name, p]));
  next.forEach((p) => existing.set(p.name, p));
  pendingFiles.value = [...existing.values()];
}

function removePending(id: string) {
  pendingFiles.value = pendingFiles.value.filter((p) => p.id !== id);
}

/** 清空已选 */
function clearSelection() {
  pendingFiles.value = [];
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

/** 是否恰有一个可编辑的文本文件（txt/md），用于双击编辑 */
const singleTextPending = computed(() => {
  if (pendingFiles.value.length !== 1) return null;
  const p = pendingFiles.value[0];
  return /\.(txt|md|markdown)$/i.test(p.name) ? p : null;
});

const totalPendingSize = computed(() => pendingFiles.value.reduce((s, p) => s + p.file.size, 0));

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询文档列表，直到没有 pending/processing 的文档（后台队列处理完） */
async function waitUntilProcessed() {
  for (let i = 0; i < 60; i++) {
    await load();
    const busy = list.value.some((d) => d.status === 'pending' || d.status === 'processing');
    if (!busy) return;
    await sleep(2000);
  }
}

async function handleUpload() {
  const files = pendingFiles.value;
  if (!files.length) return;

  // 空文件拦截（整个批次先检查）
  const empty = files.find((f) => f.file.size === 0);
  if (empty) {
    error.value = `「${empty.name}」内容为空，无法解析`;
    return;
  }
  // 同名文件 → 后端会替换旧版，整批确认一次
  const dup = files.find((f) => list.value.some((d) => d.filename === f.name));
  if (
    dup &&
    // eslint-disable-next-line no-alert
    !window.confirm(
      `存在同名文件「${dup.name}」，上传后将替换旧版（旧文档及其向量数据将被删除）。继续？`,
    )
  ) {
    return;
  }

  uploading.value = true;
  error.value = '';
  uploadErrors.value = [];
  uploadTotal.value = files.length;
  try {
    // 逐个提交（后台队列异步处理，接口秒回）；单文件提交失败不影响后续
    for (let i = 0; i < files.length; i++) {
      uploadIndex.value = i + 1;
      const p = files[i];
      try {
        await uploadDocument(
          knowledgeBaseId,
          p.file,
          (percent) => (uploadPercent.value = percent),
          p.name,
        );
      } catch (e) {
        uploadErrors.value.push(`${p.name}: ${(e as Error).message}`);
      }
    }
    pendingFiles.value = [];
    uploadPercent.value = null; // 提交完成，进入后台处理阶段
    // 轮询等待队列处理完毕（前端可见 排队中→解析中→已完成 的状态流转）
    await waitUntilProcessed();
    await load();
  } finally {
    uploading.value = false;
    uploadPercent.value = null;
    uploadIndex.value = 0;
    uploadTotal.value = 0;
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

/** 下载原文件（axios blob 带 token，绕开 JSON 拦截器） */
async function handleDownload(doc: Document) {
  try {
    const blob = await downloadDocumentFile(knowledgeBaseId, doc.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = doc.filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// ==================== 更新（重新上传替换） ====================
// 本地修改文件后，重新上传会替换旧文档（删除旧文档及其向量，再入库新内容）
const updatingId = ref<string | null>(null);

function onReplaceFileChange(e: Event, docId: string) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  // eslint-disable-next-line no-alert
  if (!window.confirm(`用「${file.name}」替换当前文档？旧文档及其向量数据将被删除。`)) return;
  handleReplace(docId, file);
}

/** 轮询等待指定文档处理完成（队列异步） */
async function waitForDoc(id: string) {
  for (let i = 0; i < 60; i++) {
    await load();
    const d = list.value.find((x) => x.id === id);
    if (!d || d.status === 'done' || d.status === 'failed') return;
    await sleep(2000);
  }
}

async function handleReplace(docId: string, file: File) {
  updatingId.value = docId;
  error.value = '';
  try {
    const oldDoc = list.value.find((d) => d.id === docId);
    // 先提交新版本（后台队列处理），等新文档处理完成后再删旧版——避免中间真空期、失败不丢旧数据
    const created = await uploadDocument(knowledgeBaseId, file);
    await waitForDoc(created.id);
    // 若新旧文件名相同，后端队列已自动替换（旧文档已被删），无需再手动删（否则会 404 报"文档不存在"）
    if (created.filename !== oldDoc?.filename) {
      await deleteDocument(knowledgeBaseId, docId);
    }
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    updatingId.value = null;
  }
}

// ==================== 在线编辑（改名 / 改内容后重新向量化） ====================
const editingDoc = ref<Document | null>(null);
const editFilename = ref('');
const editContent = ref('');
const loadingContent = ref(false);
const savingEdit = ref(false);

async function openDocEdit(doc: Document) {
  editingDoc.value = doc;
  editFilename.value = doc.filename;
  editContent.value = '';
  loadingContent.value = true;
  error.value = '';
  try {
    const data = await getDocumentContent(knowledgeBaseId, doc.id);
    editContent.value = data.content;
  } catch (e) {
    error.value = (e as Error).message;
    editingDoc.value = null;
  } finally {
    loadingContent.value = false;
  }
}

async function saveDocEdit() {
  const doc = editingDoc.value;
  if (!doc) return;
  savingEdit.value = true;
  error.value = '';
  try {
    await updateDocument(knowledgeBaseId, doc.id, {
      filename: editFilename.value.trim(),
      content: editContent.value,
    });
    editingDoc.value = null;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    savingEdit.value = false;
  }
}

// ==================== 上传前编辑文本（txt / md 可先改再传） ====================
const showDraftEditor = ref(false);
const draftContent = ref('');
const loadingDraft = ref(false);

/** 纯文本类文件支持上传前在线编辑（仅单个 txt/md 选中时） */
const selectedIsText = computed(() => !!singleTextPending.value);

async function openDraftEditor() {
  const p = singleTextPending.value;
  if (!p) return;
  loadingDraft.value = true;
  draftContent.value = '';
  showDraftEditor.value = true;
  try {
    draftContent.value = await p.file.text();
  } finally {
    loadingDraft.value = false;
  }
}

/** 用编辑后的文本替换待上传文件（内容变了，文件名/相对路径保持不变） */
async function saveDraft() {
  const p = singleTextPending.value;
  if (!p) return;
  const edited = new File([draftContent.value], p.name, { type: 'text/plain' });
  pendingFiles.value = [
    { id: p.id, file: edited, name: p.name },
    ...pendingFiles.value.filter((x) => x.id !== p.id),
  ];
  showDraftEditor.value = false;
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
          支持 PDF / Word(.docx) / Markdown / TXT，单个文件 ≤ 20MB；本地修改文件后可「更新」重新入库
        </p>
      </div>
    </div>

    <!-- 上传区：选择文件/目录 → 双击编辑 → 解析文件 -->
    <div class="mb-8 rounded-lg border border-dashed bg-card p-6">
      <div class="flex flex-col items-center gap-3">
        <input
          ref="fileInput"
          type="file"
          multiple
          accept=".pdf,.docx,.md,.markdown,.txt"
          class="hidden"
          @change="onFileChange"
        />
        <input ref="dirInput" type="file" webkitdirectory class="hidden" @change="onDirChange" />
        <div class="flex flex-wrap items-center justify-center gap-3">
          <Button variant="outline" :disabled="uploading" @click="fileInput?.click()">
            <FolderOpen class="h-4 w-4" />
            选择文件（可多选）
          </Button>
          <Button variant="outline" :disabled="uploading" @click="dirInput?.click()">
            <FolderTree class="h-4 w-4" />
            选择目录
          </Button>
        </div>

        <!-- 已选文件列表：双击 txt/md 可先编辑 -->
        <div v-if="pendingFiles.length" class="w-full max-w-xl space-y-1">
          <div
            v-for="p in pendingFiles"
            :key="p.id"
            class="group flex cursor-pointer items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-sm transition-colors hover:bg-muted"
            :title="
              singleTextPending?.id === p.id ? '双击编辑文本后，再点「解析文件」入库' : undefined
            "
            @dblclick="singleTextPending?.id === p.id && openDraftEditor()"
          >
            <FileText class="h-4 w-4 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
            <span class="shrink-0 text-xs text-muted-foreground">
              {{ formatFileSize(p.file.size) }}
            </span>
            <button
              class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
              title="移除"
              @click="removePending(p.id)"
            >
              <X class="h-3.5 w-3.5" />
            </button>
          </div>
          <div class="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {{ pendingFiles.length }} 个文件 · 共 {{ formatFileSize(totalPendingSize) }}
            </span>
            <button class="text-destructive hover:underline" @click="clearSelection">清空</button>
          </div>
        </div>

        <!-- 解析文件 -->
        <div class="flex flex-col items-center gap-2">
          <Button :disabled="!pendingFiles.length || uploading" @click="handleUpload">
            <Loader2 v-if="uploading" class="h-4 w-4 animate-spin" />
            <Sparkles v-else class="h-4 w-4" />
            {{
              uploading
                ? `正在解析 ${uploadIndex}/${uploadTotal}...`
                : `解析文件${pendingFiles.length ? `（${pendingFiles.length} 个）` : ''}`
            }}
          </Button>
          <p v-if="!uploading" class="text-xs text-muted-foreground">
            {{
              singleTextPending
                ? '双击文件可先编辑文本，再解析入库'
                : '支持多选文件或整目录上传；PDF/Word 上传后可在列表中点 ✏️ 在线编辑'
            }}
          </p>
        </div>

        <!-- 批量上传进度 -->
        <div v-if="uploading" class="w-full max-w-md">
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              class="h-full bg-primary transition-all duration-200"
              :style="{ width: (uploadPercent ?? 0) + '%' }"
            />
          </div>
          <p class="mt-2 text-center text-xs text-muted-foreground">
            第 {{ uploadIndex }}/{{ uploadTotal }} 个 ·
            {{
              uploadPercent === null
                ? '已提交，后台解析向量化中（列表会显示状态流转）...'
                : '上传 ' + uploadPercent + '%'
            }}
          </p>
        </div>

        <!-- 批量失败汇总 -->
        <div
          v-if="uploadErrors.length"
          class="w-full max-w-md rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          <p class="font-medium text-destructive">以下文件处理失败：</p>
          <ul class="mt-1 list-inside list-disc text-xs text-muted-foreground">
            <li v-for="(msg, i) in uploadErrors" :key="i">{{ msg }}</li>
          </ul>
        </div>

        <p v-if="error && !uploading" class="text-center text-sm text-destructive">
          <AlertCircle class="mr-1 inline h-4 w-4" /> {{ error }}
        </p>
      </div>
    </div>

    <!-- 文档列表 -->
    <div v-if="loading" class="flex justify-center py-16">
      <Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
    </div>

    <div v-else-if="list.length === 0" class="rounded-lg border border-dashed py-16 text-center">
      <FileText class="mx-auto h-10 w-10 text-muted-foreground/50" />
      <p class="mt-3 text-sm text-muted-foreground">还没有文档，上传一个试试</p>
    </div>

    <div v-else class="overflow-x-auto rounded-lg border">
      <table class="w-full min-w-[760px] text-sm">
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
              <div class="flex items-center justify-end gap-1">
                <!-- 在线编辑（改名 / 改内容后重新向量化） -->
                <button
                  class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  :title="'编辑 ' + doc.filename"
                  @click="openDocEdit(doc)"
                >
                  <Pencil class="h-4 w-4" />
                </button>
                <!-- 下载原文件 -->
                <button
                  class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  :title="'下载 ' + doc.filename"
                  @click="handleDownload(doc)"
                >
                  <Download class="h-4 w-4" />
                </button>
                <!-- 更新（重新上传替换） -->
                <label
                  class="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  :title="'更新（重新上传替换）'"
                >
                  <Loader2 v-if="updatingId === doc.id" class="h-4 w-4 animate-spin" />
                  <RefreshCw v-else class="h-4 w-4" />
                  <input
                    type="file"
                    accept=".pdf,.docx,.md,.markdown,.txt"
                    class="hidden"
                    :disabled="updatingId !== null"
                    @change="onReplaceFileChange($event, doc.id)"
                  />
                </label>
                <!-- 删除 -->
                <button
                  class="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  :title="'删除 ' + doc.filename"
                  @click="handleDelete(doc.id, doc.filename)"
                >
                  <Trash2 class="h-4 w-4" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 在线编辑文档弹窗（改名 / 改内容 → 重新分块向量化） -->
    <div
      v-if="editingDoc"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="editingDoc = null"
    >
      <div
        class="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border bg-card p-5 shadow-xl"
      >
        <h3 class="text-base font-semibold">编辑文档</h3>
        <p class="mt-1 text-xs text-muted-foreground">
          修改后自动重新分块并向量化，之后的问题按新内容检索。
          修改只更新知识库中的版本；需要本地副本请用列表中的「下载」。
        </p>
        <div class="mt-4 space-y-3">
          <div class="space-y-1.5">
            <Label>文件名</Label>
            <Input v-model="editFilename" placeholder="文件名" />
          </div>
          <div class="space-y-1.5">
            <Label>内容</Label>
            <div v-if="loadingContent" class="flex justify-center py-10">
              <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
            <textarea
              v-else
              v-model="editContent"
              rows="14"
              class="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-mono leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="文档文本内容..."
            />
          </div>
        </div>
        <p v-if="error" class="mt-3 text-sm text-destructive">{{ error }}</p>
        <div class="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="editingDoc = null">取消</Button>
          <Button
            size="sm"
            :disabled="savingEdit || loadingContent || !editFilename.trim()"
            @click="saveDocEdit"
          >
            <Loader2 v-if="savingEdit" class="h-4 w-4 animate-spin" />
            {{ savingEdit ? '保存并重新向量化...' : '保存' }}
          </Button>
        </div>
      </div>
    </div>

    <!-- 上传前编辑文本弹窗（txt / md） -->
    <div
      v-if="showDraftEditor"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="showDraftEditor = false"
    >
      <div
        class="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border bg-card p-5 shadow-xl"
      >
        <h3 class="text-base font-semibold">编辑文本</h3>
        <p class="mt-1 text-xs text-muted-foreground">
          修改完成后点击「保存草稿」，再用编辑后的内容上传入库
        </p>
        <div class="mt-4 flex-1 overflow-y-auto">
          <div v-if="loadingDraft" class="flex justify-center py-10">
            <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
          <textarea
            v-else
            v-model="draftContent"
            rows="16"
            class="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-mono leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="文本内容..."
          />
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="showDraftEditor = false">取消</Button>
          <Button size="sm" @click="saveDraft">保存草稿</Button>
        </div>
      </div>
    </div>
  </div>
</template>
