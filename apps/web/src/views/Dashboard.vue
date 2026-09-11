<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRouter } from 'vue-router';
// echarts 按需引入：只注册用到的图表与组件，砍掉整包体积
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ECharts } from 'echarts/core';
echarts.use([
  LineChart,
  BarChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);
import {
  Database,
  FileText,
  Layers,
  MessageSquare,
  Coins,
  TrendingUp,
  BookOpen,
  Bot,
  Brain,
  RefreshCw,
  AlertTriangle,
} from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import { getOverview, type OverviewData, type StatsRange } from '@/api/stats';
import DashboardSkeleton from '@/components/skeletons/DashboardSkeleton.vue';
import { toast } from '@/composables/useToast';

const router = useRouter();
const data = ref<OverviewData | null>(null);
const loading = ref(true);
const error = ref('');
const range = ref<StatsRange>('7');

/** 模型/构成/趋势三块：左卡高度锁定为右列高度，模型多时左卡内部滚动 */
const modelCardRef = ref<HTMLElement | null>(null);
const modelBoxRef = ref<HTMLElement | null>(null);
const rightColRef = ref<HTMLElement | null>(null);

const questionsChart = ref<HTMLElement | null>(null);
const stackChart = ref<HTMLElement | null>(null);
const hourlyChart = ref<HTMLElement | null>(null);
const donutChart = ref<HTMLElement | null>(null);
type ChartKey = 'questions' | 'stack' | 'hourly' | 'donut';
const instances: Partial<Record<ChartKey, ECharts>> = {};

const RANGE_LABEL: Record<StatsRange, string> = { '7': '近 7 日', '30': '近 30 日', all: '全部' };
const RANGE_OPTIONS: Array<{ value: StatsRange; label: string }> = [
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
  { value: 'all', label: '全部' },
];

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await getOverview(range.value);
  } catch (e) {
    error.value = (e as Error).message;
    toast.error((e as Error).message);
  } finally {
    loading.value = false;
  }
  // 注意：必须等 loading 关闭、v-else-if 分支把图表容器渲染出来后再初始化图表
  await nextTick();
  renderCharts();
  syncTokenRow();
}

function switchRange(r: StatsRange) {
  if (range.value === r) return;
  range.value = r;
  void load();
}

/** 左卡高度 = 右列（构成 + 趋势）高度；超出部分左卡内部滚动（需求：两列等高、模型多则滚动） */
function syncTokenRow() {
  const card = modelCardRef.value;
  const right = rightColRef.value;
  const box = modelBoxRef.value;
  if (!card || !right || !box) return;
  const h = right.offsetHeight;
  if (h <= 0) return;
  card.style.height = `${h}px`;
  const headH = box.getBoundingClientRect().top - card.getBoundingClientRect().top;
  box.style.maxHeight = `${Math.max(120, h - headH - 12)}px`;
}

