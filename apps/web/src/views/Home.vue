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

// ===== 星空背景（暗色模式全效）：星星 / 流星 =====
const rand = (min: number, max: number) => Math.random() * (max - min) + min;

interface Star {
  left: string;
  top: string;
  size: number;
  delay: string;
  duration: string;
}
/** 120 颗星星：1px 小星为主、少量 2-3px 亮星 */
const stars: Star[] = Array.from({ length: 120 }, (_, i) => ({
  left: `${rand(1, 99)}%`,
  top: `${rand(1, 96)}%`,
  size: i % 8 === 0 ? rand(2.2, 3.2) : i % 3 === 0 ? rand(1.5, 2.2) : rand(1, 1.5),
  delay: `${rand(0, 5)}s`,
  duration: `${rand(2.2, 6)}s`,
}));

interface Meteor {
  left: string;
  top: string;
  delay: string;
  duration: string;
}
/** 4 条流星：从右上往左下划过 */
const meteors: Meteor[] = Array.from({ length: 4 }, () => ({
  left: `${rand(55, 95)}%`,
  top: `${rand(-5, 8)}%`,
  delay: `${rand(2, 12)}s`,
  duration: `${rand(5, 9)}s`,
}));

/** 浅色模式的漂浮粒子（星空下隐藏，避免与星星重复） */
interface Particle {
  left: string;
  top: string;
  size: number;
  delay: string;
  duration: string;
  opacity: number;
}
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
    <!-- 背景层：暗色=星空全效（深空渐变+星云+星星+流星）；浅色=极光+粒子 -->
    <div class="pointer-events-none absolute inset-0" aria-hidden="true">
      <!-- 星空底（暗色启用）：深空渐变 + 星云 -->
      <div class="starfield absolute inset-0" />
      <!-- 浅色极光渐变 -->
      <div class="home-aurora absolute inset-0" />
      <!-- 星云光斑（漂移） -->
      <div
        class="absolute -top-32 left-[12%] h-[26rem] w-[26rem] rounded-full bg-blue-500/15 blur-3xl dark:bg-blue-500/25 animate-float-slow"
      />
      <div
        class="absolute right-[8%] top-1/4 h-80 w-80 rounded-full bg-cyan-400/15 blur-3xl dark:bg-cyan-400/25 animate-float-slower"
      />
      <div
        class="absolute bottom-[-6rem] left-1/3 h-96 w-[28rem] rounded-full bg-blue-600/15 blur-3xl dark:bg-blue-600/25 animate-float-slow"
      />
      <!-- 星星（暗色显示）：闪烁 + 整体缓慢漂移 -->
      <div class="star-layer absolute inset-0">
        <span
          v-for="(s, i) in stars"
          :key="'s' + i"
          class="star"
          :style="{
            left: s.left,
            top: s.top,
            width: s.size + 'px',
            height: s.size + 'px',
            animationDelay: s.delay,
            animationDuration: s.duration,
          }"
        />
      </div>
      <!-- 流星（暗色显示） -->
      <span
        v-for="(m, i) in meteors"
        :key="'m' + i"
        class="meteor"
        :style="{
          left: m.left,
          top: m.top,
          animationDelay: m.delay,
          animationDuration: m.duration,
        }"
      />
      <!-- 浅色模式的漂浮粒子 -->
      <span
        v-for="(p, i) in particles"
        :key="'p' + i"
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
/* ==================== 浅色：极光渐变 ==================== */
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

/* ==================== 暗色：星空 ==================== */
/* 深空渐变底 + 星云（暗色启用，浅色隐藏） */
.starfield {
  display: none;
  background:
    radial-gradient(ellipse 55% 40% at 18% 12%, rgba(59, 130, 246, 0.14), transparent 65%),
    radial-gradient(ellipse 45% 35% at 85% 25%, rgba(139, 92, 246, 0.12), transparent 65%),
    radial-gradient(ellipse 60% 45% at 55% 105%, rgba(56, 189, 248, 0.1), transparent 65%),
    linear-gradient(180deg, #04060f 0%, #070d22 45%, #0a1430 100%);
}
.dark .starfield {
  display: block;
}

/* 星星层：整体缓慢漂移 */
.star-layer {
  animation: star-drift 60s ease-in-out infinite alternate;
}
@keyframes star-drift {
  0% {
    transform: translate3d(0, 0, 0);
  }
  100% {
    transform: translate3d(-30px, 16px, 0);
  }
}

/* 星星：闪烁（暗色显示） */
.star {
  position: absolute;
  display: none;
  border-radius: 9999px;
  background: #fff;
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.6);
  animation-name: twinkle;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
.dark .star {
  display: block;
}
@keyframes twinkle {
  0%,
  100% {
    opacity: 0.12;
    transform: scale(0.85);
  }
  50% {
    opacity: 0.95;
    transform: scale(1.15);
  }
}

/* 流星：右上往左下划过（暗色显示） */
.meteor {
  position: absolute;
  display: none;
  width: 150px;
  height: 1.5px;
  border-radius: 9999px;
  background: linear-gradient(to right, transparent, rgba(255, 255, 255, 0.85));
  animation-name: meteor-fall;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}
.dark .meteor {
  display: block;
}
@keyframes meteor-fall {
  0% {
    transform: translate3d(0, 0, 0) rotate(-45deg);
    opacity: 0;
  }
  3% {
    opacity: 1;
  }
  11% {
    transform: translate3d(-460px, 460px, 0) rotate(-45deg);
    opacity: 0;
  }
  100% {
    transform: translate3d(-460px, 460px, 0) rotate(-45deg);
    opacity: 0;
  }
}

/* 浅色漂浮粒子（暗色下隐藏，避免与星星重复） */
.home-particle {
  position: absolute;
  display: block;
  border-radius: 9999px;
  background: hsla(221, 83%, 65%, 0.9);
  animation-name: particle-float;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
.dark .home-particle {
  display: none;
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
