<script setup lang="ts">
defineOptions({ name: 'AgentTaskSidebar' });

import { Plus, Trash2, Bot } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import ListSkeleton from '@/components/skeletons/ListSkeleton.vue';
import type { AgentTask } from '@/types/research-agent';

const props = defineProps<{
  tasks: AgentTask[];
  currentId: string | null;
  loading: boolean;
}>();

const emit = defineEmits<{
  (e: 'new'): void;
  (e: 'select', id: string): void;
  (e: 'delete', id: string): void;
}>();

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
</script>

<template>
  <aside class="flex w-64 flex-col border-r bg-card/50">
    <div class="p-3">
      <Button class="w-full" @click="emit('new')">
        <Plus class="h-4 w-4" />
        新建研究任务
      </Button>
    </div>
    <div class="flex-1 overflow-y-auto px-2 pb-2">
      <div v-if="props.loading" class="py-2">
        <ListSkeleton :rows="6" />
      </div>
      <div
        v-for="t in props.tasks"
        :key="t.id"
        role="button"
        tabindex="0"
        class="mb-1 flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm transition-colors"
        :class="
          t.id === props.currentId
            ? 'bg-primary/10 text-primary'
            : 'hover:bg-accent text-foreground'
        "
        @click="emit('select', t.id)"
        @keydown.enter="emit('select', t.id)"
      >
        <Bot class="h-4 w-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate">{{ t.goal || '自主探索' }}</span>
        <span class="shrink-0 rounded px-1.5 py-0.5 text-[10px]" :class="statusClass(t.status)">
          {{ statusText[t.status] }}
        </span>
        <button
          class="shrink-0 rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:opacity-100 hover:text-destructive"
          title="删除任务"
          @click.stop="emit('delete', t.id)"
        >
          <Trash2 class="h-3.5 w-3.5" />
        </button>
      </div>
      <p
        v-if="!props.loading && props.tasks.length === 0"
        class="py-8 text-center text-xs text-muted-foreground"
      >
        还没有研究任务
      </p>
    </div>
  </aside>
</template>
