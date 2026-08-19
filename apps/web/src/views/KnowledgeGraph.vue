<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft, Loader2, RefreshCw, Network, Sparkles, BookOpen } from 'lucide-vue-next';
import * as echarts from 'echarts/core';
import { GraphChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ECharts } from 'echarts/core';
import type { GraphNode, GraphEdge, EntityChunk } from '@/types/knowledge';
import { getKnowledgeGraph, getEntityChunks, rebuildKnowledgeGraph } from '@/api/knowledge';
import DocPreviewDrawer from '@/components/DocPreviewDrawer.vue';
import Button from '@/components/ui/Button.vue';
import Skeleton from '@/components/ui/Skeleton.vue';

echarts.use([GraphChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const route = useRoute();
const router = useRouter();
const knowledgeBaseId = route.params.id as string;

const loading = ref(false);
const rebuilding = ref(false);
const error = ref('');
const notice = ref(''); // 重建进度 / 结果说明（避免"转圈 30 秒后什么都没发生"的困惑）
const nodes = ref<GraphNode[]>([]);
const edges = ref<GraphEdge[]>([]);

const chartEl = ref<HTMLElement | null>(null);
let chart: ECharts | null = null;

// 节点详情面板
const selectedNode = ref<string | null>(null);
const nodeChunks = ref<EntityChunk[]>([]);
const nodeRelEdges = ref<GraphEdge[]>([]);
const loadingChunks = ref(false);

// 文档预览抽屉（定位原文）
const previewDocId = ref<string | null>(null);
const previewChunkIndex = ref<number | null>(null);

const TYPE_COLORS: Record<string, string> = {
  概念: '#6366f1',
  技术: '#0ea5e9',
  人物: '#f59e0b',
  组织: '#10b981',
  产品: '#ef4444',
};

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await getKnowledgeGraph(knowledgeBaseId);
    nodes.value = data.nodes;
    edges.value = data.edges;
    if (selectedNode.value && !nodes.value.some((n) => n.name === selectedNode.value)) {
      selectedNode.value = null;
      nodeChunks.value = [];
      nodeRelEdges.value = [];
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
  // 必须先等 loading 关闭、v-else 分支把图表容器渲染出来，再初始化图表（否则 chartEl 为 null）
  await nextTick();
  renderChart();
}

function renderChart() {
  if (!chartEl.value) return;
  chart ??= echarts.init(chartEl.value);
  const categories = [...new Set(nodes.value.map((n) => n.type))].map((type) => ({
    name: type,
  }));
  chart.setOption({
    tooltip: {
      trigger: 'item',
      // echarts 事件载荷类型宽松，用 any 兼容（params.data 是节点对象）
      formatter: (p: any) =>
        p.dataType === 'node'
          ? `<b>${p.data?.name ?? p.name}</b><br/>类型：${p.data?.type ?? '-'} · 出现在 ${p.data?.count ?? 0} 篇文档`
          : (p.name ?? ''),
    },
    legend: { data: categories, bottom: 8, textStyle: { fontSize: 11 } },
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        draggable: true,
        data: nodes.value.map((n) => ({
          id: n.name,
          name: n.name,
          symbolSize: Math.min(12 + n.count * 8, 40),
          category: n.type,
          itemStyle: { color: TYPE_COLORS[n.type] ?? '#94a3b8' },
          label: { show: true, fontSize: 11, color: '#334155' },
        })),
        links: edges.value.map((e) => ({
          source: e.source,
          target: e.target,
          label: { show: true, formatter: e.relation, fontSize: 10, color: '#94a3b8' },
        })),
        categories,
        force: {
          repulsion: 220,
          edgeLength: [90, 160],
          gravity: 0.08,
        },
        lineStyle: { color: '#cbd5e1', width: 1.2, curveness: 0.05 },
        emphasis: { focus: 'adjacency', lineStyle: { width: 2 } },
      },
    ],
  });
  chart.off('click');
  chart.on('click', (params: any) => {
    if (params.dataType === 'node' && params.data?.id) {
      selectNode(params.data.id);
    }
  });
}

