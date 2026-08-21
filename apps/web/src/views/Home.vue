<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Cpu, ArrowRight } from 'lucide-vue-next';
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
  <div class="container flex flex-col items-center py-20 text-center">
    <!-- 欢迎区 -->
    <div class="max-w-xl animate-fade-up">
      <h1 class="text-3xl font-bold tracking-tight">
        你好，{{ auth.user?.nickname || auth.user?.email }} 👋
      </h1>
      <p class="mt-3 text-muted-foreground">
        你的第二大脑：知识库沉淀 + RAG 问答 + 研究报告 + 限时限量自主研究
      </p>
      <p class="mt-2">
        <span
          class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs"
          :class="{
            'bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-400':
              apiStatus === 'ok',
            'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-400': apiStatus === 'error',
            'bg-yellow-50 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-400':
              apiStatus === 'checking',
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

    <!-- 模型绑定引导（BYO：所有 AI 功能的前提） -->
    <div
      v-if="loaded"
      class="mt-10 w-full max-w-xl animate-fade-up-slow rounded-lg border p-6 text-left"
      :class="
        modelConfigs.length === 0
          ? 'border-primary/40 bg-primary/5'
          : 'border-green-200 bg-green-50/60 dark:border-green-500/30 dark:bg-green-500/10'
      "
    >
      <div class="flex items-start gap-3">
        <Cpu
          class="mt-0.5 h-6 w-6 shrink-0"
          :class="modelConfigs.length === 0 ? 'text-primary' : 'text-green-600 dark:text-green-400'"
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
                ? '对话、研究报告、自主研究全部由你自己的 Key 计费，平台不提供兜底模型。绑定后即可开始使用全部 AI 功能。'
                : '所有 AI 消耗都由你的 Key 承担，随时可在「模型配置」页增删改。'
            }}
          </p>
        </div>
      </div>
      <RouterLink
        to="/model-configs"
        class="mt-4 inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium text-white"
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

    <!-- 使用引导（纯文字，功能入口都在顶部导航） -->
    <div class="mt-12 max-w-xl animate-fade-up-slow">
      <p class="text-sm text-muted-foreground">
        从顶部导航开始：<span class="text-foreground">知识库</span> 上传资料 →
        <span class="text-foreground">对话</span> 问答与溯源 →
        <span class="text-foreground">研究报告 / 自主研究</span> 让 AI 替你调研 →
        <span class="text-foreground">数据看板</span> 查看用量
      </p>
    </div>
  </div>
</template>
