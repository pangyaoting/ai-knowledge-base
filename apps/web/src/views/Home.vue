<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Database, Brain, MessageSquare, Cloud } from 'lucide-vue-next';

const apiStatus = ref<'checking' | 'ok' | 'error'>('checking');

onMounted(async () => {
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      apiStatus.value = 'ok';
    } else {
      apiStatus.value = 'error';
    }
  } catch {
    apiStatus.value = 'error';
  }
});
</script>

<template>
  <div class="min-h-screen bg-gradient-to-b from-slate-50 to-white">
    <!-- 顶部导航 -->
    <header class="border-b">
      <div class="container flex h-16 items-center justify-between">
        <div class="flex items-center gap-2">
          <Brain class="h-6 w-6" />
          <span class="text-lg font-semibold">AI 知识库</span>
        </div>
        <div class="flex items-center gap-2 text-sm">
          <span
            class="inline-flex items-center gap-1.5 rounded-full px-3 py-1"
            :class="{
              'bg-green-50 text-green-700': apiStatus === 'ok',
              'bg-red-50 text-red-700': apiStatus === 'error',
              'bg-yellow-50 text-yellow-700': apiStatus === 'checking',
            }"
          >
            <span
              class="h-2 w-2 rounded-full"
              :class="{
                'bg-green-500': apiStatus === 'ok',
                'bg-red-500': apiStatus === 'error',
                'bg-yellow-500 animate-pulse': apiStatus === 'checking',
              }"
            />
            {{ apiStatus === 'ok' ? '后端已连接' : apiStatus === 'error' ? '后端未连接' : '检测中...' }}
          </span>
        </div>
      </div>
    </header>

    <!-- 主体 -->
    <main class="container py-20">
      <div class="mx-auto max-w-3xl text-center">
        <h1 class="text-4xl font-bold tracking-tight sm:text-5xl">
          AI 知识库问答平台
        </h1>
        <p class="mt-6 text-lg text-muted-foreground">
          基于 Vue3 + NestJS + RAG 技术栈，上传文档即可构建智能知识库，
          支持语义检索、流式问答、引用溯源。
        </p>
        <div class="mt-10 flex justify-center gap-4">
          <button
            class="rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            开始使用
          </button>
          <button
            class="rounded-lg border border-border bg-background px-6 py-3 text-sm font-medium transition hover:bg-accent"
          >
            查看文档
          </button>
        </div>
      </div>

      <!-- 技术栈卡片 -->
      <div class="mx-auto mt-20 grid max-w-4xl gap-6 sm:grid-cols-2 lg:grid-cols-4">
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
          <p class="mt-2 text-sm text-muted-foreground">
            递归分块 + bge-m3 向量化 + 混合检索
          </p>
        </div>
        <div class="rounded-lg border bg-card p-6">
          <MessageSquare class="h-8 w-8 text-primary" />
          <h3 class="mt-4 font-semibold">流式对话</h3>
          <p class="mt-2 text-sm text-muted-foreground">
            SSE 逐字输出，Markdown 渲染，引用溯源
          </p>
        </div>
        <div class="rounded-lg border bg-card p-6">
          <Cloud class="h-8 w-8 text-primary" />
          <h3 class="mt-4 font-semibold">容器部署</h3>
          <p class="mt-2 text-sm text-muted-foreground">
            Docker + Nginx + GitHub Actions 自动化
          </p>
        </div>
      </div>
    </main>
  </div>
</template>
