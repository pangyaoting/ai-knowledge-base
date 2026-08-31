<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import {
  Bot,
  Plus,
  Trash2,
  Loader2,
  Download,
  PauseCircle,
  PlayCircle,
  CheckCircle2,
  Circle,
  ExternalLink,
  Timer,
  Zap,
  Sparkles,
  ChevronRight,
  RefreshCw,
  Check,
} from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import ListSkeleton from '@/components/skeletons/ListSkeleton.vue';
import { toast } from '@/composables/useToast';
import {
  getAgentTasks,
  getAgentTask,
  createAgentTask,
  stopAgentTask,
  confirmAgentTask,
  redecomposeAgentTask,
  extendAgentTask,
  deleteAgentTask,
} from '@/api/research-agent';
import { getModelConfigs } from '@/api/model-configs';
import { renderMarkdown, getCopyCode } from '@/utils/markdown';
import type { AgentTask, AgentMode, AgentDirection } from '@/types/research-agent';
import type { ModelConfig } from '@/types/model-config';

// ==================== 预算档位 ====================

interface Preset {
  key: string;
  label: string;
  tokens: number;
  minutes: number;
  desc: string;
}
const PRESETS: Preset[] = [
  { key: 'quick', label: '快速', tokens: 100_000, minutes: 40, desc: '约 40 分钟' },
  { key: 'standard', label: '标准', tokens: 200_000, minutes: 90, desc: '约 1.5 小时' },
  { key: 'deep', label: '深度', tokens: 300_000, minutes: 120, desc: '约 2 小时' },
  { key: 'custom', label: '自定义', tokens: 0, minutes: 0, desc: '1万~50万' },
];

/** 预算 → 预估分钟（与后端一致：10万≈40分钟，封顶 6 小时） */
function estimateMinutes(tokens: number): number {
  return Math.min(360, Math.round((tokens / 100_000) * 40));
}

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ==================== 状态 ====================

const tasks = ref<AgentTask[]>([]);
const currentId = ref<string | null>(null);
const current = ref<AgentTask | null>(null);
const loading = ref(false);
const error = ref('');

const mode = ref<AgentMode>('targeted'); // 定向研究 / 自主探索
const goal = ref('');
const startAt = ref(toLocalInput(new Date()));
// 首次进入表单（不点"新建"）也要有默认结束时间：按快速档（10万≈40分钟）预填
const endAt = ref(toLocalInput(new Date(Date.now() + 40 * 60_000)));
const presetKey = ref('quick');
const customTokens = ref(200_000); // 自定义档位 token 数
const creating = ref(false);

const modelConfigs = ref<ModelConfig[]>([]);
const extendOpen = ref(false);
const extTokens = ref(0);
const extMinutes = ref(30);
const extending = ref(false);
const confirming = ref(false);
const redecomposing = ref(false);

let pollTimer: ReturnType<typeof setInterval> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;
const now = ref(Date.now());

// ==================== 派生数据 ====================

const selectedTokens = computed(() => {
  const p = PRESETS.find((x) => x.key === presetKey.value);
  if (!p) return 0;
  return p.key === 'custom' ? customTokens.value : p.tokens;
});
const selectedMinutes = computed(() => estimateMinutes(selectedTokens.value));

const budgetPercent = computed(() => {
  const t = current.value;
  // 总预算 = 研究预算 + 固定 12k 报告整理预算（停止/完成时自动把笔记整理成正式报告）
  const total = (t?.tokenBudget ?? 0) + 12000;
  if (!total) return 0;
  return Math.min(100, Math.round(((t?.tokensUsed ?? 0) / total) * 100));
});

const remainingMs = computed(() => {
  const t = current.value;
  if (!t) return 0;
  return new Date(t.endAt).getTime() - now.value;
});

const remainingText = computed(() => {
  const ms = remainingMs.value;
  if (ms <= 0) return '已到结束时间';
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return m > 0 ? `剩余 ${m} 分钟` : `剩余 ${s} 秒`;
});

/** 是否在轮询（未结束，或已停止但阶段报告还没写完；取消的任务不会再有报告，不轮询） */
const polling = computed(() => {
  const t = current.value;
  if (!t) return false;
  return (
    t.status === 'pending' ||
    t.status === 'awaiting_confirm' ||
    t.status === 'running' ||
    (t.status === 'stopped' && !t.report && t.stopReason !== 'cancelled')
  );
});

const stopReasonText: Record<string, string> = {
  budget_exhausted: '预算用尽',
  time_exhausted: '到达设定时间',
  user_stopped: '手动停止',
  cancelled: '未开始已取消',
  completed: '研究完成',
  error: '出错',
};

const statusText: Record<AgentTask['status'], string> = {
  pending: '排队中',
  awaiting_confirm: '待确认',
  running: '研究中',
  stopped: '已停止',
  done: '已完成',
  failed: '失败',
};

