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

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const form = reactive({
  email: '',
  password: '',
});
const loading = ref(false);
const errorMsg = ref('');

// 2FA 第二步：开启双因素认证的用户，密码验证后还需动态码/恢复码
const need2fa = ref(false);
const loginToken = ref('');
const twofaCode = ref('');
const submitting2fa = ref(false);

async function handleSubmit() {
  errorMsg.value = '';

  if (!form.email || !form.password) {
    errorMsg.value = '请填写邮箱和密码';
    return;
  }

  loading.value = true;
  try {
    const result = await auth.login(form);
    // 需要第二步：进入验证码输入
    if ('need2fa' in result) {
      need2fa.value = true;
      loginToken.value = result.loginToken;
      return;
    }
    const redirect = (route.query.redirect as string) || '/';
    router.push(redirect);
  } catch (e) {
    errorMsg.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

/** 第二步：动态码 / 恢复码 */
async function handleTwoFactor() {
  errorMsg.value = '';
  if (!twofaCode.value.trim()) {
    errorMsg.value = '请输入 6 位动态码或恢复码';
    return;
  }
  submitting2fa.value = true;
  try {
    await auth.login2fa({ loginToken: loginToken.value, code: twofaCode.value.trim() });
    const redirect = (route.query.redirect as string) || '/';
    router.push(redirect);
  } catch (e) {
    errorMsg.value = (e as Error).message;
  } finally {
    submitting2fa.value = false;
  }
}
</script>

<template>
  <div
    class="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-50 to-white p-4"
  >
    <Card class="w-full max-w-md">
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
        <!-- 第二步：双因素认证动态码 -->
        <form v-if="need2fa" class="space-y-4" @submit.prevent="handleTwoFactor">
          <div class="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            密码已验证。请在验证器 App（如 Google Authenticator / Microsoft Authenticator）查看 6
            位动态码，或输入一次性恢复码完成登录。
          </div>
          <div
            v-if="errorMsg"
            class="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {{ errorMsg }}
          </div>
          <div class="space-y-2">
            <Label for="twofa">动态码 / 恢复码</Label>
            <Input
              id="twofa"
              v-model="twofaCode"
              type="text"
              placeholder="6 位数字，或 xxxx-xxxx 恢复码"
              autocomplete="one-time-code"
            />
          </div>
          <Button type="submit" class="w-full" :disabled="submitting2fa">
            <Loader2 v-if="submitting2fa" class="h-4 w-4 animate-spin" />
            {{ submitting2fa ? '验证中...' : '完成登录' }}
          </Button>
          <button
            type="button"
            class="w-full text-center text-xs text-muted-foreground hover:underline"
            @click="need2fa = false"
          >
            返回重新输入密码
          </button>
        </form>

        <!-- 第一步：邮箱 + 密码 -->
        <form v-else class="space-y-4" @submit.prevent="handleSubmit">
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
              autocomplete="email"
            />
          </div>

          <div class="space-y-2">
            <Label for="password">密码</Label>
            <Input
              id="password"
              v-model="form.password"
              type="password"
              placeholder="••••••••"
              autocomplete="current-password"
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
