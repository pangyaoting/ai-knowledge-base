<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { Brain, LogOut, User as UserIcon } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import Button from '@/components/ui/Button.vue';

const router = useRouter();
const auth = useAuthStore();

onMounted(() => {
  // 页面刷新后如果有 token，拉取用户信息
  if (auth.isLoggedIn && !auth.user) {
    auth.fetchProfile().catch(() => {
      auth.clearAuth();
      router.push('/login');
    });
  }
});

async function handleLogout() {
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

        <div class="flex items-center gap-3">
          <div class="flex items-center gap-2 text-sm text-muted-foreground">
            <UserIcon class="h-4 w-4" />
            <span>{{ auth.user?.nickname || auth.user?.email }}</span>
          </div>
          <Button variant="ghost" size="sm" @click="handleLogout">
            <LogOut class="h-4 w-4" />
            退出
          </Button>
        </div>
      </div>
    </header>

    <!-- 页面内容 -->
    <main>
      <RouterView />
    </main>
  </div>
</template>
