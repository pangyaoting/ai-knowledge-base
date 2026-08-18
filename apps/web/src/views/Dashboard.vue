<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
// echarts 按需引入：只注册用到的图表与组件，砍掉整包体积
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ECharts } from 'echarts/core';
echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, CanvasRenderer]);
import {
  Database,
  FileText,
  Layers,
  MessageSquare,
  Coins,
  TrendingUp,
  Loader2,
} from 'lucide-vue-next';
import { getOverview, type OverviewData } from '@/api/stats';

const data = ref<OverviewData | null>(null);
const loading = ref(true);
const error = ref('');

const questionsChart = ref<HTMLElement | null>(null);
const tokensChart = ref<HTMLElement | null>(null);
let questionsInst: ECharts | null = null;
let tokensInst: ECharts | null = null;

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await getOverview();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
  // 注意：必须等 loading 关闭、v-else-if 分支把图表容器渲染出来后再初始化图表
  await nextTick();
  renderCharts();
}

function renderCharts() {
  const d = data.value;
  if (!d) return;

  if (questionsChart.value) {
    questionsInst ??= echarts.init(questionsChart.value);
    questionsInst.setOption({
      tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 16, top: 30, bottom: 28 },
      xAxis: { type: 'category', data: d.daily.map((x) => x.day.slice(5)) },
      yAxis: { type: 'value', minInterval: 1 },
      series: [
        {
          name: '提问数',
          type: 'line',
          smooth: true,
          symbolSize: 7,
          areaStyle: { opacity: 0.15 },
          data: d.daily.map((x) => x.questions),
        },
      ],
    });
  }

  if (tokensChart.value) {
    tokensInst ??= echarts.init(tokensChart.value);
    tokensInst.setOption({
      tooltip: { trigger: 'axis' },
      grid: { left: 50, right: 16, top: 30, bottom: 28 },
      xAxis: { type: 'category', data: d.daily.map((x) => x.day.slice(5)) },
      yAxis: { type: 'value' },
      series: [
        {
          name: 'Token 消耗',
          type: 'bar',
          barMaxWidth: 28,
          itemStyle: { borderRadius: [4, 4, 0, 0] },
          data: d.daily.map((x) => x.tokens),
        },
      ],
    });
  }
}

function onResize() {
  questionsInst?.resize();
  tokensInst?.resize();
}

onMounted(() => {
  load();
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  questionsInst?.dispose();
  tokensInst?.dispose();
});

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
</script>

<template>
  <div class="container py-10">
    <div class="mb-8">
      <h1 class="text-2xl font-bold tracking-tight">数据看板</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        知识库规模、对话活跃度与 Token 消耗统计（流式接口通过 include_usage 记录用量）
      </p>
    </div>

    <div v-if="loading" class="flex justify-center py-24">
      <Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
    </div>

    <p
      v-else-if="error"
      class="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
    >
      {{ error }}
    </p>

    <template v-else-if="data">
      <!-- 统计卡片 -->
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div class="rounded-lg border bg-card p-5">
          <div class="flex items-center gap-2 text-muted-foreground">
            <Database class="h-4 w-4" />
            <span class="text-xs">知识库</span>
          </div>
          <p class="mt-2 text-2xl font-bold">{{ data.counts.kbs }}</p>
        </div>
        <div class="rounded-lg border bg-card p-5">
          <div class="flex items-center gap-2 text-muted-foreground">
            <FileText class="h-4 w-4" />
            <span class="text-xs">文档</span>
          </div>
          <p class="mt-2 text-2xl font-bold">{{ data.counts.documents }}</p>
        </div>
        <div class="rounded-lg border bg-card p-5">
          <div class="flex items-center gap-2 text-muted-foreground">
            <Layers class="h-4 w-4" />
            <span class="text-xs">文本块 Chunk</span>
          </div>
          <p class="mt-2 text-2xl font-bold">{{ data.counts.chunks }}</p>
        </div>
        <div class="rounded-lg border bg-card p-5">
          <div class="flex items-center gap-2 text-muted-foreground">
            <MessageSquare class="h-4 w-4" />
            <span class="text-xs">消息总数</span>
          </div>
          <p class="mt-2 text-2xl font-bold">{{ data.counts.messages }}</p>
        </div>
        <div class="rounded-lg border bg-card p-5">
          <div class="flex items-center gap-2 text-muted-foreground">
            <TrendingUp class="h-4 w-4" />
            <span class="text-xs">今日提问</span>
          </div>
          <p class="mt-2 text-2xl font-bold">{{ data.counts.questionsToday }}</p>
        </div>
        <div class="rounded-lg border bg-card p-5">
          <div class="flex items-center gap-2 text-muted-foreground">
            <Coins class="h-4 w-4" />
            <span class="text-xs">Token 总消耗</span>
          </div>
          <p class="mt-2 text-2xl font-bold">{{ fmtTokens(data.tokens.total) }}</p>
          <p class="mt-1 text-xs text-muted-foreground">
            输入 {{ fmtTokens(data.tokens.promptTotal) }} · 输出
            {{ fmtTokens(data.tokens.completionTotal) }}
          </p>
        </div>
      </div>

      <!-- 趋势图 -->
      <div class="mt-6 grid gap-4 lg:grid-cols-2">
        <div class="rounded-lg border bg-card p-5">
          <h3 class="text-sm font-semibold">近 7 日提问数</h3>
          <div ref="questionsChart" class="mt-2 h-64" />
        </div>
        <div class="rounded-lg border bg-card p-5">
          <h3 class="text-sm font-semibold">近 7 日 Token 消耗</h3>
          <div ref="tokensChart" class="mt-2 h-64" />
        </div>
      </div>

      <!-- Top 知识库 -->
      <div class="mt-6 rounded-lg border bg-card p-5">
        <h3 class="text-sm font-semibold">最近活跃的知识库</h3>
        <div v-if="data.topKbs.length" class="mt-3 divide-y">
          <div
            v-for="kb in data.topKbs"
            :key="kb.id"
            class="flex items-center justify-between py-2.5 text-sm"
          >
            <span class="min-w-0 flex-1 truncate font-medium">{{ kb.name }}</span>
            <span class="shrink-0 text-xs text-muted-foreground">{{ kb.documents }} 个文档</span>
          </div>
        </div>
        <p v-else class="mt-3 text-sm text-muted-foreground">还没有知识库</p>
      </div>
    </template>
  </div>
</template>
