<script setup lang="ts">
defineOptions({ name: 'ResearchView' });
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import {
  FileText,
  Plus,
  Trash2,
  Loader2,
  BookOpen,
  Sparkles,
  Download,
  MessageSquare,
  Database,
} from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import DocPreviewDrawer from '@/components/DocPreviewDrawer.vue';
import ListSkeleton from '@/components/skeletons/ListSkeleton.vue';
import { toast } from '@/composables/useToast';
import { getReports, getReport, createReport, deleteReport } from '@/api/research';
import { getKnowledgeBases } from '@/api/knowledge';
import { getModelConfigs } from '@/api/model-configs';
import { renderMarkdown, getCopyCode } from '@/utils/markdown';
import type { Report, ReportSource } from '@/types/research';
import type { KnowledgeBase } from '@/types/knowledge';
import type { ModelConfig } from '@/types/model-config';

// ==================== 状态 ====================
const reports = ref<Report[]>([]);
const currentId = ref<string | null>(null);
const current = ref<Report | null>(null);
const loading = ref(false);
const error = ref('');

const topic = ref(''); // 研究主题
const creating = ref(false);
const kbs = ref<KnowledgeBase[]>([]);
const scope = ref<'all' | 'specific'>('all'); // 检索范围：全部 / 指定
const pickingKbIds = ref<string[]>([]);

// BYO：报告生成使用用户默认模型配置（未绑定则无法生成，用于前端引导提示）
const modelConfigs = ref<ModelConfig[]>([]);
async function loadModelConfigs() {
  try {
    modelConfigs.value = await getModelConfigs();
  } catch {
    modelConfigs.value = [];
  }
}

// 文档预览抽屉（点击来源定位原文）
const previewDocId = ref<string | null>(null);
const previewChunkIndex = ref<number | null>(null);

let pollTimer: ReturnType<typeof setInterval> | null = null;

/** 生成进度文案（按 status + step） */
const progressText = computed(() => {
  const r = current.value;
  if (!r) return '';
  switch (r.status) {
    case 'pending':
      return '已提交，排队中...';
    case 'processing':
      if (r.step === 1) return '正在拆解研究问题...';
      if (r.step === 2) return '正在检索知识库资料并撰写章节...';
      if (r.step === 3) return '正在汇总成完整报告...';
      return '正在生成中...';
    case 'done':
      return '已完成';
    case 'failed':
      return '生成失败';
  }
});

const generating = computed(
  () => current.value?.status === 'pending' || current.value?.status === 'processing',
);

