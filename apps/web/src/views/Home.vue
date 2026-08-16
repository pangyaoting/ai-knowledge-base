<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Database, Brain, MessageSquare, Cloud } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const apiStatus = ref<'checking' | 'ok' | 'error'>('checking');

onMounted(async () => {
  try {
    const res = await fetch('/api/health');
    apiStatus.value = res.ok ? 'ok' : 'error';
  } catch {
    apiStatus.value = 'error';
  }
});
</script>

<template>
  <div class="container py-12">
    <!-- 欢迎区 -->
    <div class="mb-12">
      <h1 class="text-3xl font-bold tracking-tight">
        你好，{{ auth.user?.nickname || auth.user?.email }} 👋
      </h1>
      <p class="mt-2 text-muted-foreground">
        欢迎使用 AI 知识库问答平台
        <span
          class="ml-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs"
          :class="{
            'bg-green-50 text-green-700': apiStatus === 'ok',
            'bg-red-50 text-red-700': apiStatus === 'error',
            'bg-yellow-50 text-yellow-700': apiStatus === 'checking',
          }"
        >
          <span
            class="h-1.5 w-1.5 rounded-full"
            :class="{
              'bg-green-500': apiStatus === 'ok',
              'bg-red-500': apiStatus === 'error',
              'bg-yellow-500 animate-pulse': apiStatus === 'checking',
            }"
          />
          {{ apiStatus === 'ok' ? '服务正常' : apiStatus === 'error' ? '服务异常' : '检测中...' }}
        </span>
      </p>
    </div>

    <!-- 功能卡片 -->
    <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
      <div class="rounded-lg border bg-card p-6">
        <Database class="h-8 w-8 text-primary" />
        <h3 class="mt-4 font-semibold">向量存储</h3>
        <p class="mt-2 text-sm text-muted-foreground">
          PostgreSQL + pgvector，业务数据与向量一体化存储
        </p>
      </div>
      <div class="rounded-lg border bg-card p-6">
        <Brain class="h-8 w-8 text-primary" />
        <h3 class="mt-4 font-semibold">RAG 引擎</h3>
        <p class="mt-2 text-sm text-muted-foreground">递归分块 + bge-m3 向量化 + 混合检索</p>
      </div>
      <div class="rounded-lg border bg-card p-6">
        <MessageSquare class="h-8 w-8 text-primary" />
        <h3 class="mt-4 font-semibold">流式对话</h3>
        <p class="mt-2 text-sm text-muted-foreground">SSE 逐字输出，Markdown 渲染，引用溯源</p>
      </div>
      <div class="rounded-lg border bg-card p-6">
        <Cloud class="h-8 w-8 text-primary" />
        <h3 class="mt-4 font-semibold">容器部署</h3>
        <p class="mt-2 text-sm text-muted-foreground">Docker + Nginx + GitHub Actions 自动化</p>
      </div>
    </div>

    <!-- 开发进度提示 -->
    <div class="mt-12 rounded-lg border border-dashed p-8 text-center">
      <p class="text-sm text-muted-foreground">
        阶段 1（用户系统）已完成 · 下一阶段：知识库管理与文档解析
      </p>
    </div>
  </div>
</template>