function statusClass(s: AgentTask['status']): string {
  switch (s) {
    case 'done':
      return 'bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-400';
    case 'failed':
      return 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-400';
    case 'stopped':
      return 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400';
    case 'awaiting_confirm':
      return 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400';
    default:
      return 'bg-yellow-50 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-400';
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtTokens(n: number): string {
  return n >= 10_000 ? `${(n / 10_000).toFixed(n % 10_000 === 0 ? 0 : 1)}万` : String(n);
}

// ==================== 数据加载 ====================

async function loadTasks() {
  loading.value = true;
  try {
    tasks.value = await getAgentTasks();
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function loadModelConfigs() {
  try {
    modelConfigs.value = await getModelConfigs();
  } catch {
    modelConfigs.value = [];
  }
}

async function selectTask(id: string) {
  currentId.value = id;
  // 记忆当前任务：切到别的导航再回来，仍停留在该任务
  sessionStorage.setItem('research-agent-active-task', id);
  error.value = '';
  try {
    current.value = await getAgentTask(id);
    startPolling();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

/** 轮询进度（2.5s），结束或阶段报告出来后停止 */
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (!currentId.value) return;
    try {
      const t = await getAgentTask(currentId.value);
      current.value = t;
      const i = tasks.value.findIndex((x) => x.id === t.id);
      if (i >= 0) tasks.value[i] = t;
      if (!polling.value) stopPolling();
    } catch {
      stopPolling();
    }
  }, 2500);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startClock() {
  stopClock();
  clockTimer = setInterval(() => (now.value = Date.now()), 1000);
}
function stopClock() {
  if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
}

// ==================== 新建任务 ====================

function handleNew() {
  stopPolling();
  currentId.value = null;
  current.value = null;
  error.value = '';
  mode.value = 'targeted';
  goal.value = '';
  presetKey.value = 'quick';
  const s = new Date();
  startAt.value = toLocalInput(s);
  endAt.value = toLocalInput(new Date(s.getTime() + 40 * 60_000));
}

function pickPreset(key: string) {
  presetKey.value = key;
  const p = PRESETS.find((x) => x.key === key);
  if (p && p.key !== 'custom') {
    endAt.value = toLocalInput(new Date(new Date(startAt.value).getTime() + p.minutes * 60_000));
  }
}

function onCustomTokens() {
  presetKey.value = 'custom';
  endAt.value = toLocalInput(
    new Date(new Date(startAt.value).getTime() + estimateMinutes(customTokens.value) * 60_000),
  );
}

async function handleCreate() {
  const s = new Date(startAt.value);
  const e = new Date(endAt.value);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
    toast.error('请填写开始与结束时间');
    return;
  }
  if (e.getTime() <= s.getTime()) {
    toast.error('结束时间必须晚于开始时间');
    return;
  }
  if (
    presetKey.value === 'custom' &&
    (customTokens.value < 10_000 || customTokens.value > 500_000)
  ) {
    toast.error('自定义预算需在 1万~50万 之间');
    return;
  }
  if (mode.value === 'targeted' && !goal.value.trim()) {
    toast.error('定向研究需要填写研究目标');
    return;
  }
  creating.value = true;
  try {
    const task = await createAgentTask({
      mode: mode.value,
      goal: mode.value === 'targeted' ? goal.value.trim() : undefined,
      startAt: startAt.value,
      endAt: endAt.value,
      tokenBudget: selectedTokens.value,
    });
    tasks.value.unshift(task);
    await selectTask(task.id);
    toast.success('研究任务已创建，正在拆解研究方向...');
  } catch (err) {
    toast.error((err as Error).message);
  } finally {
    creating.value = false;
  }
}

// ==================== 停止 / 续时 / 删除 ====================

async function handleStop() {
  const t = current.value;
  if (!t || !['pending', 'running'].includes(t.status)) return;
  try {
    current.value = await stopAgentTask(t.id);
    toast.success('已请求停止，正在整理成正式报告...');
    startPolling();
  } catch (e) {
    toast.error((e as Error).message);
  }
}

function openExtend() {
  extTokens.value = 50_000;
  extMinutes.value = 30;
  extendOpen.value = true;
}

async function handleExtend() {
  if (extTokens.value < 0 || extMinutes.value < 0) return;
  if (extTokens.value === 0 && extMinutes.value === 0) {
    toast.error('请至少追加 token 预算或续时');
    return;
  }
  extending.value = true;
  try {
    const t = current.value;
    if (!t) return;
    const updated = await extendAgentTask(t.id, {
      extraTokens: extTokens.value || undefined,
      extraMinutes: extMinutes.value || undefined,
    });
    current.value = updated;
    const i = tasks.value.findIndex((x) => x.id === t.id);
    if (i >= 0) tasks.value[i] = updated;
    extendOpen.value = false;
    toast.success('已续时/加预算，正在从断点继续研究...');
    startPolling();
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    extending.value = false;
  }
}

async function handleDelete(id: string) {
  // eslint-disable-next-line no-alert
  if (!window.confirm('删除这个研究任务？')) return;
  try {
    await deleteAgentTask(id);
    if (currentId.value === id) {
      currentId.value = null;
      current.value = null;
      stopPolling();
    }
    await loadTasks();
    toast.success('研究任务已删除');
  } catch (e) {
    toast.error((e as Error).message);
  }
}

// ==================== 报告渲染 ====================

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

function handleExport() {
  const t = current.value;
  if (!t?.report) return;
  const blob = new Blob([t.report], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(t.goal || '自主探索').slice(0, 40)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

/** 方向状态图标 */
function dirIcon(status: string) {
  if (status === 'done') return CheckCircle2;
  if (status === 'active') return Loader2;
  return Circle;
}

// ==================== 报告：摘要卡片 + 一个方向一个卡片 ====================

interface ReportSection {
  title: string;
  body: string;
  /** 在 sections 中的下标（展开状态用） */
  idx: number;
}

/** 按 `## ` 二级标题把报告拆成小节（引言/各方向/结论） */
const sections = computed<ReportSection[]>(() => {
  const report = current.value?.report;
  if (!report) return [];
  const parts = report.split(/\n## /);
  const out: ReportSection[] = [];
  for (let i = 1; i < parts.length; i++) {
    const lines = parts[i].split('\n');
    const title = lines[0].replace(/^#+\s*/, '').trim();
    const body = lines.slice(1).join('\n').trim();
    if (title) out.push({ title, body, idx: out.length });
  }
  return out;
});

const isMetaTitle = (t: string) => t === '引言' || t === '结论';
/** 方向小节（一个方向一张卡片）；过滤空内容节（旧报告可能残留重复空卡片） */
const dirSections = computed(() =>
  sections.value.filter((s) => !isMetaTitle(s.title) && s.body.trim()),
);
/** 引言 / 结论：不单独成卡片，作为正文段落自然呈现 */
const introSection = computed(() =>
  sections.value.find((s) => s.title === '引言' && s.body.trim()),
);
const conclusionSection = computed(() =>
  sections.value.find((s) => s.title === '结论' && s.body.trim()),
);

/** 已展开的方向卡片下标（默认全部折叠，点标题展开） */
const expanded = ref<Set<number>>(new Set());
const allExpanded = ref(false);

function toggleSection(i: number) {
  const next = new Set(expanded.value);
  if (next.has(i)) next.delete(i);
  else next.add(i);
  expanded.value = next;
}

function toggleAllSections() {
  allExpanded.value = !allExpanded.value;
  expanded.value = allExpanded.value ? new Set(dirSections.value.map((s) => s.idx)) : new Set();
}

// ==================== 确认 / 重新拆解 ====================

/** 方向最多拆解数（后端拆 10 个，用户从中选 5 个） */
const DIR_MAX_SELECT = 5;
/** 已选中的方向下标（默认前 5 个） */
const selectedDirs = ref<number[]>([]);

/** 方向列表变化（新拆解 / 重新拆解）时重置选择为默认前 5 个 */
const dirKey = computed(() =>
  (current.value?.directions || []).map((d) => `${d.title}|${d.question}`).join('\n'),
);
watch(dirKey, () => {
  const n = (current.value?.directions || []).length;
  selectedDirs.value = Array.from({ length: Math.min(DIR_MAX_SELECT, n) }, (_, i) => i);
});

function isSelected(i: number): boolean {
  return selectedDirs.value.includes(i);
}

function toggleDir(i: number) {
  if (isSelected(i)) {
    selectedDirs.value = selectedDirs.value.filter((x) => x !== i);
  } else {
    if (selectedDirs.value.length >= DIR_MAX_SELECT) {
      toast.error(`最多选 ${DIR_MAX_SELECT} 个方向，先取消一个再选`);
      return;
    }
    selectedDirs.value = [...selectedDirs.value, i].sort((a, b) => a - b);
  }
}

/** 去掉 question 里与 title 重复的"标题："前缀（如"技术栈演进趋势：未来两年…" → "未来两年…"） */
function cleanQuestion(d: AgentDirection): string {
  if (!d.question) return '';
  const t = (d.title || '').trim();
  if (t && d.question.startsWith(t)) {
    const rest = d.question
      .slice(t.length)
      .replace(/^[:：]\s*/, '')
      .trim();
    if (rest) return rest;
    return ''; // question 与 title 完全相同 → 不再重复显示
  }
  return d.question;
}

async function handleConfirm() {
  const t = current.value;
  if (!t || t.status !== 'awaiting_confirm') return;
  if (selectedDirs.value.length === 0) {
    toast.error('请至少选择一个研究方向');
    return;
  }
  confirming.value = true;
  try {
    const updated = await confirmAgentTask(t.id, selectedDirs.value);
    current.value = updated;
    const i = tasks.value.findIndex((x) => x.id === t.id);
    if (i >= 0) tasks.value[i] = updated;
    toast.success('已确认，Agent 开始研究');
    startPolling();
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    confirming.value = false;
  }
}

async function handleRedecompose() {
  const t = current.value;
  if (!t || t.status !== 'awaiting_confirm') return;
  redecomposing.value = true;
  try {
    const updated = await redecomposeAgentTask(t.id);
    current.value = updated;
    const i = tasks.value.findIndex((x) => x.id === t.id);
    if (i >= 0) tasks.value[i] = updated;
    toast.success('已重新拆解，稍候展示新方向');
    startPolling();
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    redecomposing.value = false;
  }
}

onMounted(async () => {
  startClock();
  await loadTasks();
  // 优先恢复上次的任务（切导航再回来仍停留）；不存在则选第一个
  const saved = sessionStorage.getItem('research-agent-active-task');
  if (saved && tasks.value.some((t) => t.id === saved)) {
    await selectTask(saved);
  } else if (tasks.value.length > 0) {
    await selectTask(tasks.value[0].id);
  }
  await loadModelConfigs();
});

onBeforeUnmount(() => {
  stopPolling();
  stopClock();
});
</script>

<template>
  <div class="flex h-[calc(100dvh-4rem-1px)] overflow-hidden">
    <!-- 左侧：任务列表 -->
    <aside class="flex w-64 flex-col border-r bg-card/50">
      <div class="p-3">
        <Button class="w-full" @click="handleNew">
          <Plus class="h-4 w-4" />
          新建研究任务
        </Button>
      </div>
      <div class="flex-1 overflow-y-auto px-2 pb-2">
        <div v-if="loading" class="py-2">
          <ListSkeleton :rows="6" />
        </div>
        <div
          v-for="t in tasks"
          :key="t.id"
          role="button"
          tabindex="0"
          class="mb-1 flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm transition-colors"
          :class="
            t.id === currentId ? 'bg-primary/10 text-primary' : 'hover:bg-accent text-foreground'
          "
          @click="selectTask(t.id)"
          @keydown.enter="selectTask(t.id)"
        >
          <Bot class="h-4 w-4 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate">{{ t.goal || '自主探索' }}</span>
          <span class="shrink-0 rounded px-1.5 py-0.5 text-[10px]" :class="statusClass(t.status)">
            {{ statusText[t.status] }}
          </span>
          <button
            class="shrink-0 rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:opacity-100 hover:text-destructive"
            title="删除任务"
            @click.stop="handleDelete(t.id)"
          >
            <Trash2 class="h-3.5 w-3.5" />
          </button>
        </div>
        <p
          v-if="!loading && tasks.length === 0"
          class="py-8 text-center text-xs text-muted-foreground"
        >
          还没有研究任务
        </p>
      </div>
    </aside>

    <!-- 右侧：新建 / 进度 / 报告 -->
    <main class="flex flex-1 flex-col overflow-hidden">
      <!-- ========== 新建表单 ========== -->
      <div v-if="!currentId" class="flex flex-1 flex-col items-center overflow-y-auto p-6">
        <div class="w-full max-w-2xl pb-8">
          <!-- 未绑定模型：前置引导（自主研究消耗用户自己的 Key） -->
          <div
            v-if="modelConfigs.length === 0"
            class="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm"
          >
            <span class="text-muted-foreground">
              自主研究由你自己的大模型 Key 驱动，请先绑定模型配置
            </span>
            <RouterLink
              to="/model-configs"
              class="shrink-0 font-medium text-primary hover:underline"
            >
              去绑定 →
            </RouterLink>
          </div>

          <div class="mb-6 text-center">
            <Bot class="mx-auto h-12 w-12 text-primary/60" />
            <h1 class="mt-3 text-2xl font-bold tracking-tight">限时 · 限量 · 自主研究</h1>
            <p class="mt-2 text-sm text-muted-foreground">
              设定时间窗与 token 预算，Agent 自动联网搜索、筛选、精读、成稿；
              预算用尽或时间到自动停止，可随时手动停止并续时继续
            </p>
          </div>

          <div class="rounded-lg border bg-card p-5">
            <!-- 模式 -->
            <p class="text-sm font-medium">研究模式</p>
            <div class="mt-1.5 grid grid-cols-2 gap-2">
              <button
                type="button"
                class="rounded-md border p-2.5 text-left text-sm transition-colors hover:bg-accent"
                :class="mode === 'targeted' ? 'border-primary bg-primary/5' : ''"
                @click="mode = 'targeted'"
              >
                <p class="font-medium">定向研究</p>
                <p class="mt-0.5 text-xs text-muted-foreground">
                  填写目标，Agent 拆解成多个方向研究
                </p>
              </button>
              <button
                type="button"
                class="rounded-md border p-2.5 text-left text-sm transition-colors hover:bg-accent"
                :class="mode === 'open' ? 'border-primary bg-primary/5' : ''"
                @click="mode = 'open'"
              >
                <p class="font-medium">自主探索</p>
                <p class="mt-0.5 text-xs text-muted-foreground">不填目标，从你的知识库中挖掘方向</p>
              </button>
            </div>

            <!-- 目标 -->
            <div v-if="mode === 'targeted'" class="mt-4 space-y-1.5">
              <label class="text-sm font-medium" for="agent-goal">研究目标</label>
              <textarea
                id="agent-goal"
                v-model="goal"
                rows="3"
                placeholder="例如：2026 年 RAG 技术的主要发展趋势与工程落地"
                class="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                :disabled="creating"
              />
            </div>

            <!-- 时间窗 -->
            <div class="mt-4 grid grid-cols-2 gap-3">
              <div class="space-y-1.5">
                <label class="text-sm font-medium" for="agent-start">开始时间</label>
                <Input
                  id="agent-start"
                  v-model="startAt"
                  type="datetime-local"
                  :disabled="creating"
                />
              </div>
              <div class="space-y-1.5">
                <label class="text-sm font-medium" for="agent-end">结束时间（停止硬上限）</label>
                <Input id="agent-end" v-model="endAt" type="datetime-local" :disabled="creating" />
              </div>
            </div>

            <!-- 预算 -->
            <div class="mt-4">
              <p class="text-sm font-medium">token 预算</p>
              <div class="mt-1.5 grid grid-cols-4 gap-2">
                <button
                  v-for="p in PRESETS"
                  :key="p.key"
                  type="button"
                  class="rounded-md border px-2 py-2 text-center text-sm transition-colors hover:bg-accent"
                  :class="presetKey === p.key ? 'border-primary bg-primary/5' : ''"
                  @click="pickPreset(p.key)"
                >
                  <p class="font-medium">{{ p.label }}</p>
                  <p class="mt-0.5 text-[11px] text-muted-foreground">
                    {{ p.key === 'custom' ? p.desc : `${fmtTokens(p.tokens)} · ${p.desc}` }}
                  </p>
                </button>
              </div>
              <div v-if="presetKey === 'custom'" class="mt-2 flex items-center gap-3">
                <Input
                  v-model.number="customTokens"
                  type="number"
                  min="10000"
                  max="500000"
                  step="10000"
                  class="w-40"
                  :disabled="creating"
                  @input="onCustomTokens"
                />
                <span class="text-xs text-muted-foreground">
                  1万 ~ 50万，预计约 {{ estimateMinutes(customTokens) }} 分钟
                </span>
              </div>
              <p class="mt-2 text-[11px] text-muted-foreground">
                预计 {{ selectedMinutes }} 分钟 · 可随时停止/续时；预算
                {{ fmtTokens(selectedTokens) }} ≈ ¥{{
                  (selectedTokens / 1000000).toFixed(2)
                }}（DeepSeek 约 ¥1/百万 token）
              </p>
            </div>

            <p v-if="error" class="mt-3 text-sm text-destructive">{{ error }}</p>
            <Button
              class="mt-4 w-full"
              :disabled="creating || modelConfigs.length === 0"
              @click="handleCreate"
            >
              <Loader2 v-if="creating" class="h-4 w-4 animate-spin" />
              <Sparkles v-else class="h-4 w-4" />
              {{
                creating
                  ? '创建中...'
                  : modelConfigs.length === 0
                    ? '请先绑定模型配置'
                    : '开始自主研究'
              }}
            </Button>
            <p class="mt-2 text-center text-[11px] text-muted-foreground">
              停止条件：token 预算用尽永远停止；否则到达你设定的结束时间即停止；手动停止随时生效。
              无论怎么停，都会先把手头笔记整理成正式报告（整理费另计 12k token，不占研究预算）
            </p>
          </div>
        </div>
      </div>

      <!-- ========== 任务详情 ========== -->
      <div v-else-if="current" class="flex flex-1 flex-col overflow-hidden">
        <!-- 头部 -->
        <div class="flex flex-wrap items-center gap-2 border-b bg-card/50 px-4 py-2.5">
          <h2 class="min-w-0 flex-1 truncate text-sm font-semibold">
            {{ current.goal || '自主探索' }}
          </h2>
          <span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {{ current.mode === 'open' ? '自主探索' : '定向研究' }}
          </span>
          <span
            class="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
            :class="statusClass(current.status)"
          >
            {{ statusText[current.status] }}
          </span>
          <span
            v-if="current.stopReason && current.stopReason !== 'completed'"
            class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            title="停止原因"
          >
            {{ stopReasonText[current.stopReason] || current.stopReason }}
          </span>
          <Button
            v-if="['pending', 'running', 'awaiting_confirm'].includes(current.status)"
            variant="destructive"
            size="sm"
            @click="handleStop"
          >
            <PauseCircle class="h-4 w-4" />
            停止
          </Button>
          <Button
            v-if="current.status === 'stopped'"
            variant="default"
            size="sm"
            @click="openExtend"
          >
            <PlayCircle class="h-4 w-4" />
            继续研究
          </Button>
          <Button
            v-if="current.report"
            variant="ghost"
            size="sm"
            title="导出为 Markdown 文件"
            @click="handleExport"
          >
            <Download class="h-4 w-4" />
            导出
          </Button>
        </div>

        <!-- 预算进度条 + 统计 -->
        <div v-if="current.status !== 'failed'" class="border-b bg-muted/30 px-4 py-3">
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <Zap class="h-3.5 w-3.5" />
            <span>
              token 已用 {{ fmtTokens(current.tokensUsed) }} /
              {{ fmtTokens(current.tokenBudget + 12000) }}
              <span class="text-[10px]">
                （研究 {{ fmtTokens(current.tokenBudget) }} + 报告整理 12k）
              </span>
            </span>
            <span class="ml-auto flex items-center gap-1">
              <Timer class="h-3.5 w-3.5" />
              {{ remainingText }}
            </span>
          </div>
          <div class="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              class="h-full rounded-full bg-blue-500 transition-all duration-500"
              :style="{ width: budgetPercent + '%' }"
            />
          </div>
          <div class="mt-1 text-right text-[11px] font-medium text-muted-foreground">
            {{ budgetPercent }}%
          </div>
          <div class="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground">
            <span>联网搜索 {{ current.searchRounds }} 轮</span>
            <span>精读 {{ current.pagesRead }} 页</span>
            <span class="ml-auto">创建于 {{ formatTime(current.createdAt) }}</span>
          </div>
        </div>

        <div class="flex-1 overflow-y-auto">
          <!-- 待确认：方向拆解完成，确认后才开始研究 -->
          <div v-if="current.status === 'awaiting_confirm'" class="mx-auto max-w-2xl px-4 py-6">
            <div class="rounded-lg border bg-card p-5">
              <div class="flex items-center gap-2">
                <Sparkles class="h-4 w-4 text-primary" />
                <p class="text-sm font-semibold">方向已拆解完成，请选择要研究的方向</p>
              </div>
              <p class="mt-1 text-xs text-muted-foreground">
                共拆解出 {{ (current.directions || []).length }} 个方向，从中选
                {{ DIR_MAX_SELECT }} 个（默认已选前 {{ DIR_MAX_SELECT }} 个）；不满意可刷新重新拆解
                （会再消耗一次拆解 token）。
              </p>
              <div class="mt-3 flex items-center gap-2 text-xs">
                <span class="font-medium text-primary"
                  >已选 {{ selectedDirs.length }} / {{ DIR_MAX_SELECT }}</span
                >
                <span class="text-muted-foreground">点击方向卡片切换选中</span>
              </div>
              <div class="mt-2 space-y-1.5">
                <div
                  v-for="(d, i) in current.directions || []"
                  :key="i"
                  role="button"
                  tabindex="0"
                  class="flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors"
                  :class="isSelected(i) ? 'border-primary bg-primary/5' : 'hover:bg-accent/60'"
                  @click="toggleDir(i)"
                  @keydown.enter="toggleDir(i)"
                >
                  <span
                    class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border"
                    :class="
                      isSelected(i)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/40'
                    "
                  >
                    <Check v-if="isSelected(i)" class="h-3 w-3" />
                  </span>
                  <span class="min-w-0">
                    <span class="block text-sm font-medium">{{ d.title }}</span>
                    <span v-if="cleanQuestion(d)" class="block text-xs text-muted-foreground">
                      {{ cleanQuestion(d) }}
                    </span>
                  </span>
                </div>
              </div>
              <div class="mt-5 flex items-center gap-2">
                <Button
                  class="flex-1"
                  :disabled="confirming || selectedDirs.length === 0"
                  @click="handleConfirm"
                >
                  <Loader2 v-if="confirming" class="h-4 w-4 animate-spin" />
                  <PlayCircle v-else class="h-4 w-4" />
                  确认开始研究
                </Button>
                <Button variant="outline" :disabled="redecomposing" @click="handleRedecompose">
                  <Loader2 v-if="redecomposing" class="h-4 w-4 animate-spin" />
                  <RefreshCw v-else class="h-4 w-4" />
                  重新拆解
                </Button>
              </div>
              <p class="mt-2 text-center text-[11px] text-muted-foreground">
                剩余 {{ remainingText }} · 时间窗从创建时开始计时，确认越晚可用研究时间越短
              </p>
            </div>
          </div>

          <!-- 运行中：方向进度 -->
          <div v-else-if="polling" class="mx-auto max-w-2xl px-4 py-6">
            <div class="rounded-lg border bg-card p-4">
              <div class="flex items-center gap-2">
                <Loader2 class="h-4 w-4 animate-spin text-primary" />
                <p class="text-sm font-medium">
                  {{
                    current.status === 'pending' ? '已提交，等待开始...' : 'Agent 正在自主研究中...'
                  }}
                </p>
              </div>
              <p v-if="current.status === 'stopped'" class="mt-1 text-xs text-muted-foreground">
                已停止，正在整理成正式报告...
              </p>
              <div v-if="current.directions?.length" class="mt-4 space-y-2">
                <div
                  v-for="(d, i) in current.directions"
                  :key="i"
                  class="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                  :class="d.status === 'active' ? 'border-primary/40 bg-primary/5' : ''"
                >
                  <component
                    :is="dirIcon(d.status)"
                    class="h-4 w-4 shrink-0"
                    :class="
                      d.status === 'active'
                        ? 'animate-spin text-primary'
                        : d.status === 'done'
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-muted-foreground'
                    "
                  />
                  <span class="min-w-0 flex-1 truncate">{{ d.title }}</span>
                  <span
                    class="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                    :class="
                      d.status === 'done'
                        ? 'bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-400'
                        : d.status === 'active'
                          ? 'bg-primary/10 text-primary'
                          : 'bg-muted text-muted-foreground'
                    "
                  >
                    {{
                      d.status === 'done' ? '已完成' : d.status === 'active' ? '研究中' : '待研究'
                    }}
                  </span>
                  <span v-if="d.rounds" class="shrink-0 text-[10px] text-muted-foreground">
                    {{ d.rounds }} 轮
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- 失败 -->
          <div
            v-else-if="current.status === 'failed'"
            class="flex flex-col items-center justify-center py-24 text-center"
          >
            <p class="text-sm text-destructive">研究失败：{{ current.error || '未知错误' }}</p>
            <Button variant="outline" size="sm" class="mt-4" @click="handleNew">重新创建</Button>
          </div>

          <!-- 已停止：阶段成果（先摘要后展开）+ 继续研究提示 -->
          <div v-else-if="current.status === 'stopped'" class="mx-auto max-w-3xl px-4 py-6">
            <div
              class="mb-4 flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10"
            >
              <p
                v-if="current.stopReason === 'cancelled'"
                class="text-amber-800 dark:text-amber-300"
              >
                🗑
                任务已取消，尚未开始研究。可点击「继续研究」按已拆解方向直接开始，或删除后重新创建。
              </p>
              <p v-else class="text-amber-800 dark:text-amber-300">
                ⏸ 研究已停止（{{
                  stopReasonText[current.stopReason || ''] || '已停止'
                }}），已整理出正式报告（含来源）。可继续研究：追加 token 预算和/或研究时长， Agent
                会从断点继续，不会从头再来。
              </p>
              <Button size="sm" class="shrink-0" @click="openExtend">
                <PlayCircle class="h-4 w-4" />
                继续研究
              </Button>
            </div>

            <template v-if="current.report">
              <!-- 摘要卡片（含全部展开/收起） -->
              <div
                v-if="current.summary"
                class="mb-4 rounded-lg border border-primary/25 bg-primary/5 px-4 py-3"
              >
                <div class="flex items-center justify-between gap-2">
                  <p class="text-xs font-semibold tracking-wide text-primary">📋 执行摘要</p>
                  <button
                    type="button"
                    class="shrink-0 text-xs font-medium text-primary hover:underline"
                    @click="toggleAllSections"
                  >
                    {{ allExpanded ? '全部收起' : '全部展开' }}
                  </button>
                </div>
                <p class="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">
                  {{ current.summary }}
                </p>
              </div>

              <!-- 引言：正文段落，不单独成卡片 -->
              <div v-if="introSection" class="mb-4">
                <p class="mb-1 text-xs font-semibold tracking-wide text-muted-foreground">
                  📖 引言
                </p>
                <div
                  class="markdown-body"
                  @click="handleReportClick"
                  v-html="renderMarkdown(introSection.body)"
                />
              </div>

              <!-- 方向卡片：一个方向一个卡片（默认折叠，点标题展开） -->
              <div class="space-y-2">
                <div
                  v-for="sec in dirSections"
                  :key="sec.idx"
                  class="overflow-hidden rounded-lg border bg-card"
                >
                  <button
                    type="button"
                    class="flex w-full select-none items-center gap-1.5 px-3 py-2.5 text-left text-sm font-semibold hover:bg-accent/60"
                    @click="toggleSection(sec.idx)"
                  >
                    <ChevronRight
                      class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform"
                      :class="expanded.has(sec.idx) ? 'rotate-90' : ''"
                    />
                    {{ sec.title }}
                  </button>
                  <div
                    v-show="expanded.has(sec.idx)"
                    class="markdown-body border-t px-4 py-3"
                    @click="handleReportClick"
                    v-html="renderMarkdown(sec.body)"
                  />
                </div>
              </div>

              <!-- 结论：正文段落，不单独成卡片 -->
              <div v-if="conclusionSection" class="mt-4">
                <p class="mb-1 text-xs font-semibold tracking-wide text-muted-foreground">
                  🏁 结论
                </p>
                <div
                  class="markdown-body"
                  @click="handleReportClick"
                  v-html="renderMarkdown(conclusionSection.body)"
                />
              </div>
            </template>
            <p v-else class="py-8 text-center text-sm text-muted-foreground">
              已停止，暂无可整理的研究内容（可继续研究，让 Agent 先读一些资料）
            </p>
          </div>

          <!-- 完成：摘要卡片 + 一个方向一个卡片 + 来源 -->
          <div v-else-if="current.report" class="mx-auto max-w-3xl px-4 py-6">
            <div
              v-if="current.summary"
              class="mb-4 rounded-lg border border-primary/25 bg-primary/5 px-4 py-3"
            >
              <div class="flex items-center justify-between gap-2">
                <p class="text-xs font-semibold tracking-wide text-primary">📋 执行摘要</p>
                <button
                  type="button"
                  class="shrink-0 text-xs font-medium text-primary hover:underline"
                  @click="toggleAllSections"
                >
                  {{ allExpanded ? '全部收起' : '全部展开' }}
                </button>
              </div>
              <p class="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">
                {{ current.summary }}
              </p>
            </div>

            <!-- 引言：正文段落，不单独成卡片 -->
            <div v-if="introSection" class="mb-4">
              <p class="mb-1 text-xs font-semibold tracking-wide text-muted-foreground">📖 引言</p>
              <div
                class="markdown-body"
                @click="handleReportClick"
                v-html="renderMarkdown(introSection.body)"
              />
            </div>

            <!-- 方向卡片：一个方向一个卡片（默认折叠，点标题展开） -->
            <div class="space-y-2">
              <div
                v-for="sec in dirSections"
                :key="sec.idx"
                class="overflow-hidden rounded-lg border bg-card"
              >
                <button
                  type="button"
                  class="flex w-full select-none items-center gap-1.5 px-3 py-2.5 text-left text-sm font-semibold hover:bg-accent/60"
                  @click="toggleSection(sec.idx)"
                >
                  <ChevronRight
                    class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform"
                    :class="expanded.has(sec.idx) ? 'rotate-90' : ''"
                  />
                  {{ sec.title }}
                </button>
                <div
                  v-show="expanded.has(sec.idx)"
                  class="markdown-body border-t px-4 py-3"
                  @click="handleReportClick"
                  v-html="renderMarkdown(sec.body)"
                />
              </div>
            </div>

            <!-- 结论：正文段落，不单独成卡片 -->
            <div v-if="conclusionSection" class="mt-4">
              <p class="mb-1 text-xs font-semibold tracking-wide text-muted-foreground">🏁 结论</p>
              <div
                class="markdown-body"
                @click="handleReportClick"
                v-html="renderMarkdown(conclusionSection.body)"
              />
            </div>
            <div v-if="current.sources?.length" class="mt-4">
              <details class="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
                <summary class="cursor-pointer font-medium text-muted-foreground">
                  🌐 引用来源（{{ current.sources.length }} 条网页）
                </summary>
                <ul class="mt-2 space-y-1.5">
                  <li
                    v-for="src in current.sources"
                    :key="src.number"
                    class="flex items-start gap-2 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent/60"
                  >
                    <span
                      class="mt-0.5 shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                    >
                      来源{{ src.number }}
                    </span>
                    <a
                      :href="src.url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="flex min-w-0 items-center gap-1 font-medium text-foreground hover:text-primary hover:underline"
                    >
                      <span class="truncate">{{ src.title || src.url }}</span>
                      <ExternalLink class="h-3 w-3 shrink-0" />
                    </a>
                  </li>
                </ul>
              </details>
            </div>
          </div>

          <div v-else class="flex justify-center py-16 text-sm text-muted-foreground">
            暂无报告内容
          </div>
        </div>
      </div>
    </main>

    <!-- 续时/加预算弹窗 -->
    <div v-if="extendOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="fixed inset-0 bg-black/40" @click="extendOpen = false" />
      <div class="relative w-full max-w-md rounded-lg border bg-card p-5 shadow-lg">
        <h3 class="text-base font-semibold">继续研究</h3>
        <p class="mt-1 text-xs text-muted-foreground">
          追加 token 预算和/或研究时长，Agent 从断点继续（不会从头再来）
        </p>

        <p class="mt-4 text-sm font-medium">追加 token 预算</p>
        <div class="mt-1.5 flex flex-wrap gap-2">
          <button
            v-for="t in [50_000, 100_000, 200_000]"
            :key="t"
            type="button"
            class="rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent"
            :class="extTokens === t ? 'border-primary bg-primary/5' : ''"
            @click="extTokens = t"
          >
            +{{ fmtTokens(t) }}
          </button>
          <button
            type="button"
            class="rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent"
            :class="extTokens === 0 ? 'border-primary bg-primary/5' : ''"
            @click="extTokens = 0"
          >
            不加
          </button>
        </div>
        <Input
          v-model.number="extTokens"
          type="number"
          min="0"
          max="500000"
          step="10000"
          class="mt-2"
          placeholder="或输入自定义追加预算（1~50万）"
        />

        <p class="mt-4 text-sm font-medium">追加研究时长（分钟）</p>
        <div class="mt-1.5 flex flex-wrap gap-2">
          <button
            v-for="m in [30, 60, 120]"
            :key="m"
            type="button"
            class="rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent"
            :class="extMinutes === m ? 'border-primary bg-primary/5' : ''"
            @click="extMinutes = m"
          >
            +{{ m }} 分钟
          </button>
          <button
            type="button"
            class="rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent"
            :class="extMinutes === 0 ? 'border-primary bg-primary/5' : ''"
            @click="extMinutes = 0"
          >
            不加
          </button>
        </div>
        <Input
          v-model.number="extMinutes"
          type="number"
          min="0"
          max="720"
          class="mt-2"
          placeholder="或输入自定义分钟数（最多 720）"
        />

        <div class="mt-5 flex gap-2">
          <Button variant="outline" class="flex-1" @click="extendOpen = false">取消</Button>
          <Button class="flex-1" :disabled="extending" @click="handleExtend">
            <Loader2 v-if="extending" class="h-4 w-4 animate-spin" />
            <PlayCircle v-else class="h-4 w-4" />
            确认继续
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* AI 报告的 Markdown 排版（复用对话页/报告页样式） */
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  font-weight: 600;
  line-height: 1.3;
  margin: 0.75em 0 0.4em;
}
.markdown-body :deep(h1) {
  font-size: 1.3em;
}
.markdown-body :deep(h2) {
  font-size: 1.15em;
}
.markdown-body :deep(h3) {
  font-size: 1.05em;
}
.markdown-body :deep(p) {
  margin: 0.5em 0;
  line-height: 1.7;
}
.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.5em;
}
.markdown-body :deep(li) {
  margin: 0.25em 0;
}
.markdown-body :deep(a) {
  color: var(--primary);
  text-decoration: underline;
}
.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--border);
  padding-left: 0.75em;
  color: var(--muted-foreground);
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
  background: var(--muted);
  border-radius: 4px;
  padding: 0.1em 0.35em;
  font-size: 0.9em;
}
.markdown-body :deep(.code-block) {
  position: relative;
  margin: 0.6em 0;
}
.markdown-body :deep(.code-block pre) {
  border-radius: 8px;
  overflow-x: auto;
  padding: 0.9em 1em;
  font-size: 0.85em;
  line-height: 1.5;
  background: hsl(var(--muted));
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