function renderCharts() {
  const d = data.value;
  if (!d) return;

  if (questionsChart.value) {
    instances.questions ??= echarts.init(questionsChart.value);
    const prev = d.prevDailyQuestions;
    const series: Array<Record<string, unknown>> = [
      {
        name: '本期',
        type: 'line',
        smooth: true,
        symbolSize: 6,
        areaStyle: { opacity: 0.15 },
        data: d.daily.map((x) => x.questions),
      },
    ];
    // 上期对比（虚线；只有同粒度才有上期数据）
    if (prev.length === d.daily.length) {
      series.push({
        name: '上一周期',
        type: 'line',
        smooth: true,
        symbolSize: 0,
        lineStyle: { type: 'dashed', width: 1.4, color: '#9ca3af' },
        itemStyle: { color: '#9ca3af' },
        data: prev,
      });
    }
    instances.questions.setOption({
      tooltip: { trigger: 'axis' },
      legend: { top: 0, right: 0, itemWidth: 12, itemHeight: 8, textStyle: { fontSize: 11 } },
      grid: { left: 40, right: 12, top: 28, bottom: 26 },
      xAxis: { type: 'category', data: d.daily.map((x) => x.key) },
      yAxis: { type: 'value', minInterval: 1 },
      series,
    });
  }

  if (stackChart.value) {
    instances.stack ??= echarts.init(stackChart.value);
    instances.stack.setOption({
      tooltip: { trigger: 'axis' },
      grid: { left: 46, right: 12, top: 12, bottom: 24 },
      xAxis: { type: 'category', data: d.daily.map((x) => x.key) },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmtTokens(v) } },
      series: [
        {
          name: '对话',
          type: 'bar',
          stack: 'tokens',
          barMaxWidth: 26,
          itemStyle: { color: '#3b82f6' },
          data: d.daily.map((x) => x.tokens),
        },
        {
          name: '研究报告',
          type: 'bar',
          stack: 'tokens',
          barMaxWidth: 26,
          itemStyle: { color: '#8b5cf6' },
          data: d.daily.map((x) => x.reportTokens),
        },
        {
          name: '自主研究',
          type: 'bar',
          stack: 'tokens',
          barMaxWidth: 26,
          itemStyle: { color: '#14b8a6' },
          data: d.daily.map((x) => x.agentTokens),
        },
      ],
    });
  }

  if (hourlyChart.value) {
    instances.hourly ??= echarts.init(hourlyChart.value);
    instances.hourly.setOption({
      tooltip: {
        trigger: 'axis',
        formatter: (p: Array<{ name: string; value: number }>) =>
          `${p[0]?.name}:00 — ${p[0]?.value ?? 0} 次提问`,
      },
      grid: { left: 36, right: 12, top: 12, bottom: 24 },
      xAxis: {
        type: 'category',
        data: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')),
        axisLabel: { interval: 2 },
      },
      yAxis: { type: 'value', minInterval: 1 },
      series: [
        {
          name: '提问数',
          type: 'bar',
          barMaxWidth: 14,
          itemStyle: { color: '#3b82f6', borderRadius: [3, 3, 0, 0] },
          data: d.hourly,
        },
      ],
    });
  }

  if (donutChart.value) {
    instances.donut ??= echarts.init(donutChart.value);
    instances.donut.setOption({
      tooltip: {
        trigger: 'item',
        formatter: (p: { name: string; value: number; percent: number }) =>
          `${p.name}：${fmtTokens(p.value)}（${p.percent}%）`,
      },
      legend: { bottom: 0, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: 11 } },
      series: [
        {
          type: 'pie',
          radius: ['52%', '76%'],
          center: ['50%', '44%'],
          avoidLabelOverlap: true,
          label: { show: false },
          data: [
            { name: '对话', value: d.tokens.chat, itemStyle: { color: '#3b82f6' } },
            { name: '研究报告', value: d.tokens.report, itemStyle: { color: '#8b5cf6' } },
            { name: '自主研究', value: d.tokens.agent, itemStyle: { color: '#14b8a6' } },
          ],
        },
      ],
    });
  }
}

function onResize() {
  Object.values(instances).forEach((i) => i?.resize());
  syncTokenRow();
}

onMounted(() => {
  void load();
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  Object.values(instances).forEach((i) => i?.dispose());
});

// ==================== 展示辅助 ====================

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const updatedAt = computed(() => (data.value ? fmtDateTime(data.value.generatedAt) : ''));

function deltaText(delta: number | null): string {
  if (delta === null) return '—';
  const v = delta * 100;
  if (Math.abs(v) < 0.5) return '· 0%';
  const arrow = v > 0 ? '↑' : '↓';
  return `${arrow}${Math.abs(v) >= 10 ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(1)}%`;
}

function deltaClass(delta: number | null): string {
  if (delta === null || Math.abs(delta) < 0.005) return 'bg-muted text-muted-foreground';
  return delta > 0
    ? 'bg-green-50 text-green-600 dark:bg-green-500/10 dark:text-green-400'
    : 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400';
}

