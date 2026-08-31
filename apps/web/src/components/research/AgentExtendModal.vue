<script setup lang="ts">
defineOptions({ name: 'AgentExtendModal' });

import { ref, watch } from 'vue';
import { Loader2, PlayCircle } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';

const props = defineProps<{
  open: boolean;
  extending: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'confirm', tokens: number, minutes: number): void;
}>();

const extTokens = ref(50_000);
const extMinutes = ref(30);

watch(
  () => props.open,
  (v) => {
    if (v) {
      extTokens.value = 50_000;
      extMinutes.value = 30;
    }
  },
);

function fmtTokens(n: number): string {
  return n >= 10_000 ? `${(n / 10_000).toFixed(n % 10_000 === 0 ? 0 : 1)}万` : String(n);
}

function confirm() {
  emit('confirm', extTokens.value, extMinutes.value);
}
</script>

<template>
  <div v-if="props.open" class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <div class="fixed inset-0 bg-black/40" @click="emit('close')" />
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
        <Button variant="outline" class="flex-1" @click="emit('close')">取消</Button>
        <Button class="flex-1" :disabled="props.extending" @click="confirm">
          <Loader2 v-if="props.extending" class="h-4 w-4 animate-spin" />
          <PlayCircle v-else class="h-4 w-4" />
          确认继续
        </Button>
      </div>
    </div>
  </div>
</template>