/** 点击节点：加载详情（关系 + 原文片段） */
async function selectNode(name: string) {
  selectedNode.value = name;
  nodeRelEdges.value = edges.value.filter((e) => e.source === name || e.target === name);
  loadingChunks.value = true;
  nodeChunks.value = [];
  try {
    nodeChunks.value = await getEntityChunks(knowledgeBaseId, name);
  } catch {
    nodeChunks.value = [];
  } finally {
    loadingChunks.value = false;
  }
}

async function handleRebuild() {
  if (rebuilding.value) return;
  rebuilding.value = true;
  error.value = '';
  notice.value = '';
  try {
    const res = await rebuildKnowledgeGraph(knowledgeBaseId);
    if (!res.success) {
      // 未绑定模型配置：直接告诉用户原因，不再静默空转
      error.value = res.message;
      return;
    }
    notice.value = res.message;
    // 异步抽取：最多轮询 6 次 × 3s = 18s，节点数有变化（>0 且 ≠ 之前）即完成
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const data = await getKnowledgeGraph(knowledgeBaseId);
      if (data.nodes.length > 0 && data.nodes.length !== nodes.value.length) {
        await load();
        notice.value = `知识网络已更新：${data.nodes.length} 个概念 · ${data.edges.length} 条关系`;
        return;
      }
    }
    await load();
    if (nodes.value.length === 0) {
      notice.value =
        '抽取完成但未生成概念。可能原因：模型配置不可用（先到「模型配置」页点「测试连接」验证 Key/模型名），或文档内容过短、缺少明确的概念与关系。修复后可再次重建。';
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    rebuilding.value = false;
  }
}

function onResize() {
  chart?.resize();
}