/** KPI 四联（首卡 = Token 总消耗，用户最关心的排第一） */
const kpiCards = computed(() => {
  const d = data.value;
  if (!d) return [];
  const label = RANGE_LABEL[d.range];
  return [
    {
      key: 'tokens',
      label: `${label} Token 总消耗`,
      value: fmtTokens(d.kpi.tokens),
      delta: d.kpi.tokensDelta,
      hint: '对话 + 研究报告 + 自主研究 · 较上一周期',
      hero: true,
    },
    {
      key: 'today',
      label: '今日提问',
      value: String(d.kpi.todayQuestions),
      delta: d.kpi.todayDelta,
      hint: '较昨日',
    },
    {
      key: 'questions',
      label: `${label}提问`,
      value: String(d.kpi.questions),
      delta: d.kpi.questionsDelta,
      hint: '较上一周期',
    },
    {
      key: 'failed',
      label: '文档处理失败',
      value: String(d.kpi.docFailed),
      warn: d.kpi.docFailed > 0,
      hint: d.kpi.docFailed > 0 ? '可到知识库页重传' : '全部正常',
    },
  ];
});

/** 资产规模小卡 */
const assetItems = computed(() => {
  const a = data.value?.assets;
  if (!a) return [];
  return [
    { k: '知识库', v: String(a.kbs), icon: Database },
    { k: '文档', v: String(a.documents), icon: FileText },
    { k: '文本块 Chunk', v: fmtTokens(a.chunks), s: `均 ${a.avgChunksPerDoc}/文档`, icon: Layers },
    { k: '会话', v: String(a.sessions), icon: MessageSquare },
    { k: '跨会话事实记忆', v: String(a.memories), s: '条', icon: Brain },
  ];
});

const docSegments = computed(() => {
  const h = data.value?.docHealth;
  if (!h) return [];
  const total = Math.max(1, h.done + h.processing + h.failed);
  return [
    { name: '已处理', value: h.done, color: 'bg-green-500', pct: (h.done / total) * 100 },
    {
      name: '处理中',
      value: h.processing,
      color: 'bg-amber-500',
      pct: (h.processing / total) * 100,
    },
    { name: '失败', value: h.failed, color: 'bg-red-500', pct: (h.failed / total) * 100 },
  ];
});

const researchSegments = computed(() => {
  const s = data.value?.research.status;
  if (!s) return [];
  const total = Math.max(1, s.done + s.running + s.stopped + s.failed);
  return [
    { name: '完成', value: s.done, color: 'bg-green-500', pct: (s.done / total) * 100 },
    { name: '进行中', value: s.running, color: 'bg-blue-500', pct: (s.running / total) * 100 },
    { name: '已停止', value: s.stopped, color: 'bg-gray-400', pct: (s.stopped / total) * 100 },
    { name: '失败', value: s.failed, color: 'bg-red-500', pct: (s.failed / total) * 100 },
  ];
});

const CATEGORY_LABEL: Record<string, string> = {
  background: '背景',
  preference: '偏好',
  goal: '目标',
  general: '其他',
};

const memoryMax = computed(() =>
  Math.max(1, ...(data.value?.memory.byCategory ?? []).map((c) => c.count)),
);

const modelMax = computed(() => Math.max(1, ...(data.value?.models ?? []).map((m) => m.tokens)));
const modelTotal = computed(() =>
  Math.max(
    1,
    (data.value?.models ?? []).reduce((a, b) => a + b.tokens, 0),
  ),
);

/** 空态：还没有任何知识库与会话时给引导，而不是一排 0 */
const isEmpty = computed(() => {
  const d = data.value;
  if (!d) return false;
  return d.assets.kbs === 0 && d.assets.sessions === 0 && d.kpi.tokens === 0;
});

function goSessions(sessionId?: string) {
  void router.push(sessionId ? { path: '/chat', query: { session: sessionId } } : '/chat');
}
</script>

