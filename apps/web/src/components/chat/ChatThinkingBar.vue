<script setup lang="ts">
defineOptions({ name: 'ChatThinkingBar' });

defineProps<{ thinkingSeconds: number }>();

function formatThinkingTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
</script>

<template>
  <div class="flex items-center gap-2">
    <span class="thinking-shimmer-wrap">
      <span class="thinking-shimmer-base">检索思考中...</span>
      <span class="thinking-shimmer-overlay" aria-hidden="true">检索思考中...</span>
    </span>
    <span class="text-xs tabular-nums text-muted-foreground">
      {{ formatThinkingTime(thinkingSeconds) }}
    </span>
  </div>
</template>

<style scoped>
/* 检索思考中：蓝色文字 + 白色光条从左到右循环扫过（文字被扫过处变白） */
.thinking-shimmer-wrap {
  position: relative;
  display: inline-block;
  font-size: 0.875rem; /* text-sm */
  font-weight: 500;
  line-height: 1.4;
}
.thinking-shimmer-base {
  color: #3b82f6; /* 蓝色 */
}
.thinking-shimmer-overlay {
  position: absolute;
  inset: 0;
  /* 白峰收窄在中间（细光条），两侧渐隐，避免一大片白光 */
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0%,
    rgba(255, 255, 255, 0) 44%,
    #fff 50%,
    rgba(255, 255, 255, 0) 56%,
    rgba(255, 255, 255, 0) 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: shimmer-sweep 1.5s linear infinite;
}
@keyframes shimmer-sweep {
  /* 行程只比容器宽一点点：光条刚出右端（-10%），下一圈就从左端（110%）接上，几乎无空白 */
  0% {
    background-position: 110% 0;
  }
  100% {
    background-position: -10% 0;
  }
}
</style>
