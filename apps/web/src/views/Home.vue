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

// ===== 首页氛围背景：漂浮粒子（随机位置/大小/速度，一次性生成） =====
interface Particle {
  left: string;
  top: string;
  size: number;
  delay: string;
  duration: string;
  opacity: number;
}
const rand = (min: number, max: number) => Math.random() * (max - min) + min;
const particles: Particle[] = Array.from({ length: 24 }, () => ({
  left: `${rand(2, 96)}%`,
  top: `${rand(4, 92)}%`,
  size: rand(2, 5),
  delay: `${rand(0, 10)}s`,
  duration: `${rand(7, 16)}s`,
  opacity: rand(0.15, 0.5),
}));
</script>

<template>
  <div
    class="relative flex min-h-[calc(100vh-4rem)] flex-col items-center overflow-hidden py-20 text-center"
  >
    <!-- 首页动态氛围背景（极光渐变 + 光斑 + 粒子，全部 pointer-events-none） -->
    <div class="pointer-events-none absolute inset-0" aria-hidden="true">
      <!-- 缓慢流动的极光渐变 -->
      <div class="home-aurora absolute inset-0" />
      <!-- 蓝色光斑（漂移） -->
      <div
        class="absolute -top-32 left-[12%] h-[26rem] w-[26rem] rounded-full bg-blue-500/15 blur-3xl dark:bg-blue-500/25 animate-float-slow"
      />
      <div
        class="absolute right-[8%] top-1/4 h-80 w-80 rounded-full bg-cyan-400/15 blur-3xl dark:bg-cyan-400/25 animate-float-slower"
      />
      <div
        class="absolute bottom-[-6rem] left-1/3 h-96 w-[28rem] rounded-full bg-blue-600/15 blur-3xl dark:bg-blue-600/25 animate-float-slow"
      />
      <!-- 漂浮粒子 -->
      <span
        v-for="(p, i) in particles"
        :key="i"
        class="home-particle"
        :style="{
          left: p.left,
          top: p.top,
          width: p.size + 'px',
          height: p.size + 'px',
          opacity: p.opacity,
          animationDelay: p.delay,
          animationDuration: p.duration,
        }"
      />
    </div>

    <!-- 内容 -->
    <div class="relative z-10 flex w-full flex-col items-center">
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
        class="mt-10 w-full max-w-xl animate-fade-up-slow rounded-lg border bg-card/80 p-6 text-left shadow-lg backdrop-blur"
        :class="
          modelConfigs.length === 0
            ? 'border-primary/40'
            : 'border-green-200 dark:border-green-500/30'
        "
      >
        <div class="flex items-start gap-3">
          <Cpu
            class="mt-0.5 h-6 w-6 shrink-0"
            :class="
              modelConfigs.length === 0 ? 'text-primary' : 'text-green-600 dark:text-green-400'
            "
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
  </div>
</template>

<style scoped>
/* 极光渐变背景：缓慢缩放旋转流动 */
.home-aurora {
  background:
    radial-gradient(ellipse 80% 55% at 18% -10%, hsla(221, 83%, 62%, 0.22), transparent 60%),
    radial-gradient(ellipse 60% 45% at 92% 15%, hsla(190, 95%, 60%, 0.16), transparent 60%),
    radial-gradient(ellipse 75% 50% at 50% 112%, hsla(221, 83%, 52%, 0.2), transparent 60%);
  animation: aurora-shift 16s ease-in-out infinite alternate;
}
@keyframes aurora-shift {
  0% {
    transform: scale(1) rotate(0deg);
  }
  100% {
    transform: scale(1.1) rotate(2.5deg);
  }
}

/* 漂浮粒子：缓慢上浮 + 左右轻摆 */
.home-particle {
  position: absolute;
  border-radius: 9999px;
  background: hsla(221, 83%, 65%, 0.9);
  animation: particle-float 10s ease-in-out infinite;
}
.dark .home-particle {
  background: hsla(221, 90%, 70%, 0.9);
}
@keyframes particle-float {
  0%,
  100% {
    transform: translate(0, 0);
  }
  25% {
    transform: translate(8px, -18px);
  }
  50% {
    transform: translate(-6px, -34px);
  }
  75% {
    transform: translate(10px, -52px);
  }
}
</style>
