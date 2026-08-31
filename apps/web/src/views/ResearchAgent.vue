<script setup lang="ts">
defineOptions({ name: 'ResearchAgentView' });
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import {
  PauseCircle,
  PlayCircle,
  Loader2,
  Download,
  Check,
  Sparkles,
  RefreshCw,
  Zap,
  Timer,
  CheckCircle2,
  Circle,
} from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import AgentTaskSidebar from '@/components/research/AgentTaskSidebar.vue';
import AgentCreateForm from '@/components/research/AgentCreateForm.vue';
import AgentExtendModal from '@/components/research/AgentExtendModal.vue';
import AgentReportView from '@/components/research/AgentReportView.vue';
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
import type { AgentTask, AgentMode, AgentDirection } from '@/types/research-agent';
import type { ModelConfig } from '@/types/model-config';

// ==================== 预算档位 ====================

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
const extending = ref(false);
const confirming = ref(false);
const redecomposing = ref(false);

let pollTimer: ReturnType<typeof setInterval> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;
const now = ref(Date.now());

// ==================== 派生数据 ====================

const PRESETS = [
  { key: 'quick', label: '快速', tokens: 100_000, minutes: 40, desc: '约 40 分钟' },
  { key: 'standard', label: '标准', tokens: 200_000, minutes: 90, desc: '约 1.5 小时' },
  { key: 'deep', label: '深度', tokens: 300_000, minutes: 120, desc: '约 2 小时' },
  { key: 'custom', label: '自定义', tokens: 0, minutes: 0, desc: '1万~50万' },
];

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
  extendOpen.value = true;
}

async function handleExtend(tokens: number, minutes: number) {
  if (tokens < 0 || minutes < 0) return;
  if (tokens === 0 && minutes === 0) {
    toast.error('请至少追加 token 预算或续时');
    return;
  }
  extending.value = true;
  try {
    const t = current.value;
    if (!t) return;
    const updated = await extendAgentTask(t.id, {
      extraTokens: tokens || undefined,
      extraMinutes: minutes || undefined,
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
    <AgentTaskSidebar
      :tasks="tasks"
      :current-id="currentId"
      :loading="loading"
      @new="handleNew"
      @select="selectTask"
      @delete="handleDelete"
    />

    <!-- 右侧：新建 / 进度 / 报告 -->
    <main class="flex flex-1 flex-col overflow-hidden">
      <!-- ========== 新建表单 ========== -->
      <AgentCreateForm
        v-if="!currentId"
        :mode="mode"
        :goal="goal"
        :start-at="startAt"
        :end-at="endAt"
        :preset-key="presetKey"
        :custom-tokens="customTokens"
        :selected-tokens="selectedTokens"
        :selected-minutes="selectedMinutes"
        :creating="creating"
        :error="error"
        :model-configs="modelConfigs"
        @update:mode="mode = $event"
        @update:goal="goal = $event"
        @update:start-at="startAt = $event"
        @update:end-at="endAt = $event"
        @update:preset-key="presetKey = $event"
        @update:custom-tokens="customTokens = $event"
        @pick-preset="pickPreset"
        @custom-tokens="onCustomTokens"
        @create="handleCreate"
      />

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
          <div v-if="current.status === 'awaiting_confirm'" class="mx-auto max-w-4xl px-4 py-6">
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
          <div v-else-if="polling" class="mx-auto max-w-4xl px-4 py-6">
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
          <div v-else-if="current.status === 'stopped'" class="mx-auto max-w-6xl px-4 py-6">
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
              <AgentReportView :task="current" />
            </template>
            <p v-else class="py-8 text-center text-sm text-muted-foreground">
              已停止，暂无可整理的研究内容（可继续研究，让 Agent 先读一些资料）
            </p>
          </div>

          <!-- 完成：摘要卡片 + 一个方向一个卡片 + 来源 -->
          <div v-else-if="current.report" class="mx-auto max-w-6xl px-4 py-6">
            <AgentReportView :task="current" />
          </div>

          <div v-else class="flex justify-center py-16 text-sm text-muted-foreground">
            暂无报告内容
          </div>
        </div>
      </div>
    </main>

    <!-- 续时/加预算弹窗 -->
    <AgentExtendModal
      :open="extendOpen"
      :extending="extending"
      @close="extendOpen = false"
      @confirm="handleExtend"
    />
  </div>
</template>
