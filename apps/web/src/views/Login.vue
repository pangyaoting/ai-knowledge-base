<script setup lang="ts">
import { ref, reactive } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { Brain, Loader2 } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import Card from '@/components/ui/Card.vue';
import CardHeader from '@/components/ui/CardHeader.vue';
import CardTitle from '@/components/ui/CardTitle.vue';
import CardDescription from '@/components/ui/CardDescription.vue';
import CardContent from '@/components/ui/CardContent.vue';
import CardFooter from '@/components/ui/CardFooter.vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
import Button from '@/components/ui/Button.vue';
import { DEMO_ACCOUNT } from '@/config/demo';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const form = reactive({
  email: '',
  password: '',
});
const loading = ref(false);
const errorMsg = ref('');

async function handleSubmit() {
  errorMsg.value = '';

  if (!form.email || !form.password) {
    errorMsg.value = '请填写邮箱和密码';
    return;
  }

  loading.value = true;
  try {
    await auth.login(form);
    const redirect = (route.query.redirect as string) || '/';
    router.push(redirect);
  } catch (e) {
    errorMsg.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

/** 一键体验：填入演示账号并直接登录（公安备案审核员 / 访客用，账号只读） */
async function handleDemoLogin() {
  if (!DEMO_ACCOUNT) return;
  form.email = DEMO_ACCOUNT.email;
  form.password = DEMO_ACCOUNT.password;
  await handleSubmit();
}
</script>

<template>
  <div
    class="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4"
  >
    <!-- 品牌氛围光斑（暗色下自动变暗） -->
    <div
      class="pointer-events-none absolute -top-24 left-1/2 h-72 w-[36rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
    />
    <div
      class="pointer-events-none absolute -bottom-32 right-1/4 h-64 w-96 rounded-full bg-primary/5 blur-3xl"
    />
    <Card class="relative w-full max-w-md shadow-xl">
      <CardHeader class="text-center">
        <div
          class="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground"
        >
          <Brain class="h-6 w-6" />
        </div>
        <CardTitle class="text-2xl">欢迎回来</CardTitle>
        <CardDescription>登录你的 AI 知识库账号</CardDescription>
      </CardHeader>

      <CardContent>
        <!-- 演示/审核体验入口：账号为**只读**（服务端 DEMO_READONLY_EMAILS 拦截写操作），
             给公安联网备案审核员、面试官一键进屋看真实数据用 -->
        <div
          v-if="DEMO_ACCOUNT"
          class="mb-4 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-xs"
        >
          <p class="font-medium text-primary">🔍 审核 / 访客体验（只读）</p>
          <p class="mt-1 text-muted-foreground">{{ DEMO_ACCOUNT.note }}</p>
          <p class="mt-1.5 font-mono text-[11px] text-muted-foreground">
            账号 {{ DEMO_ACCOUNT.email }} · 密码 {{ DEMO_ACCOUNT.password }}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            class="mt-2 w-full"
            :disabled="loading"
            @click="handleDemoLogin"
          >
            一键体验（免输入，直接进入）
          </Button>
        </div>

        <form class="space-y-4" @submit.prevent="handleSubmit">
          <div
            v-if="errorMsg"
            class="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {{ errorMsg }}
          </div>

          <div class="space-y-2">
            <Label for="email">邮箱</Label>
            <Input
              id="email"
              v-model="form.email"
              type="email"
              placeholder="you@example.com"
              autocomplete="off"
            />
          </div>

          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <Label for="password">密码</Label>
              <RouterLink
                to="/forgot-password"
                class="text-xs text-muted-foreground hover:underline"
              >
                忘记密码？
              </RouterLink>
            </div>
            <Input
              id="password"
              v-model="form.password"
              type="password"
              placeholder="••••••••"
              autocomplete="new-password"
            />
          </div>

          <Button type="submit" class="w-full" :disabled="loading">
            <Loader2 v-if="loading" class="h-4 w-4 animate-spin" />
            {{ loading ? '登录中...' : '登录' }}
          </Button>
        </form>
      </CardContent>

      <CardFooter class="justify-center">
        <p class="text-sm text-muted-foreground">
          还没有账号？
          <RouterLink to="/register" class="text-primary hover:underline">立即注册</RouterLink>
        </p>
      </CardFooter>
    </Card>
  </div>
</template>
