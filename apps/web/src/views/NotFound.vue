<script setup lang="ts">
import { useRouter } from 'vue-router';
import { Compass } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';

const router = useRouter();
</script>

<template>
  <div
    class="relative flex min-h-screen flex-col items-center justify-center gap-4 overflow-hidden bg-background p-4 text-center"
  >
    <div
      class="pointer-events-none absolute -top-24 left-1/2 h-72 w-[36rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
    />
    <div class="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
      <Compass class="h-8 w-8" />
    </div>
    <div>
      <h1 class="text-4xl font-bold tracking-tight">404</h1>
      <p class="mt-2 text-sm text-muted-foreground">页面不存在或已被移除</p>
    </div>
    <Button @click="router.push('/')">返回首页</Button>
  </div>
</template>
