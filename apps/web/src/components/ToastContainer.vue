<script setup lang="ts">
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-vue-next';
import { useToastState, toast, type ToastItem } from '@/composables/useToast';

const state = useToastState();

const iconMap = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
} as const;

const colorMap = {
  success: 'text-green-600 dark:text-green-400',
  error: 'text-destructive',
  info: 'text-primary',
} as const;

function titleOf(t: ToastItem): string {
  if (t.type === 'success') return '成功';
  if (t.type === 'error') return '出错了';
  return '提示';
}
</script>

<template>
  <!-- 全局 Toast：右上角堆叠，自动消失，可手动关闭 -->
  <div
    class="pointer-events-none fixed right-4 top-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
  >
    <TransitionGroup
      tag="div"
      class="flex flex-col gap-2"
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-x-4 opacity-0"
      enter-to-class="translate-x-0 opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="translate-x-0 opacity-100"
      leave-to-class="translate-x-4 opacity-0"
      move-class="transition duration-200"
    >
      <div
        v-for="t in state.toasts"
        :key="t.id"
        class="pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-card p-3 shadow-lg"
        role="status"
      >
        <component
          :is="iconMap[t.type]"
          class="mt-0.5 h-4 w-4 shrink-0"
          :class="colorMap[t.type]"
        />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">{{ titleOf(t) }}</p>
          <p class="mt-0.5 break-words text-xs text-muted-foreground">{{ t.message }}</p>
        </div>
        <button
          class="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="关闭提示"
          @click="toast.dismiss(t.id)"
        >
          <X class="h-3.5 w-3.5" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>
