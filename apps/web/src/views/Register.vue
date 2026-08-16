<script setup lang="ts">
import { ref, reactive } from 'vue';
import { useRouter } from 'vue-router';
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
const auth = useAuthStore();

const form = reactive({
  email: '',
  password: '',
  nickname: '',
});
const loading = ref(false);
const errorMsg = ref('');

async function handleSubmit() {
  errorMsg.value = '';

  if (!form.email || !form.password) {
    errorMsg.value = '请填写邮箱和密码';
    return;
  }
  if (form.password.length < 6) {
    errorMsg.value = '密码至少6位';
    return;
  }

  loading.value = true;
  try {
    await auth.register(form);
    router.push('/');
  } catch (e) {
    errorMsg.value = (e as Error).message;
  } finally {
    loading.value = false;
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
        <CardTitle class="text-2xl">创建账号</CardTitle>
        <CardDescription>注册一个新账号开始使用</CardDescription>
      </CardHeader>

      <CardContent>
        <form @submit.prevent="handleSubmit" class="space-y-4">
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
            <Label for="nickname">昵称（选填）</Label>
            <Input
              id="nickname"
              v-model="form.nickname"
              type="text"
              placeholder="你的昵称"
              autocomplete="nickname"
            />
          </div>

          <div class="space-y-2">
            <Label for="password">密码</Label>
            <Input
              id="password"
              v-model="form.password"
              type="password"
              placeholder="至少6位"
              autocomplete="new-password"
            />
          </div>

          <Button type="submit" class="w-full" :disabled="loading">
            <Loader2 v-if="loading" class="h-4 w-4 animate-spin" />
            {{ loading ? '注册中...' : '注册' }}
          </Button>
        </form>
      </CardContent>

      <CardFooter class="justify-center">
        <p class="text-sm text-muted-foreground">
          已有账号？
          <RouterLink to="/login" class="text-primary hover:underline">去登录</RouterLink>
        </p>
      </CardFooter>
    </Card>
  </div>
</template>