<template>
  <div class="container py-10">
    <div class="mb-6 flex flex-wrap items-end gap-3">
      <div class="min-w-[240px] flex-1">
        <h1 class="text-2xl font-bold tracking-tight">数据看板</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          知识库规模 · 对话活跃度 · 各模型 Token 消耗 · 研究任务效率（流式 usage 记录）
        </p>
      </div>
      <div class="flex items-center gap-2">
        <div class="inline-flex overflow-hidden rounded-lg border bg-card">
          <button
            v-for="opt in RANGE_OPTIONS"
            :key="opt.value"
            class="px-3 py-1.5 text-xs transition-colors"
            :class="
              range === opt.value
                ? 'bg-primary font-semibold text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted'
            "
            @click="switchRange(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
        <Button variant="outline" size="sm" :disabled="loading" @click="load">
          <RefreshCw class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" />
          刷新
        </Button>
      </div>
    </div>
    <p v-if="updatedAt" class="-mt-4 mb-4 text-right text-[11px] text-muted-foreground">
      数据更新于 {{ updatedAt }}
    </p>

    <div v-if="loading" class="py-4">
      <DashboardSkeleton />
    </div>

    <p
      v-else-if="error"
      class="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
    >
      {{ error }}
    </p>

    <template v-else-if="data">
      <!-- 空态引导：一个都没有时，看板给下一步而不是一排 0 -->
      <div
        v-if="isEmpty"
        class="rounded-lg border border-primary/30 bg-primary/5 px-5 py-6 text-sm"
      >
        <p class="font-medium">还没有可统计的数据</p>
        <p class="mt-1 text-muted-foreground">
          先建一个知识库并上传文档，或直接开始一次对话 —— 这里会自动出现提问趋势、各模型 Token
          消耗与资料引用排行。
        </p>
        <Button size="sm" class="mt-3" @click="goSessions">开始对话</Button>
      </div>

      <template v-else>
        <!-- ① 环比 KPI（首卡 = Token 总消耗） -->
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div
            v-for="c in kpiCards"
            :key="c.key"
            class="rounded-lg border bg-card p-5"
            :class="c.hero ? 'border-primary/40' : ''"
          >
            <div class="flex items-center gap-2 text-muted-foreground">
              <span class="text-xs">{{ c.label }}</span>
            </div>
            <div class="mt-2 flex items-baseline gap-2">
              <span class="text-2xl font-bold">{{ c.value }}</span>
              <span
                v-if="c.warn"
                class="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-600 dark:bg-amber-500/10 dark:text-amber-400"
              >
                ⚠ 需处理
              </span>
              <span
                v-else-if="c.delta !== undefined"
                class="rounded-full px-2 py-0.5 text-xs font-semibold"
                :class="deltaClass(c.delta ?? null)"
              >
                {{ deltaText(c.delta ?? null) }}
              </span>
            </div>
            <p class="mt-1 text-xs text-muted-foreground">{{ c.hint }}</p>
          </div>
        </div>

        <!-- ② Token 消耗：左=各模型拆分（高度锁右列，超出内部滚动）；右=构成 + 趋势 -->
        <div class="mt-4 grid gap-4 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
          <div ref="modelCardRef" class="flex flex-col rounded-lg border bg-card p-5 lg:min-h-0">
            <h3 class="text-sm font-semibold">各模型 Token 消耗</h3>
            <p class="mt-0.5 text-xs text-muted-foreground">
              按模型归因（BYO Key：这里就是你的账单结构）· 含调用次数与环比 ·
              仅统计记录模型名之后的对话
            </p>
            <div ref="modelBoxRef" class="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
              <div
                v-if="data.models.length === 0"
                class="py-6 text-center text-xs text-muted-foreground"
              >
                暂无归因数据 —— 记录模型名之后的新对话会出现在这里
              </div>
              <div v-for="m in data.models" :key="m.model" class="mb-4 last:mb-0">
                <div class="flex items-baseline justify-between gap-3 text-xs">
                  <span class="min-w-0 flex-1 truncate font-semibold">{{ m.model }}</span>
                  <span class="flex shrink-0 items-center gap-2">
                    <span
                      v-if="m.delta !== null"
                      class="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                      :class="deltaClass(m.delta)"
                    >
                      {{ deltaText(m.delta) }}
                    </span>
                    <b class="text-sm">{{ fmtTokens(m.tokens) }}</b>
                    <span class="text-muted-foreground">
                      {{ ((m.tokens / modelTotal) * 100).toFixed(0) }}%
                    </span>
                  </span>
                </div>
                <div class="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    class="h-full rounded-full bg-primary"
                    :style="{ width: `${(m.tokens / modelMax) * 100}%` }"
                  />
                </div>
                <p class="mt-1 text-[11px] text-muted-foreground">
                  {{ m.calls }} 次调用 · 均
                  {{ fmtTokens(Math.round(m.tokens / Math.max(1, m.calls))) }}/次
                </p>
              </div>
            </div>
          </div>

          <div ref="rightColRef" class="grid gap-4">
            <div class="rounded-lg border bg-card p-5">
              <h3 class="text-sm font-semibold">Token 构成</h3>
              <p class="mt-0.5 text-xs text-muted-foreground">
                对话 / 研究报告 / 自主研究（免费模型的 token 同样计入）
              </p>
              <div ref="donutChart" class="mt-2 h-44" />
            </div>
            <div class="rounded-lg border bg-card p-5">
              <h3 class="text-sm font-semibold">Token 消耗趋势</h3>
              <p class="mt-0.5 text-xs text-muted-foreground">
                堆叠：对话 / 研究报告 / 自主研究 · 随顶部范围联动
              </p>
              <div ref="stackChart" class="mt-2 h-44" />
            </div>
          </div>
        </div>

        <!-- ③ 资产与健康 -->
        <div class="mt-4 grid gap-4 lg:grid-cols-2">
          <div class="rounded-lg border bg-card p-5">
            <h3 class="text-sm font-semibold">资产规模</h3>
            <p class="mt-0.5 text-xs text-muted-foreground">知识库 / 文档 / 切块 / 会话 / 记忆</p>
            <div class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div
                v-for="a in assetItems"
                :key="a.k"
                class="rounded-lg border bg-muted/30 px-3 py-2.5"
              >
                <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <component :is="a.icon" class="h-3 w-3" />
                  {{ a.k }}
                </div>
                <p class="mt-1 text-lg font-bold">{{ a.v }}</p>
                <p v-if="a.s" class="text-[11px] text-muted-foreground">{{ a.s }}</p>
              </div>
            </div>
          </div>
          <div class="rounded-lg border bg-card p-5">
            <h3 class="text-sm font-semibold">文档处理健康度</h3>
            <p class="mt-0.5 text-xs text-muted-foreground">
              失败文档可直接点进知识库重传（唯一能“去处理”的指标）
            </p>
            <div class="mt-4 flex h-2.5 overflow-hidden rounded-full bg-muted">
              <span
                v-for="s in docSegments"
                :key="s.name"
                :class="s.color"
                :style="{ width: `${s.pct}%` }"
              />
            </div>
            <div class="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span v-for="s in docSegments" :key="s.name">
                <span class="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm" :class="s.color" />
                {{ s.name }} {{ s.value }}
              </span>
            </div>
            <div
              v-if="data.docHealth.failed > 0"
              class="mt-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-50/60 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
            >
              <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                有 {{ data.docHealth.failed }} 个文档向量化失败（常见原因：embedding 限流 /
                文件解析异常）→ 到知识库页重传即可。
              </span>
            </div>
          </div>
        </div>

        <!-- ④ 活跃度趋势 -->
        <div class="mt-4 grid gap-4 lg:grid-cols-2">
          <div class="rounded-lg border bg-card p-5">
            <h3 class="text-sm font-semibold">提问数趋势</h3>
            <p class="mt-0.5 text-xs text-muted-foreground">
              实线 = 本期 · 虚线 = 上一等长周期（{{ RANGE_LABEL[data.range] }}）
            </p>
            <div ref="questionsChart" class="mt-2 h-56" />
          </div>
          <div class="rounded-lg border bg-card p-5">
            <h3 class="text-sm font-semibold">提问时段分布</h3>
            <p class="mt-0.5 text-xs text-muted-foreground">24 小时（Asia/Shanghai）· 使用习惯</p>
            <div ref="hourlyChart" class="mt-2 h-56" />
          </div>
        </div>

        <!-- ⑤ 研究与记忆 -->
        <div class="mt-4 grid gap-4 lg:grid-cols-2">
          <div class="rounded-lg border bg-card p-5">
            <h3 class="text-sm font-semibold">研究任务</h3>
            <p class="mt-0.5 text-xs text-muted-foreground">状态分布（失败 / 停止不再被藏起来）</p>
            <div class="mt-4 flex h-2.5 overflow-hidden rounded-full bg-muted">
              <span
                v-for="s in researchSegments"
                :key="s.name"
                :class="s.color"
                :style="{ width: `${s.pct}%` }"
              />
            </div>
            <div class="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span v-for="s in researchSegments" :key="s.name">
                <span class="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm" :class="s.color" />
                {{ s.name }} {{ s.value }}
              </span>
            </div>
            <div class="mt-4 grid grid-cols-3 gap-3">
              <div class="rounded-lg border bg-muted/30 px-3 py-2.5">
                <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Bot class="h-3 w-3" /> 平均搜索轮数
                </div>
                <p class="mt-1 text-lg font-bold">{{ data.research.avgSearchRounds }}</p>
              </div>
              <div class="rounded-lg border bg-muted/30 px-3 py-2.5">
                <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <BookOpen class="h-3 w-3" /> 平均精读页面
                </div>
                <p class="mt-1 text-lg font-bold">{{ data.research.avgPagesRead }}</p>
              </div>
              <div class="rounded-lg border bg-muted/30 px-3 py-2.5">
                <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Coins class="h-3 w-3" /> 报告均 token
                </div>
                <p class="mt-1 text-lg font-bold">
                  {{ fmtTokens(data.research.avgReportTokens) }}
                </p>
              </div>
            </div>
          </div>
          <div class="rounded-lg border bg-card p-5">
            <h3 class="text-sm font-semibold">记忆系统</h3>
            <p class="mt-0.5 text-xs text-muted-foreground">
              模块 A 滚动摘要 + 模块 B 跨会话事实记忆
            </p>
            <div class="mt-3 grid grid-cols-3 gap-3">
              <div class="rounded-lg border bg-muted/30 px-3 py-2.5">
                <div class="text-[11px] text-muted-foreground">启用摘要的会话</div>
                <p class="mt-1 text-lg font-bold">{{ data.assets.sessionsWithSummary }}</p>
              </div>
              <div class="rounded-lg border bg-muted/30 px-3 py-2.5">
                <div class="text-[11px] text-muted-foreground">事实记忆</div>
                <p class="mt-1 text-lg font-bold">{{ data.memory.total }}</p>
              </div>
              <div class="rounded-lg border bg-muted/30 px-3 py-2.5">
                <div class="text-[11px] text-muted-foreground">原文窗口</div>
                <p class="mt-1 text-lg font-bold">3 轮</p>
              </div>
            </div>
            <div v-if="data.memory.byCategory.length" class="mt-4 space-y-2">
              <div
                v-for="c in data.memory.byCategory"
                :key="c.category"
                class="flex items-center gap-2 text-xs"
              >
                <span class="w-14 shrink-0 text-muted-foreground">
                  {{ CATEGORY_LABEL[c.category] ?? c.category }}
                </span>
                <span class="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    class="block h-full rounded-full bg-primary"
                    :style="{ width: `${(c.count / memoryMax) * 100}%` }"
                  />
                </span>
                <span class="w-8 shrink-0 text-right font-medium">{{ c.count }}</span>
              </div>
            </div>
            <p v-else class="mt-4 text-xs text-muted-foreground">
              还没有事实记忆 —— 聊天中提到你的背景/偏好/目标后会自动抽取
            </p>
          </div>
        </div>

        <!-- ⑥ 归因明细 -->
        <div class="mt-4 grid gap-4 lg:grid-cols-2">
          <div class="rounded-lg border bg-card p-5">
            <h3 class="text-sm font-semibold">最烧 Token 的会话 Top5</h3>
            <p class="mt-0.5 text-xs text-muted-foreground">成本归因 · 点击进入该会话</p>
            <div v-if="data.topSessions.length" class="mt-3 divide-y">
              <button
                v-for="s in data.topSessions"
                :key="s.id"
                class="flex w-full items-center gap-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/50"
                @click="goSessions(s.id)"
              >
                <span class="min-w-0 flex-1">
                  <span class="block truncate">{{ s.title }}</span>
                  <span class="text-[11px] text-muted-foreground">
                    {{ s.model ?? '未选模型' }} · {{ s.messages }} 条
                  </span>
                </span>
                <span class="flex w-28 shrink-0 items-center gap-2">
                  <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      class="block h-full rounded-full bg-primary"
                      :style="{
                        width: `${(s.tokens / (data.topSessions[0]?.tokens || 1)) * 100}%`,
                      }"
                    />
                  </span>
                  <b class="text-xs">{{ fmtTokens(s.tokens) }}</b>
                </span>
              </button>
            </div>
            <p v-else class="mt-3 text-xs text-muted-foreground">本期暂无对话消耗</p>
          </div>
          <div class="rounded-lg border bg-card p-5">
            <h3 class="text-sm font-semibold">被引用最多的资料 Top5</h3>
            <p class="mt-0.5 text-xs text-muted-foreground">
              从回答的引用来源聚合 —— “哪些文档真正进了回答”
            </p>
            <div v-if="data.topCited.length" class="mt-3 divide-y">
              <div
                v-for="c in data.topCited"
                :key="`${c.kb}-${c.filename}`"
                class="flex items-center gap-3 py-2.5 text-sm"
              >
                <span class="min-w-0 flex-1">
                  <span class="block truncate">{{ c.filename }}</span>
                  <span class="text-[11px] text-muted-foreground">{{
                    c.kb ?? '（未知知识库）'
                  }}</span>
                </span>
                <span class="flex w-24 shrink-0 items-center gap-2">
                  <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      class="block h-full rounded-full bg-purple-500"
                      :style="{
                        width: `${(c.hits / (data.topCited[0]?.hits || 1)) * 100}%`,
                      }"
                    />
                  </span>
                  <b class="text-xs">{{ c.hits }}</b>
                </span>
              </div>
            </div>
            <p v-else class="mt-3 text-xs text-muted-foreground">本期暂无引用记录</p>
          </div>
        </div>

        <!-- ⑦ 最近活跃的知识库 -->
        <div class="mt-4 rounded-lg border bg-card p-5">
          <h3 class="text-sm font-semibold">最近活跃的知识库</h3>
          <p class="mt-0.5 text-xs text-muted-foreground">
            文档数 / 切块数 / 本期被引用次数 / 最近更新
          </p>
          <div v-if="data.topKbs.length" class="mt-2 overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-[11px] text-muted-foreground">
                  <th class="py-2">知识库</th>
                  <th class="py-2 text-right">文档</th>
                  <th class="py-2 text-right">Chunk</th>
                  <th class="py-2 text-right">本期被引用</th>
                  <th class="py-2 text-right">最近更新</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="kb in data.topKbs" :key="kb.id" class="border-t">
                  <td class="py-2.5 font-medium">{{ kb.name }}</td>
                  <td class="py-2.5 text-right">{{ kb.documents }}</td>
                  <td class="py-2.5 text-right">{{ fmtTokens(kb.chunks) }}</td>
                  <td class="py-2.5 text-right">{{ kb.cited }}</td>
                  <td class="py-2.5 text-right text-xs text-muted-foreground">
                    {{ fmtTime(kb.updatedAt) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="mt-3 text-xs text-muted-foreground">还没有知识库</p>
        </div>
      </template>
    </template>
  </div>
</template>