onMounted(() => {
  load();
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div class="flex h-[calc(100vh-4rem)] flex-col">
    <!-- 头部 -->
    <div class="flex items-center gap-3 border-b bg-card/50 px-4 py-2.5">
      <Button variant="ghost" size="icon" @click="router.push(`/knowledge/${knowledgeBaseId}`)">
        <ArrowLeft class="h-4 w-4" />
      </Button>
      <div class="min-w-0 flex-1">
        <h1 class="flex items-center gap-1.5 text-base font-semibold">
          <Network class="h-4 w-4 text-primary" />
          知识网络
          <span v-if="nodes.length" class="text-xs font-normal text-muted-foreground">
            {{ nodes.length }} 个概念 · {{ edges.length }} 条关系
          </span>
        </h1>
        <p class="text-[11px] text-muted-foreground">
          文档入库时自动抽取概念与关系；点节点看关联与原文，问答时可沿网络多跳推理
        </p>
      </div>
      <Button variant="outline" size="sm" :disabled="rebuilding" @click="handleRebuild">
        <Loader2 v-if="rebuilding" class="h-4 w-4 animate-spin" />
        <RefreshCw v-else class="h-4 w-4" />
        {{ rebuilding ? '抽取中...' : '重建知识网络' }}
      </Button>
    </div>

    <!-- 重建进度/结果提示条 -->
    <div v-if="notice" class="border-b bg-primary/5 px-4 py-2 text-xs text-primary" role="status">
      {{ notice }}
    </div>

    <!-- 主体 -->
    <div class="flex min-h-0 flex-1">
      <!-- 图 -->
      <div class="relative min-w-0 flex-1">
        <div v-if="loading" class="flex h-full items-center justify-center p-8">
          <div class="w-full max-w-2xl space-y-3">
            <div class="flex items-center justify-center gap-6 py-4">
              <Skeleton class="h-12 w-12 rounded-full" />
              <Skeleton class="h-12 w-12 rounded-full" />
              <Skeleton class="h-12 w-12 rounded-full" />
            </div>
            <Skeleton class="h-64 w-full" />
            <div class="flex justify-center gap-4">
              <Skeleton class="h-3 w-24" />
              <Skeleton class="h-3 w-24" />
              <Skeleton class="h-3 w-24" />
            </div>
          </div>
        </div>
        <p
          v-else-if="error"
          class="flex h-full items-center justify-center text-sm text-destructive"
        >
          {{ error }}
        </p>
        <div
          v-else-if="nodes.length === 0"
          class="flex h-full flex-col items-center justify-center text-center"
        >
          <Sparkles class="h-10 w-10 text-muted-foreground/40" />
          <p class="mt-3 text-sm text-muted-foreground">
            还没有知识网络——点右上角「重建知识网络」从文档中抽取概念和关系
          </p>
          <!-- 空图原因引导（模型配置 / 文档内容） -->
          <div
            v-if="notice"
            class="mt-4 max-w-md rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-left text-xs text-muted-foreground"
          >
            <p class="font-medium text-foreground">为什么是空的？</p>
            <ul class="mt-1.5 list-disc space-y-1 pl-4">
              <li>
                抽取使用你自己的大模型 Key——到「模型配置」页点「测试连接」确认 Key 和模型名可用；
              </li>
              <li>文档需先处理完成（状态「已完成」），且内容里有明确的概念/关系才抽得出来；</li>
              <li>修复后再次「重建知识网络」即可。</li>
            </ul>
          </div>
        </div>
        <div v-else ref="chartEl" class="h-full w-full" />
      </div>

      <!-- 节点详情 -->
      <aside v-if="selectedNode" class="flex w-80 shrink-0 flex-col border-l bg-card/50">
        <div class="flex items-center gap-2 border-b px-3 py-2">
          <h2 class="min-w-0 flex-1 truncate text-sm font-semibold">{{ selectedNode }}</h2>
          <button
            class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent"
            title="关闭"
            @click="selectedNode = null"
          >
            ✕
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-3">
          <!-- 相关关系 -->
          <p class="text-xs font-medium text-muted-foreground">
            关联关系（{{ nodeRelEdges.length }}）
          </p>
          <ul v-if="nodeRelEdges.length" class="mt-1.5 space-y-1">
            <li
              v-for="(e, i) in nodeRelEdges"
              :key="i"
              class="rounded-md bg-muted/40 px-2 py-1.5 text-xs"
            >
              <button
                class="text-primary hover:underline"
                @click="selectNode(e.source === selectedNode ? e.target : e.source)"
              >
                {{ e.source === selectedNode ? e.target : e.source }}
              </button>
              <span class="mx-1 text-muted-foreground">←{{ e.relation }}→</span>
              <span>{{ e.source === selectedNode ? e.source : e.target }}</span>
            </li>
          </ul>
          <p v-else class="mt-1 text-xs text-muted-foreground">暂无关系</p>

          <!-- 原文片段 -->
          <p class="mt-4 text-xs font-medium text-muted-foreground">原文片段</p>
          <div v-if="loadingChunks" class="flex justify-center py-6">
            <Loader2 class="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
          <div v-else-if="nodeChunks.length" class="mt-1.5 space-y-2">
            <div
              v-for="c in nodeChunks"
              :key="c.chunkId"
              class="rounded-md border bg-muted/30 p-2.5 text-xs"
            >
              <p class="truncate font-medium text-foreground">{{ c.filename }}</p>
              <p class="mt-1 line-clamp-4 leading-relaxed text-muted-foreground">{{ c.content }}</p>
              <button
                class="mt-1.5 rounded bg-primary/10 px-2 py-0.5 text-[11px] text-primary hover:bg-primary/20"
                @click="
                  previewDocId = c.documentId;
                  previewChunkIndex = c.chunkIndex;
                "
              >
                定位到原文第 {{ c.chunkIndex + 1 }} 段
              </button>
            </div>
          </div>
          <p v-else class="mt-1 text-xs text-muted-foreground">暂未关联到原文片段</p>
        </div>
      </aside>
    </div>

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
