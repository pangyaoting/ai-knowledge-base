<script setup lang="ts">
defineOptions({ name: 'AgentCreateForm' });

import { computed } from 'vue';
import { Bot, Loader2, Sparkles } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import type { AgentMode } from '@/types/research-agent';
import type { ModelConfig } from '@/types/model-config';

const props = defineProps<{
  mode: AgentMode;
  goal: string;
  startAt: string;
  endAt: string;
  presetKey: string;
  customTokens: number;
  selectedTokens: number;
  selectedMinutes: number;
  creating: boolean;
  error: string;
  modelConfigs: ModelConfig[];
}>();

const emit = defineEmits<{
  (e: 'update:mode', v: AgentMode): void;
  (e: 'update:goal', v: string): void;
  (e: 'update:startAt', v: string): void;
  (e: 'update:endAt', v: string): void;
  (e: 'update:presetKey', v: string): void;
  (e: 'update:customTokens', v: number): void;
  (e: 'pick-preset', key: string): void;
  (e: 'custom-tokens'): void;
  (e: 'create'): void;
}>();

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

function estimateMinutes(tokens: number): number {
  return Math.min(360, Math.round((tokens / 100_000) * 40));
}

function fmtTokens(n: number): string {
  return n >= 10_000 ? `${(n / 10_000).toFixed(n % 10_000 === 0 ? 0 : 1)}万` : String(n);
}

const hasModel = computed(() => props.modelConfigs.length > 0);
</script>

<template>
  <div class="flex flex-1 flex-col items-center overflow-y-auto p-6">
    <div class="w-full max-w-4xl pb-8">
      <!-- 未绑定模型：前置引导 -->
      <div
        v-if="!hasModel"
        class="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm"
      >
        <span class="text-muted-foreground">
          自主研究由你自己的大模型 Key 驱动，请先绑定模型配置
        </span>
        <RouterLink to="/model-configs" class="shrink-0 font-medium text-primary hover:underline">
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
            :class="props.mode === 'targeted' ? 'border-primary bg-primary/5' : ''"
            @click="emit('update:mode', 'targeted')"
          >
            <p class="font-medium">定向研究</p>
            <p class="mt-0.5 text-xs text-muted-foreground">填写目标，Agent 拆解成多个方向研究</p>
          </button>
          <button
            type="button"
            class="rounded-md border p-2.5 text-left text-sm transition-colors hover:bg-accent"
            :class="props.mode === 'open' ? 'border-primary bg-primary/5' : ''"
            @click="emit('update:mode', 'open')"
          >
            <p class="font-medium">自主探索</p>
            <p class="mt-0.5 text-xs text-muted-foreground">不填目标，从你的知识库中挖掘方向</p>
          </button>
        </div>

        <!-- 目标 -->
        <div v-if="props.mode === 'targeted'" class="mt-4 space-y-1.5">
          <label class="text-sm font-medium" for="agent-goal">研究目标</label>
          <textarea
            id="agent-goal"
            :value="props.goal"
            rows="3"
            placeholder="例如：2026 年 RAG 技术的主要发展趋势与工程落地"
            class="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
            :disabled="props.creating"
            @input="emit('update:goal', ($event.target as HTMLTextAreaElement).value)"
          />
        </div>

        <!-- 时间窗 -->
        <div class="mt-4 grid grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <label class="text-sm font-medium" for="agent-start">开始时间</label>
            <Input
              id="agent-start"
              :model-value="props.startAt"
              type="datetime-local"
              :disabled="props.creating"
              @update:model-value="emit('update:startAt', $event)"
            />
          </div>
          <div class="space-y-1.5">
            <label class="text-sm font-medium" for="agent-end">结束时间（停止硬上限）</label>
            <Input
              id="agent-end"
              :model-value="props.endAt"
              type="datetime-local"
              :disabled="props.creating"
              @update:model-value="emit('update:endAt', $event)"
            />
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
              :class="props.presetKey === p.key ? 'border-primary bg-primary/5' : ''"
              @click="emit('pick-preset', p.key)"
            >
              <p class="font-medium">{{ p.label }}</p>
              <p class="mt-0.5 text-[11px] text-muted-foreground">
                {{ p.key === 'custom' ? p.desc : `${fmtTokens(p.tokens)} · ${p.desc}` }}
              </p>
            </button>
          </div>
          <div v-if="props.presetKey === 'custom'" class="mt-2 flex items-center gap-3">
            <Input
              :model-value="props.customTokens"
              type="number"
              min="10000"
              max="500000"
              step="10000"
              class="w-40"
              :disabled="props.creating"
              @update:model-value="emit('update:customTokens', Number($event))"
              @input="emit('custom-tokens')"
            />
            <span class="text-xs text-muted-foreground">
              1万 ~ 50万，预计约 {{ estimateMinutes(props.customTokens) }} 分钟
            </span>
          </div>
          <p class="mt-2 text-[11px] text-muted-foreground">
            预计 {{ props.selectedMinutes }} 分钟 · 可随时停止/续时；预算
            {{ fmtTokens(props.selectedTokens) }} ≈ ¥{{
              (props.selectedTokens / 1000000).toFixed(2)
            }}（DeepSeek 约 ¥1/百万 token）
          </p>
        </div>

        <p v-if="props.error" class="mt-3 text-sm text-destructive">{{ props.error }}</p>
        <Button class="mt-4 w-full" :disabled="props.creating || !hasModel" @click="emit('create')">
          <Loader2 v-if="props.creating" class="h-4 w-4 animate-spin" />
          <Sparkles v-else class="h-4 w-4" />
          {{ props.creating ? '创建中...' : hasModel ? '开始自主研究' : '请先绑定模型配置' }}
        </Button>
        <p class="mt-2 text-center text-[11px] text-muted-foreground">
          停止条件：token 预算用尽永远停止；否则到达你设定的结束时间即停止；手动停止随时生效。
          无论怎么停，都会先把手头笔记整理成正式报告（整理费另计 12k token，不占研究预算）
        </p>
      </div>
    </div>
  </div>
</template>
