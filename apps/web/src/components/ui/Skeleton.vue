<script setup lang="ts">
/**
 * 骨架屏基础块：灰色占位 + 呼吸闪烁
 * 用法：<Skeleton class="h-4 w-24" />
 */
withDefaults(
  defineProps<{
    class?: string;
  }>(),
  { class: '' },
);
</script>

<template>
  <div class="animate-pulse rounded-md bg-muted/70" :class="class" />
</template>
