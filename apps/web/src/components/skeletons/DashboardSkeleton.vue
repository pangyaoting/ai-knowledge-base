<script setup lang="ts">
import Skeleton from '@/components/ui/Skeleton.vue';

/** 数据看板加载骨架：顶部统计卡 + 图表大块 */
</script>

<template>
  <div class="space-y-6">
    <!-- 统计卡片行 -->
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div v-for="i in 4" :key="i" class="rounded-lg border bg-card p-5">
        <Skeleton class="h-3 w-16" />
        <Skeleton class="mt-3 h-8 w-24" />
        <Skeleton class="mt-2 h-3 w-20" />
      </div>
    </div>
    <!-- 图表区 -->
    <div class="grid gap-6 lg:grid-cols-2">
      <div class="rounded-lg border bg-card p-5">
        <Skeleton class="h-3.5 w-28" />
        <Skeleton class="mt-4 h-56 w-full" />
      </div>
      <div class="rounded-lg border bg-card p-5">
        <Skeleton class="h-3.5 w-28" />
        <Skeleton class="mt-4 h-56 w-full" />
      </div>
    </div>
  </div>
</template>
