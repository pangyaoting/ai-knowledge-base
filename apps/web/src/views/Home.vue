<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { Cpu, ArrowRight } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import { getModelConfigs } from '@/api/model-configs';
import HomeCosmos from '@/components/HomeCosmos.vue';
import { useTheme } from '@/composables/useTheme';
import type { ModelConfig } from '@/types/model-config';

const auth = useAuthStore();
const { isDark } = useTheme();
const apiStatus = ref<'checking' | 'ok' | 'error'>('checking');
const modelConfigs = ref<ModelConfig[]>([]);
const loaded = ref(false);

// 服务状态徽章样式（随主题切换深浅配色）
const statusBadge = computed(() => {
  if (apiStatus.value === 'ok') {
    return isDark.value ? 'bg-green-500/15 text-green-400' : 'bg-green-500/15 text-green-700';
  }
  if (apiStatus.value === 'error') {
    return isDark.value ? 'bg-red-500/15 text-red-400' : 'bg-red-500/15 text-red-600';
  }
  return isDark.value ? 'bg-yellow-500/15 text-yellow-400' : 'bg-yellow-500/15 text-yellow-700';
});
const statusDot = computed(() => {
  if (apiStatus.value === 'ok') {
    return isDark.value ? 'bg-green-400' : 'bg-green-600';
  }
  if (apiStatus.value === 'error') {
    return isDark.value ? 'bg-red-400' : 'bg-red-600';
  }
  return isDark.value ? 'bg-yellow-400 animate-pulse' : 'bg-yellow-600 animate-pulse';
});
const statusLabel = computed(() =>
  apiStatus.value === 'ok' ? '服务正常' : apiStatus.value === 'error' ? '服务异常' : '检测中...',
);

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
  <div
    class="relative flex min-h-[calc(100dvh-4rem-1px)] flex-col items-center overflow-hidden py-20 text-center"
  >
    <!-- 背景层：暗黑=黑洞 / 浅色=白洞，Canvas 实时渲染并随全局主题交叉切换 -->
    <div class="pointer-events-none absolute inset-0" aria-hidden="true">
      <HomeCosmos />
    </div>

    <!-- 内容（颜色随主题：白洞亮底用深色文字，黑洞深底用浅色文字） -->
    <div class="relative z-10 flex w-full flex-col items-center">
      <!-- 欢迎区 -->
      <div class="max-w-xl animate-fade-up">
        <h1
          class="text-3xl font-bold tracking-tight"
          :class="isDark ? 'text-slate-50' : 'text-slate-900'"
        >
          你好，{{ auth.user?.nickname || auth.user?.email }} 👋
        </h1>
        <p class="mt-3" :class="isDark ? 'text-slate-300' : 'text-slate-600'">
          你的第二大脑：知识库沉淀 + RAG 问答 + 研究报告 + 限时限量自主研究
        </p>
        <p class="mt-2">
          <span
            class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs"
            :class="statusBadge"
          >
            <span class="h-1.5 w-1.5 rounded-full" :class="statusDot" />
            {{ statusLabel }}
          </span>
        </p>
      </div>

      <!-- 模型绑定引导（BYO：所有 AI 功能的前提） -->
      <div
        v-if="loaded"
        class="mt-10 w-full max-w-xl animate-fade-up-slow rounded-lg border p-6 text-left shadow-lg backdrop-blur"
        :class="isDark ? 'border-white/10 bg-slate-900/70' : 'border-black/10 bg-white/75'"
      >
        <div class="flex items-start gap-3">
          <Cpu
            class="mt-0.5 h-6 w-6 shrink-0"
            :class="
              modelConfigs.length === 0
                ? isDark
                  ? 'text-blue-400'
                  : 'text-blue-600'
                : isDark
                  ? 'text-green-400'
                  : 'text-green-600'
            "
          />
          <div>
            <p class="font-semibold" :class="isDark ? 'text-slate-100' : 'text-slate-800'">
              {{
                modelConfigs.length === 0
                  ? '第一步：绑定你自己的大模型 API Key'
                  : `已绑定 ${modelConfigs.length} 个模型配置（默认：${modelConfigs.find((c) => c.isDefault)?.name ?? '未设置'}）`
              }}
            </p>
            <p class="mt-1 text-sm" :class="isDark ? 'text-slate-400' : 'text-slate-500'">
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
              ? 'bg-blue-500 hover:bg-blue-600'
              : 'bg-green-600 hover:bg-green-700'
          "
        >
          {{ modelConfigs.length === 0 ? '立即绑定' : '管理模型配置' }}
          <ArrowRight class="h-4 w-4" />
        </RouterLink>
      </div>
    </div>
  </div>
</template>
