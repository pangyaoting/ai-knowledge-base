<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Database, Brain, MessageSquare, Cloud, Cpu, ArrowRight } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import { getModelConfigs } from '@/api/model-configs';
import type { ModelConfig } from '@/types/model-config';

const auth = useAuthStore();
const apiStatus = ref<'checking' | 'ok' | 'error'>('checking');
const modelConfigs = ref<ModelConfig[]>([]);
const loaded = ref(false);

onMounted(async () => {
  try {
    const res = await fetch('/api/health');
    apiStatus.value = res.ok ? 'ok' : 'error';
  } catch {
    apiStatus.value = 'error';
  }
  try {
    modelConfigs.value = await getModelConfigs();
  } catch {
    modelConfigs.value = [];
  }
  loaded.value = true;
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

    <!-- 第一步：绑定自己的模型 Key（BYO，所有 AI 功能的前提） -->
    <div
      v-if="loaded"
      class="mb-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-5"
      :class="
        modelConfigs.length === 0
          ? 'border-primary/40 bg-primary/5'
          : 'border-green-200 bg-green-50/60'
      "
    >
      <div class="flex items-start gap-3">
        <Cpu
          class="mt-0.5 h-6 w-6 shrink-0"
          :class="modelConfigs.length === 0 ? 'text-primary' : 'text-green-600'"
        />
        <div>
          <p class="font-semibold">
            {{
              modelConfigs.length === 0
                ? '第一步：绑定你自己的大模型 API Key'
                : `已绑定 ${modelConfigs.length} 个模型配置（默认：${modelConfigs.find((c) => c.isDefault)?.name ?? '未设置'}）`
            }}
          </p>
          <p class="mt-1 text-sm text-muted-foreground">
            {{
              modelConfigs.length === 0
                ? '对话、研究报告、知识图谱全部由你自己的 Key 计费，平台不提供兜底模型。绑定后即可开始使用全部 AI 功能。'
                : '所有 AI 消耗都由你的 Key 承担，随时可在「模型配置」页增删改。'
            }}
          </p>
        </div>
      </div>
      <RouterLink
        to="/model-configs"
        class="inline-flex shrink-0 items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium text-white"
        :class="
          modelConfigs.length === 0
            ? 'bg-primary hover:bg-primary/90'
            : 'bg-green-600 hover:bg-green-700'
        "
      >
        {{ modelConfigs.length === 0 ? '立即绑定' : '管理模型配置' }}
        <ArrowRight class="h-4 w-4" />
      </RouterLink>
    </div>

    <!-- 功能入口卡片（点击可跳转到对应功能） -->
    <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
      <RouterLink
        to="/knowledge"
        class="group rounded-lg border bg-card p-6 transition-shadow hover:shadow-md"
      >
        <Database class="h-8 w-8 text-primary" />
        <h3 class="mt-4 font-semibold">知识库管理</h3>
        <p class="mt-2 text-sm text-muted-foreground">
          PostgreSQL + pgvector，上传文档自动解析分块向量化
        </p>
        <p class="mt-3 text-xs text-primary opacity-0 transition-opacity group-hover:opacity-100">
          进入知识库 →
        </p>
      </RouterLink>
      <RouterLink
        to="/knowledge"
        class="group rounded-lg border bg-card p-6 transition-shadow hover:shadow-md"
      >
        <Brain class="h-8 w-8 text-primary" />
        <h3 class="mt-4 font-semibold">RAG 引擎</h3>
        <p class="mt-2 text-sm text-muted-foreground">递归分块 + bge-m3 向量化 + 混合检索</p>
        <p class="mt-3 text-xs text-primary opacity-0 transition-opacity group-hover:opacity-100">
          管理知识库 →
        </p>
      </RouterLink>
      <RouterLink
        to="/chat"
        class="group rounded-lg border bg-card p-6 transition-shadow hover:shadow-md"
      >
        <MessageSquare class="h-8 w-8 text-primary" />
        <h3 class="mt-4 font-semibold">流式对话</h3>
        <p class="mt-2 text-sm text-muted-foreground">SSE 逐字输出，Markdown 渲染，引用溯源</p>
        <p class="mt-3 text-xs text-primary opacity-0 transition-opacity group-hover:opacity-100">
          开始对话 →
        </p>
      </RouterLink>
      <div class="rounded-lg border bg-card p-6">
        <Cloud class="h-8 w-8 text-primary" />
        <h3 class="mt-4 font-semibold">容器部署</h3>
        <p class="mt-2 text-sm text-muted-foreground">Docker + Nginx + GitHub Actions 自动化</p>
      </div>
    </div>

    <!-- 开发进度提示 -->
    <div class="mt-12 rounded-lg border border-dashed p-8 text-center">
      <p class="text-sm text-muted-foreground">
        阶段 1（用户系统）+ 阶段 2（知识库管理 / 文档解析 / 向量化）+ 阶段 3（RAG 流式问答）已完成；
        阶段 4（联网检索 / 混合检索 / 数据看板）进行中
      </p>
      <p class="mt-3">
        <RouterLink to="/knowledge" class="text-primary underline-offset-4 hover:underline">
          去管理你的知识库 →
        </RouterLink>
      </p>
    </div>
  </div>
</template>