/** 状态徽章样式（含暗色适配） */
function statusClass(s: Report['status']): string {
  switch (s) {
    case 'done':
      return 'bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-400';
    case 'failed':
      return 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-400';
    case 'processing':
    case 'pending':
      return 'bg-yellow-50 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-400';
  }
}
const statusText: Record<Report['status'], string> = {
  pending: '排队中',
  processing: '生成中',
  done: '已完成',
  failed: '失败',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ==================== 数据加载 ====================

async function loadReports() {
  loading.value = true;
  try {
    reports.value = await getReports();
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function selectReport(id: string) {
  currentId.value = id;
  // 记忆当前报告：切到别的导航再回来，仍停留在该报告
  sessionStorage.setItem('research-active-report', id);
  error.value = '';
  try {
    current.value = await getReport(id);
    if (current.value && generating.value) startPolling();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

/** 轮询生成进度（1.5s），完成后停止 */
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (!currentId.value) return;
    try {
      const r = await getReport(currentId.value);
      current.value = r;
      const i = reports.value.findIndex((x) => x.id === r.id);
      if (i >= 0) reports.value[i] = r;
      if (r.status === 'done' || r.status === 'failed') stopPolling();
    } catch {
      stopPolling();
    }
  }, 1500);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ==================== 新建报告 ====================

async function openKbs() {
  if (kbs.value.length === 0) {
    try {
      kbs.value = await getKnowledgeBases();
    } catch {
      kbs.value = [];
    }
  }
}

/** 点「新建报告」：回到创建表单（清空当前选中并停掉轮询） */
async function handleNew() {
  stopPolling();
  currentId.value = null;
  current.value = null;
  error.value = '';
  await openKbs();
}

async function handleCreate() {
  const t = topic.value.trim();
  if (!t || creating.value) return;
  creating.value = true;
  try {
    const kbIds = scope.value === 'specific' ? [...pickingKbIds.value] : [];
    const report = await createReport({ topic: t, knowledgeBaseIds: kbIds });
    reports.value.unshift(report);
    topic.value = '';
    pickingKbIds.value = [];
    await selectReport(report.id);
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    creating.value = false;
  }
}

async function handleDelete(id: string) {
  // eslint-disable-next-line no-alert
  if (!window.confirm('删除这份研究报告？')) return;
  try {
    await deleteReport(id);
    if (currentId.value === id) {
      currentId.value = null;
      current.value = null;
      stopPolling();
    }
    await loadReports();
    toast.success('研究报告已删除');
  } catch (e) {
    toast.error((e as Error).message);
  }
}

// ==================== 报告渲染 ====================

/** 点击复制代码按钮（事件委托，同对话页） */
async function handleReportClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (target.classList.contains('code-copy')) {
    const code = getCopyCode(target);
    if (code) {
      await navigator.clipboard.writeText(code);
      target.textContent = '已复制';
      setTimeout(() => (target.textContent = '复制'), 1500);
    }
  }
}

/** 导出报告为 Markdown（前端直接下载，无需后端） */
function handleExport() {
  const r = current.value;
  if (!r?.content) return;
  const blob = new Blob([r.content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${r.topic}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

/** 点击来源 → 定位到原文文本块 */
function openSource(src: ReportSource) {
  previewDocId.value = src.documentId;
  previewChunkIndex.value = src.chunkIndex;
}

function similarityPercent(s: number): string {
  return `${Math.round(s * 100)}%`;
}

onMounted(async () => {
  await loadReports();
  // 优先恢复上次的报告（切导航再回来仍停留）；不存在则选第一个
  const saved = sessionStorage.getItem('research-active-report');
  if (saved && reports.value.some((r) => r.id === saved)) {
    await selectReport(saved);
  } else if (reports.value.length > 0) {
    await selectReport(reports.value[0].id);
  }
  await loadModelConfigs();
});

onBeforeUnmount(stopPolling);
</script>

<template>
  <div class="flex h-[calc(100dvh-4rem-1px)] overflow-hidden">
    <!-- 左侧：报告列表 -->
    <aside class="flex w-64 flex-col border-r bg-card/50">
      <div class="p-3">
        <Button class="w-full" @click="handleNew">
          <Plus class="h-4 w-4" />
          新建报告
        </Button>
      </div>
      <div class="flex-1 overflow-y-auto px-2 pb-2">
        <div v-if="loading" class="py-2">
          <ListSkeleton :rows="6" />
        </div>
        <div
          v-for="r in reports"
          :key="r.id"
          role="button"
          tabindex="0"
          class="mb-1 flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm transition-colors"
          :class="
            r.id === currentId ? 'bg-primary/10 text-primary' : 'hover:bg-accent text-foreground'
          "
          @click="selectReport(r.id)"
          @keydown.enter="selectReport(r.id)"
        >
          <FileText class="h-4 w-4 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate">{{ r.topic }}</span>
          <span class="shrink-0 rounded px-1.5 py-0.5 text-[10px]" :class="statusClass(r.status)">
            {{ statusText[r.status] }}
          </span>
          <button
            class="shrink-0 rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:opacity-100 hover:text-destructive"
            title="删除报告"
            @click.stop="handleDelete(r.id)"
          >
            <Trash2 class="h-3.5 w-3.5" />
          </button>
        </div>
        <p
          v-if="!loading && reports.length === 0"
          class="py-8 text-center text-xs text-muted-foreground"
        >
          还没有研究报告
        </p>
      </div>
    </aside>

    <!-- 右侧：新建 / 进度 / 报告内容 -->
    <main class="flex flex-1 flex-col overflow-hidden">
      <!-- 新建表单（没有当前报告或点了新建） -->
      <div
        v-if="!currentId"
        class="flex flex-1 flex-col items-center justify-center overflow-y-auto p-6"
      >
        <div class="w-full max-w-2xl">
          <!-- 未绑定模型：前置引导（报告生成依赖用户自己的 Key） -->
          <div
            v-if="modelConfigs.length === 0"
            class="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm"
          >
            <span class="text-muted-foreground">
              研究报告由你自己的大模型 Key 生成，请先绑定模型配置
            </span>
            <RouterLink
              to="/model-configs"
              class="shrink-0 font-medium text-primary hover:underline"
            >
              去绑定 →
            </RouterLink>
          </div>
          <div class="mb-6 text-center">
            <BookOpen class="mx-auto h-12 w-12 text-primary/60" />
            <h1 class="mt-3 text-2xl font-bold tracking-tight">研究报告</h1>
            <p class="mt-2 text-sm text-muted-foreground">
              丢一个研究主题，系统自动拆解子问题、检索你的知识库、分节撰写并汇总成完整报告，每段带引用可溯源
            </p>
          </div>
          <div class="rounded-lg border bg-card p-5">
            <div class="space-y-1.5">
              <label class="text-sm font-medium" for="research-topic">研究主题</label>
              <Input
                id="research-topic"
                v-model="topic"
                placeholder="例如：RAG 技术的实现原理与工程落地"
                :disabled="creating"
                @keydown.enter="handleCreate"
              />
            </div>
            <div class="mt-4">
              <p class="text-sm font-medium">检索范围</p>
              <div class="mt-1.5 space-y-1.5">
                <label
                  class="flex cursor-pointer items-center gap-2 rounded-md border p-2.5 text-sm transition-colors hover:bg-accent"
                  :class="scope === 'all' ? 'border-primary' : ''"
                >
                  <input v-model="scope" type="radio" value="all" class="h-3.5 w-3.5" />
                  <span class="font-medium">全部知识库</span>
                  <span class="ml-auto text-xs text-muted-foreground">搜索你所有资料</span>
                </label>
                <label
                  class="flex cursor-pointer items-center gap-2 rounded-md border p-2.5 text-sm transition-colors hover:bg-accent"
                  :class="scope === 'specific' ? 'border-primary' : ''"
                >
                  <input v-model="scope" type="radio" value="specific" class="h-3.5 w-3.5" />
                  <span class="font-medium">指定知识库</span>
                  <span class="ml-auto text-xs text-muted-foreground">只检索选中的库</span>
                </label>
                <div v-if="scope === 'specific'" class="space-y-1 border-l-2 border-muted pl-3">
                  <label
                    v-for="kb in kbs"
                    :key="kb.id"
                    class="flex cursor-pointer items-center gap-2 py-1 text-sm"
                  >
                    <input
                      v-model="pickingKbIds"
                      type="checkbox"
                      :value="kb.id"
                      class="h-3.5 w-3.5"
                    />
                    <span class="min-w-0 flex-1 truncate">{{ kb.name }}</span>
                    <span class="shrink-0 text-xs text-muted-foreground"
                      >{{ kb._count?.documents ?? 0 }} 个文档</span
                    >
                  </label>
                  <p v-if="kbs.length === 0" class="py-1 text-xs text-muted-foreground">
                    还没有知识库，先去「知识库」页上传文档
                  </p>
                </div>
              </div>
            </div>
            <p v-if="error" class="mt-3 text-sm text-destructive">{{ error }}</p>
            <Button
              class="mt-4 w-full"
              :disabled="
                creating ||
                modelConfigs.length === 0 ||
                !topic.trim() ||
                (scope === 'specific' && pickingKbIds.length === 0)
              "
              @click="handleCreate"
            >
              <Loader2 v-if="creating" class="h-4 w-4 animate-spin" />
              <Sparkles v-else class="h-4 w-4" />
              {{
                creating
                  ? '提交中...'
                  : modelConfigs.length === 0
                    ? '请先绑定模型配置'
                    : '开始生成报告'
              }}
            </Button>
            <p class="mt-2 text-center text-[11px] text-muted-foreground">
              生成约需 1~2 分钟（异步任务），完成后可导出 Markdown
            </p>
          </div>
        </div>
      </div>

      <!-- 报告内容区 -->
      <div v-else-if="current" class="flex flex-1 flex-col overflow-hidden">
        <!-- 头部：主题 + 状态 + 操作 -->
        <div class="flex flex-wrap items-center gap-2 border-b bg-card/50 px-4 py-2.5">
          <h2 class="min-w-0 flex-1 truncate text-sm font-semibold">{{ current.topic }}</h2>
          <span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {{ formatTime(current.createdAt) }}
          </span>
          <span
            class="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
            :class="statusClass(current.status)"
          >
            {{ statusText[current.status] }}
          </span>
          <Button
            v-if="current.status === 'done' && current.content"
            variant="ghost"
            size="sm"
            title="把报告导出为 Markdown 文件"
            @click="handleExport"
          >
            <Download class="h-4 w-4" />
            导出
          </Button>
        </div>

        <div class="flex-1 overflow-y-auto">
          <!-- 生成中：进度 -->
          <div
            v-if="generating"
            class="flex flex-col items-center justify-center py-24 text-center"
          >
            <Loader2 class="h-8 w-8 animate-spin text-primary" />
            <p class="mt-4 text-sm font-medium">{{ progressText }}</p>
            <p class="mt-1 text-xs text-muted-foreground">
              正在检索你的知识库资料并撰写章节，请稍候
            </p>
          </div>

          <!-- 失败 -->
          <div
            v-else-if="current.status === 'failed'"
            class="flex flex-col items-center justify-center py-24 text-center"
          >
            <p class="text-sm text-destructive">生成失败：{{ current.error || '未知错误' }}</p>
            <Button
              variant="outline"
              size="sm"
              class="mt-4"
              @click="
                currentId = null;
                current = null;
              "
            >
              重新生成
            </Button>
          </div>

          <!-- 完成：报告正文 + 来源 -->
          <div v-else-if="current.content" class="mx-auto max-w-6xl px-4 py-6">
            <div
              class="markdown-body rounded-lg border bg-card px-5 py-4"
              @click="handleReportClick"
              v-html="renderMarkdown(current.content)"
            />

            <!-- 引用来源 -->
            <div v-if="current.sources?.length" class="mt-4">
              <details class="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
                <summary class="cursor-pointer font-medium text-muted-foreground">
                  📚 引用来源（{{ current.sources.length }} 条，点击可定位原文）
                </summary>
                <ul class="mt-2 space-y-1.5">
                  <li
                    v-for="src in current.sources"
                    :key="src.number"
                    class="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent/60"
                    :title="'点击定位到原文第 ' + (src.chunkIndex + 1) + ' 段'"
                    @click="openSource(src)"
                  >
                    <span
                      class="mt-0.5 shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                    >
                      来源{{ src.number }}
                    </span>
                    <span class="min-w-0">
                      <span class="font-medium text-foreground">{{ src.filename }}</span>
                      <span class="ml-1.5">相似度 {{ similarityPercent(src.similarity) }}</span>
                      <span class="ml-1.5">第 {{ src.chunkIndex + 1 }} 段</span>
                    </span>
                  </li>
                </ul>
              </details>
            </div>
          </div>

          <div v-else class="flex justify-center py-16 text-sm text-muted-foreground">
            报告内容为空
          </div>
        </div>
      </div>
    </main>

    <!-- 文档预览抽屉：点击来源定位原文 -->
    <DocPreviewDrawer
      :document-id="previewDocId"
      :highlight-chunk-index="previewChunkIndex"
      @close="
        previewDocId = null;
        previewChunkIndex = null;
      "
    />
  </div>
</template>

<style scoped>
/* AI 报告的 Markdown 排版（正文放大不加粗，标题按等级加粗+大小） */
.markdown-body {
  font-size: 1.25rem;
  font-weight: 400;
  color: var(--foreground);
}
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  font-weight: 700;
  line-height: 1.3;
  margin: 0.75em 0 0.4em;
}
.markdown-body :deep(h1) {
  font-size: 1.5em;
  font-weight: 700;
}
.markdown-body :deep(h2) {
  font-size: 1.32em;
  font-weight: 700;
}
.markdown-body :deep(h3) {
  font-size: 1.16em;
  font-weight: 700;
}
.markdown-body :deep(h4) {
  font-size: 1.05em;
  font-weight: 600;
}
.markdown-body :deep(p) {
  margin: 0.5em 0;
  line-height: 1.8;
  font-size: 1.25rem;
  font-weight: 400;
}
.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.5em;
}
.markdown-body :deep(li) {
  margin: 0.25em 0;
  font-size: 1.25rem;
}
.markdown-body :deep(a) {
  color: var(--primary);
  text-decoration: underline;
}
.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--border);
  padding-left: 0.75em;
  color: hsl(var(--foreground) / 0.72);
  margin: 0.5em 0;
}
.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 0.5em 0;
  font-size: 0.9em;
}
.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--border);
  padding: 0.35em 0.6em;
}
.markdown-body :deep(code:not(pre code)) {
  background: hsl(var(--muted));
  border-radius: 4px;
  padding: 0.1em 0.35em;
  font-size: 0.95em;
  color: var(--foreground);
}
.markdown-body :deep(.code-block) {
  position: relative;
  margin: 0.6em 0;
}
.markdown-body :deep(.code-block pre) {
  border-radius: 8px;
  overflow-x: auto;
  padding: 0.9em 1em;
  font-size: 0.95em;
  line-height: 1.6;
  background: hsl(var(--muted));
  color: var(--foreground);
}
.markdown-body :deep(.code-copy) {
  position: absolute;
  top: 6px;
  right: 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--card);
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
  color: var(--muted-foreground);
}
.markdown-body :deep(.code-copy:hover) {
  color: var(--foreground);
  border-color: var(--foreground);
}
</style>
