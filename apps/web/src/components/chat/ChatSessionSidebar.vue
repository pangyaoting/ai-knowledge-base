<script setup lang="ts">
defineOptions({ name: 'ChatSessionSidebar' });

import { MessageSquare, Plus, Trash2, Search } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import ListSkeleton from '@/components/skeletons/ListSkeleton.vue';
import type { ChatSession } from '@/types/chat';

const props = defineProps<{
  sessions: ChatSession[];
  currentSessionId: string | null;
  loadingSessions: boolean;
  sessionSearch: string;
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:sessionSearch', v: string): void;
  (e: 'select', id: string): void;
  (e: 'create'): void;
  (e: 'delete', id: string): void;
  (e: 'close-mobile'): void;
  (e: 'toggle-collapse'): void;
}>();

/** 会话绑定知识库的展示名（最多显示 2 个，多了折叠成"等N个"） */
function kbNames(bound: ChatSession['knowledgeBases']): string {
  const names = bound.map((k) => k.knowledgeBase.name);
  if (names.length <= 2) return names.join('、');
  return `${names.slice(0, 2).join('、')} 等${names.length}个`;
}
</script>

<template>
  <aside
    class="absolute inset-y-0 left-0 z-40 flex w-64 -translate-x-full flex-col border-r bg-card/50 shadow-xl transition-all duration-200 md:static md:z-auto md:translate-x-0 md:shadow-none"
    :class="[
      props.sidebarOpen ? 'translate-x-0' : '-translate-x-full',
      props.sidebarCollapsed ? 'md:w-0 md:overflow-hidden md:border-r-0' : 'md:w-64',
    ]"
  >
    <div class="p-3">
      <Button class="w-full" @click="emit('create')">
        <Plus class="h-4 w-4" />
        新建对话
      </Button>
    </div>
    <!-- 会话搜索（标题/消息内容全文检索） -->
    <div class="px-3 pb-2">
      <div class="relative">
        <Search
          class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          :model-value="props.sessionSearch"
          type="text"
          placeholder="搜索会话（标题/内容）"
          class="h-8 pl-8 text-xs"
          @update:model-value="emit('update:sessionSearch', $event)"
        />
      </div>
    </div>
    <div class="flex-1 overflow-y-auto px-2 pb-2">
      <div v-if="props.loadingSessions" class="py-2">
        <ListSkeleton :rows="8" />
      </div>
      <p
        v-else-if="props.sessionSearch.trim() && props.sessions.length === 0"
        class="py-8 text-center text-xs text-muted-foreground"
      >
        没有匹配的会话，换个关键词试试
      </p>
      <div
        v-for="s in props.sessions"
        :key="s.id"
        role="button"
        tabindex="0"
        class="mb-1 flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm transition-colors"
        :class="
          s.id === props.currentSessionId
            ? 'bg-primary/10 text-primary'
            : 'hover:bg-accent text-foreground'
        "
        @click="emit('select', s.id)"
        @keydown.enter="emit('select', s.id)"
      >
        <MessageSquare class="h-4 w-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate">{{ s.title }}</span>
        <span
          v-if="s.useKnowledgeBase === false"
          class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
          title="纯对话模式，不检索知识库"
        >
          纯聊天
        </span>
        <span
          v-else-if="s.knowledgeBases.length"
          class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
          :title="'问答范围：' + s.knowledgeBases.map((k) => k.knowledgeBase.name).join('、')"
        >
          {{ kbNames(s.knowledgeBases) }}
        </span>
        <span class="shrink-0 text-xs text-muted-foreground">{{ s._count?.messages ?? 0 }}</span>
        <button
          class="shrink-0 rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:opacity-100 hover:text-destructive"
          title="删除会话"
          @click.stop="emit('delete', s.id)"
        >
          <Trash2 class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  </aside>
</template>
