<script setup lang="ts">
defineOptions({ name: 'ChatKbPickerModal' });

import Button from '@/components/ui/Button.vue';
import type { KnowledgeBase } from '@/types/knowledge';

const props = defineProps<{
  kbs: KnowledgeBase[];
  mode: 'create' | 'edit';
  scope: 'none' | 'all' | 'specific';
  pickingKbIds: string[];
  canSubmit: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'set-scope', scope: 'none' | 'all' | 'specific'): void;
  (e: 'toggle-kb', id: string): void;
  (e: 'confirm'): void;
}>();

/** 知识库勾选态：全部模式全显示已勾选；纯对话模式全不勾；指定模式按勾选 */
function kbChecked(id: string): boolean {
  if (props.scope === 'all') return true;
  if (props.scope === 'specific') return props.pickingKbIds.includes(id);
  return false;
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-md rounded-lg border bg-card p-5 shadow-xl">
      <h3 class="text-base font-semibold">
        {{ props.mode === 'create' ? '新建对话' : '修改问答范围' }}
      </h3>
      <p class="mt-1 text-xs text-muted-foreground">
        {{
          props.mode === 'create'
            ? '选择本次问答的知识来源（可随时修改）'
            : '修改后立即生效，之后的问题按新范围检索'
        }}
      </p>
      <div class="mt-4 max-h-72 space-y-1.5 overflow-y-auto">
        <!-- 模式：不使用知识库（纯对话） -->
        <label
          class="flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm transition-colors hover:bg-accent"
          :class="props.scope === 'none' ? 'border-primary' : ''"
        >
          <input
            type="radio"
            class="h-3.5 w-3.5"
            :checked="props.scope === 'none'"
            @change="emit('set-scope', 'none')"
          />
          <span class="font-medium">不使用知识库</span>
          <span class="ml-auto text-xs text-muted-foreground">纯对话，不检索资料</span>
        </label>
        <!-- 模式：全部知识库 -->
        <label
          class="flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm transition-colors hover:bg-accent"
          :class="props.scope === 'all' ? 'border-primary' : ''"
        >
          <input
            type="radio"
            class="h-3.5 w-3.5"
            :checked="props.scope === 'all'"
            @change="emit('set-scope', 'all')"
          />
          <span class="font-medium">全部知识库</span>
          <span class="ml-auto text-xs text-muted-foreground">搜索你所有知识库</span>
        </label>

        <p v-if="props.kbs.length" class="px-1 pt-2 text-xs text-muted-foreground">
          或勾选指定知识库（点击即切换到指定模式）：
        </p>
        <label
          v-for="kb in props.kbs"
          :key="kb.id"
          class="flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm transition-colors hover:bg-accent"
          :class="kbChecked(kb.id) ? 'border-primary' : ''"
        >
          <input
            type="checkbox"
            class="h-3.5 w-3.5"
            :checked="kbChecked(kb.id)"
            @change="emit('toggle-kb', kb.id)"
          />
          <span class="min-w-0 flex-1 truncate font-medium">{{ kb.name }}</span>
          <span class="ml-2 shrink-0 text-xs text-muted-foreground">
            {{ kb._count?.documents ?? 0 }} 个文档
          </span>
        </label>
        <p v-if="props.kbs.length === 0" class="py-4 text-center text-xs text-muted-foreground">
          还没有知识库，可先选「不使用知识库」开始纯对话，或去「知识库」页上传文档
        </p>
        <p
          v-if="props.scope === 'specific' && props.pickingKbIds.length === 0"
          class="py-2 text-center text-xs text-destructive"
        >
          请至少勾选一个知识库，或改用「全部知识库 / 不使用知识库」
        </p>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="emit('close')">取消</Button>
        <Button size="sm" :disabled="!props.canSubmit" @click="emit('confirm')">
          {{ props.mode === 'create' ? '开始对话' : '保存修改' }}
        </Button>
      </div>
    </div>
  </div>
</template>
