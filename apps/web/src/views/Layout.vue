<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import {
  Brain,
  LogOut,
  User as UserIcon,
  ChevronDown,
  Settings,
  Menu,
  Sun,
  Moon,
} from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import { useTheme } from '@/composables/useTheme';
import Button from '@/components/ui/Button.vue';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
// 解构顶层 ref：模板中自动解包（直接 theme.isDark 拿到的是 Ref 对象，恒为真值）
const { isDark, toggleTheme } = useTheme();

const menuOpen = ref(false); // 用户菜单
const mobileNavOpen = ref(false); // 移动端导航面板

/** 导航项：to + 文案（桌面端与移动端共用） */
const navItems = [
  { to: '/', label: '首页' },
  { to: '/knowledge', label: '知识库' },
  { to: '/chat', label: '对话' },
  { to: '/research', label: '研究报告' },
  { to: '/research-agent', label: '自主研究' },
  { to: '/dashboard', label: '数据看板' },
] as const;

/** 当前导航是否高亮：精确匹配，或按"路径段"前缀匹配（避免 /research 误配 /research-agent） */
function isNavActive(to: string): boolean {
  return route.path === to || route.path.startsWith(to + '/');
}

// 路由变化时收起移动端导航
watch(
  () => route.fullPath,
  () => {
    mobileNavOpen.value = false;
  },
);

onMounted(() => {
  // 页面刷新后如果有 token，拉取用户信息
  if (auth.isLoggedIn && !auth.user) {
    auth.fetchProfile().catch(() => {
      auth.clearAuth();
      router.push('/login');
    });
  }
});

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}

function goSettings() {
  menuOpen.value = false;
  router.push('/settings');
}

