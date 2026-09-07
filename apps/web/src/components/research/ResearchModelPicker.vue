<script setup lang="ts">
/**
 * 研究模型选择器（研究报告页 / 自主研究 Agent 页共用）：
 * - 页面级"当前研究模型"：选中即持久（父组件存 localStorage），此后新建的任务都用它；
 * - 列表平铺"配置名 / 模型名"（同对话下拉）；固定高度内部滚动；点外部关闭；
 * - 未选择时显示"未选模型"，由父组件在创建时引导先选（无默认配置概念，不自动猜）。
 */
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { Cpu } from 'lucide-vue-next';
import type { ModelConfig } from '@/types/model-config';

export interface SelectedModel {
  configId: string;
  model: string;
}

const props = defineProps<{
  modelConfigs: ModelConfig[];
  /** 触发按钮文案前缀（如"报告模型"） */
  label?: string;
}>();

const model = defineModel<SelectedModel | null>({ default: null });

const open = ref(false);
const btnRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const pos = ref({ top: 0, left: 0 });

/** 当前显示名：配置名 / 模型名 */
const displayName = computed(() => {
  if (!model.value) return '未选模型';
  const c = props.modelConfigs.find((x) => x.id === model.value?.configId);
  const m = model.value?.model;
  if (!c) return '未选模型';
  return m && m !== c.model ? `${c.name} / ${m}` : c.name;
});

/** 模型对应的配置是否仍存在（配置被删 → 视同未选，提示重新选择） */
const stale = computed(() => {
  if (!model.value) return false;
  return !props.modelConfigs.some((c) => c.id === model.value?.configId);
});

function toggle() {
  open.value = !open.value;
  if (open.value) {
    // 先按内容估算摆位（防闪烁），面板渲染后再按真实高度精修
    positionEstimate();
    nextTick(() => position());
  }
}

/** 打开前按内容粗估高度定摆位（内容自适应，封顶 70vh；防 0,0 闪现） */
function positionEstimate() {
  const btn = btnRef.value;
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const vh = window.innerHeight;
  const rows = props.modelConfigs.reduce(
    (n, c) => n + ((c.models ?? []).length ? c.models!.length : 1),
    0,
  );
  const est = Math.min(vh * 0.7, rows * 34 + 80);
  const top = r.bottom + 6 + est > vh ? Math.max(8, r.top - est - 6) : r.bottom + 6;
  pos.value = { top, left: Math.min(Math.max(8, r.left), window.innerWidth - 264) };
}

/** 按面板真实高度精修摆位（内容超出 70vh 时面板内部滚动，视口内不溢出） */
function position() {
  const btn = btnRef.value;
  const panel = panelRef.value;
  if (!btn || !panel) return;
  const r = btn.getBoundingClientRect();
  const vh = window.innerHeight;
  const h = Math.min(panel.scrollHeight, vh * 0.7);
  const top = r.bottom + 6 + h > vh ? Math.max(8, r.top - h - 6) : r.bottom + 6;
  const left = Math.min(Math.max(8, r.left), window.innerWidth - 264);
  pos.value = { top, left };
}

function pick(configId: string, m: string) {
  model.value = { configId, model: m };
  open.value = false;
}

function onDocPointerDown(e: MouseEvent) {
  if (!open.value) return;
  const t = e.target as Node;
  if (!btnRef.value?.contains(t) && !panelRef.value?.contains(t)) open.value = false;
}

onMounted(() => document.addEventListener('mousedown', onDocPointerDown));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocPointerDown));
</script>

<template>
  <div class="relative inline-flex items-center gap-2">
    <span v-if="label" class="shrink-0 text-[11px] text-muted-foreground">{{ label }}</span>
    <button
      ref="btnRef"
      type="button"
      class="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-muted"
      :class="
        model && !stale
          ? 'border bg-muted/40 text-foreground'
          : 'border-destructive/40 bg-destructive/5 text-destructive'
      "
      :title="
        model && !stale
          ? '点击更换研究使用的模型（之后新建的研究任务都用它）'
          : '请先选择研究使用的模型（之后新建的研究任务都用它）'
      "
      @click="toggle"
    >
      <Cpu class="h-3 w-3 shrink-0" />
      <span class="truncate">{{ displayName }}</span>
    </button>
    <div
      v-if="open"
      ref="panelRef"
      class="fixed z-50 max-h-[70vh] w-64 overflow-y-auto rounded-lg border bg-card py-1 shadow-lg"
      :style="{ top: pos.top + 'px', left: pos.left + 'px' }"
      @click.stop
    >
      <p v-if="props.modelConfigs.length === 0" class="px-3 py-2 text-xs text-muted-foreground">
        还没有绑定任何模型 Key，请先到「模型配置」绑定。
      </p>
      <template v-else>
        <p class="px-3 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">
          选择研究使用的模型
        </p>
        <template v-for="c in props.modelConfigs" :key="c.id">
          <button
            v-for="m in c.models?.length ? c.models : [c.model]"
            :key="m"
            type="button"
            class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
            :class="model?.configId === c.id && model?.model === m ? 'text-primary' : ''"
            @click="pick(c.id, m)"
          >
            <span class="min-w-0 flex-1 truncate">{{ c.name }} / {{ m }}</span>
            <span v-if="model?.configId === c.id && model?.model === m" class="shrink-0 text-xs"
              >✓</span
            >
          </button>
        </template>
      </template>
    </div>
  </div>
</template>
