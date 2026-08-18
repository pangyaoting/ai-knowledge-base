<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { Brain, LogOut, User as UserIcon, ChevronDown, Settings, Menu } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import Button from '@/components/ui/Button.vue';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const menuOpen = ref(false); // 用户菜单
const mobileNavOpen = ref(false); // 移动端导航面板

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
          <Brain class="h-6 w-6" />
          <span class="text-lg font-semibold">AI 知识库</span>
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
            <RouterLink to="/knowledge">
              <Button variant="ghost" size="sm">知识库</Button>
            </RouterLink>
            <RouterLink to="/chat">
              <Button variant="ghost" size="sm">对话</Button>
            </RouterLink>
            <RouterLink to="/research">
              <Button variant="ghost" size="sm">研究报告</Button>
            </RouterLink>
            <RouterLink to="/dashboard">
              <Button variant="ghost" size="sm">数据看板</Button>
            </RouterLink>
          </nav>
        </div>

        <!-- 移动端导航面板（下拉） -->
        <template v-if="mobileNavOpen">
          <div class="fixed inset-0 z-40 md:hidden" @click="mobileNavOpen = false" />
          <nav
            class="absolute inset-x-0 top-full z-50 flex flex-col gap-0.5 border-b bg-card px-3 py-2 shadow-lg md:hidden"
          >
            <RouterLink to="/knowledge" @click="mobileNavOpen = false">
              <Button variant="ghost" size="sm" class="w-full justify-start">知识库</Button>
            </RouterLink>
            <RouterLink to="/chat" @click="mobileNavOpen = false">
              <Button variant="ghost" size="sm" class="w-full justify-start">对话</Button>
            </RouterLink>
            <RouterLink to="/research" @click="mobileNavOpen = false">
              <Button variant="ghost" size="sm" class="w-full justify-start">研究报告</Button>
            </RouterLink>
            <RouterLink to="/dashboard" @click="mobileNavOpen = false">
              <Button variant="ghost" size="sm" class="w-full justify-start">数据看板</Button>
            </RouterLink>
          </nav>
        </template>

        <div class="flex items-center gap-3">
          <!-- 用户菜单：点头像/名称弹出 个人中心 + 退出 -->
          <div class="relative">
            <button
              class="flex max-w-[180px] items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              @click.stop="toggleMenu"
            >
              <UserIcon class="h-4 w-4 shrink-0" />
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
              <div class="border-b px-3 py-2">
                <p class="truncate text-sm font-medium text-foreground">
                  {{ auth.user?.nickname || '未设置昵称' }}
                </p>
                <p class="truncate text-xs text-muted-foreground">{{ auth.user?.email }}</p>
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

    <!-- 页面内容 -->
    <main>
      <RouterView />
    </main>
  </div>
</template>