async function handleLogout() {
  menuOpen.value = false;
  await auth.logout();
  router.push('/login');
}
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- 顶部导航 -->
    <header class="sticky top-0 z-50 border-b bg-background/80 backdrop-blur">
      <div class="container flex h-16 items-center justify-between">
        <RouterLink to="/" class="flex items-center gap-2">
          <span
            class="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 text-primary-foreground shadow-sm"
          >
            <Brain class="h-5 w-5" />
          </span>
          <span class="text-lg font-semibold tracking-tight">AI 知识库</span>
        </RouterLink>

        <div class="flex items-center gap-1">
          <!-- 移动端：汉堡菜单打开导航面板 -->
          <button
            class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
            aria-label="导航菜单"
            @click.stop="mobileNavOpen = !mobileNavOpen"
          >
            <Menu class="h-5 w-5" />
          </button>

          <!-- 导航（桌面端常驻） -->
          <nav class="mr-2 hidden items-center gap-1 sm:flex">
            <RouterLink
              v-for="item in navItems"
              :key="item.to"
              :to="item.to"
              :class="
                isNavActive(item.to)
                  ? 'rounded-md bg-accent font-medium text-primary shadow-sm'
                  : 'rounded-md font-medium text-foreground/80 hover:bg-accent/60 hover:text-primary'
              "
            >
              <Button variant="ghost" size="sm" :class="isNavActive(item.to) ? 'text-primary' : ''">
                {{ item.label }}
              </Button>
            </RouterLink>
            <RouterLink to="/model-configs">
              <Button
                variant="outline"
                size="sm"
                class="ml-1 border-primary/40 font-medium text-primary"
              >
                模型配置
              </Button>
            </RouterLink>
          </nav>
        </div>

        <!-- 移动端导航面板（下拉） -->
        <template v-if="mobileNavOpen">
          <div class="fixed inset-0 z-40 md:hidden" @click="mobileNavOpen = false" />
          <nav
            class="absolute inset-x-0 top-full z-50 flex flex-col gap-0.5 border-b bg-card px-3 py-2 shadow-lg md:hidden"
          >
            <RouterLink
              v-for="item in navItems"
              :key="item.to"
              :to="item.to"
              @click="mobileNavOpen = false"
              :class="
                isNavActive(item.to)
                  ? 'rounded-md bg-accent font-medium text-primary'
                  : 'font-medium text-foreground/80'
              "
            >
              <Button
                variant="ghost"
                size="sm"
                class="w-full justify-start"
                :class="isNavActive(item.to) ? 'text-primary' : ''"
              >
                {{ item.label }}
              </Button>
            </RouterLink>
            <RouterLink to="/model-configs" @click="mobileNavOpen = false">
              <Button variant="ghost" size="sm" class="w-full justify-start">模型配置</Button>
            </RouterLink>
          </nav>
        </template>

        <div class="flex items-center gap-3">
          <!-- 暗色/浅色切换 -->
          <button
            class="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            :title="isDark ? '切换到浅色模式' : '切换到暗色模式'"
            aria-label="切换主题"
            @click="toggleTheme"
          >
            <Sun v-if="isDark" class="h-4 w-4" />
            <Moon v-else class="h-4 w-4" />
          </button>

          <!-- 用户菜单：点头像/名称弹出 个人中心 + 退出 -->
          <div class="relative">
            <button
              class="flex max-w-[180px] items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              @click.stop="toggleMenu"
            >
              <img
                v-if="auth.user?.avatar"
                :src="auth.user.avatar"
                class="h-4 w-4 shrink-0 rounded-full object-cover"
                alt=""
              />
              <UserIcon v-else class="h-4 w-4 shrink-0" />
              <span class="min-w-0 flex-1 truncate">
                {{ auth.user?.nickname || auth.user?.email }}
              </span>
              <ChevronDown
                class="h-3.5 w-3.5 shrink-0 transition-transform"
                :class="{ 'rotate-180': menuOpen }"
              />
            </button>

            <!-- 点击外部关闭 -->
            <div v-if="menuOpen" class="fixed inset-0 z-40" @click="menuOpen = false" />

            <div
              v-if="menuOpen"
              class="absolute right-0 top-full z-50 mt-1.5 w-44 overflow-hidden rounded-lg border bg-card py-1 shadow-lg"
            >
              <div class="flex items-center gap-2 border-b px-3 py-2">
                <img
                  v-if="auth.user?.avatar"
                  :src="auth.user.avatar"
                  class="h-8 w-8 shrink-0 rounded-full object-cover"
                  alt=""
                />
                <span
                  v-else
                  class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary"
                >
                  {{ (auth.user?.email || '?')[0].toUpperCase() }}
                </span>
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium text-foreground">
                    {{ auth.user?.nickname || '未设置昵称' }}
                  </p>
                  <p class="truncate text-xs text-muted-foreground">{{ auth.user?.email }}</p>
                </div>
              </div>
              <button
                class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                @click="goSettings"
              >
                <Settings class="h-4 w-4" />
                个人中心
              </button>
              <button
                class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
                @click="handleLogout"
              >
                <LogOut class="h-4 w-4" />
                退出登录
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>

    <!-- 页面内容（带路由切换过渡） -->
    <main class="relative">
      <RouterView v-slot="{ Component }">
        <Transition name="page" mode="out-in">
          <component :is="Component" />
        </Transition>
      </RouterView>
    </main>

    <!-- 全局氛围背景：蓝色光斑缓慢漂移（暗色下更亮，不影响内容可读性） -->
    <div class="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div
        class="absolute -top-40 left-1/4 h-[28rem] w-[28rem] rounded-full bg-blue-500/10 blur-3xl dark:bg-blue-500/20 animate-float-slow"
      />
      <div
        class="absolute -right-32 top-1/3 h-80 w-80 rounded-full bg-cyan-400/10 blur-3xl dark:bg-cyan-400/20 animate-float-slower"
      />
      <div
        class="absolute -bottom-40 left-1/6 h-96 w-[30rem] rounded-full bg-blue-600/10 blur-3xl dark:bg-blue-600/20 animate-float-slow"
      />
    </div>
  </div>
</template>
