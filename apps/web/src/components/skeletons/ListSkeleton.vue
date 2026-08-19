<script setup lang="ts">
import Skeleton from '@/components/ui/Skeleton.vue';

/**
 * 通用列表骨架：rows 行，每行 = 左侧图标块 + 两行文字
 * 用于会话列表 / 知识库列表 / 文档列表 / 报告列表等加载态
 */
withDefaults(
  defineProps<{
    rows?: number;
    showAvatar?: boolean; // 左侧方形图标块
  }>(),
  { rows: 5, showAvatar: true },
);
</script>

<template>
  <div class="space-y-2 p-2">
    <div v-for="i in rows" :key="i" class="flex items-center gap-3 rounded-md px-3 py-2.5">
      <Skeleton v-if="showAvatar" class="h-8 w-8 shrink-0" />
      <div class="min-w-0 flex-1 space-y-2">
        <Skeleton class="h-3.5 w-2/3" />
        <Skeleton class="h-3 w-1/3" />
      </div>
    </div>
  </div>
</template>
