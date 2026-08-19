<script setup lang="ts">
import { ref, reactive, computed, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { KeyRound, Loader2, CheckCircle2 } from 'lucide-vue-next';
import { sendCode, forgotPassword } from '@/api/auth';
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

// 第一步：邮箱 + 验证码
const step = ref<1 | 2>(1);
const form = reactive({
  email: '',
  code: '',
});
const sending = ref(false);
const countdown = ref(0);
const stepError = ref('');
const codeHint = ref('');

// 第二步：设置新密码
const pwdForm = reactive({
  password: '',
  confirm: '',
});
const loading = ref(false);
const errorMsg = ref('');
const success = ref(false);

let timer: ReturnType<typeof setInterval> | null = null;
onUnmounted(() => {
  if (timer) clearInterval(timer);
});

const canSend = computed(() => countdown.value <= 0 && !!form.email.trim());
const emailValid = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()));

async function handleSendCode() {
  stepError.value = '';
  if (!emailValid.value) {
    stepError.value = '请输入正确的邮箱地址';
    return;
  }
  sending.value = true;
  try {
    const res = await sendCode(form.email.trim(), 'forgot');
    countdown.value = 60;
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      countdown.value -= 1;
      if (countdown.value <= 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    }, 1000);
    if (res.devMode && res.code) {
      form.code = res.code;
      codeHint.value = '（开发模式）验证码已自动填入：' + res.code;
    } else {
      codeHint.value = '';
    }
  } catch (e) {
    stepError.value = (e as Error).message;
  } finally {
    sending.value = false;
  }
}

function goNext() {
  stepError.value = '';
  if (!emailValid.value) {
    stepError.value = '请输入正确的邮箱地址';
    return;
  }
  if (!form.code.trim() || form.code.trim().length !== 6) {
    stepError.value = '请输入 6 位邮箱验证码（先点击「发送验证码」）';
    return;
  }
  step.value = 2;
}

function goBack() {
  step.value = 1;
  errorMsg.value = '';
}

async function handleSubmit() {
  errorMsg.value = '';
  if (pwdForm.password.length < 6) {
    errorMsg.value = '新密码至少 6 位';
    return;
  }
  if (pwdForm.password !== pwdForm.confirm) {
    errorMsg.value = '两次输入的密码不一致';
    return;
  }

  loading.value = true;
  try {
    await forgotPassword({
      email: form.email.trim(),
      code: form.code.trim(),
      newPassword: pwdForm.password,
    });
    success.value = true;
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
          <KeyRound class="h-6 w-6" />
        </div>
        <CardTitle class="text-2xl">找回密码</CardTitle>
        <CardDescription>
          {{ step === 1 ? '验证邮箱后设置新密码' : '最后一步：设置新密码' }}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <!-- 成功：跳转登录 -->
        <div v-if="success" class="space-y-4 text-center">
          <CheckCircle2 class="mx-auto h-12 w-12 text-green-600" />
          <p class="text-sm text-muted-foreground">密码已重置成功，请使用新密码登录。</p>
          <Button class="w-full" @click="router.push('/login')">去登录</Button>
        </div>

        <!-- 第一步：邮箱 + 验证码 -->
        <form v-else-if="step === 1" class="space-y-4" @submit.prevent="goNext">
          <div
            v-if="stepError"
            class="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {{ stepError }}
          </div>

          <div class="space-y-2">
            <Label for="email">注册邮箱</Label>
            <Input
              id="email"
              v-model="form.email"
              type="email"
              placeholder="you@example.com"
              autocomplete="email"
            />
            <p class="text-xs text-muted-foreground">
              验证码会发送到这个邮箱，请确认可以正常接收。
            </p>
          </div>

          <div class="space-y-2">
            <Label for="code">邮箱验证码</Label>
            <div class="flex gap-2">
              <Input
                id="code"
                v-model="form.code"
                type="text"
                inputmode="numeric"
                maxlength="6"
                placeholder="6 位数字"
                autocomplete="one-time-code"
                class="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                class="shrink-0"
                :disabled="!canSend || sending"
                @click="handleSendCode"
              >
                <Loader2 v-if="sending" class="h-4 w-4 animate-spin" />
                {{ countdown > 0 ? `${countdown}s 后重发` : '发送验证码' }}
              </Button>
            </div>
            <p v-if="codeHint" class="text-xs text-green-600">{{ codeHint }}</p>
          </div>

          <Button type="submit" class="w-full" :disabled="!form.email.trim() || !form.code.trim()">
            下一步
          </Button>
        </form>

        <!-- 第二步：设置新密码 -->
        <form v-else class="space-y-4" @submit.prevent="handleSubmit">
          <div
            v-if="errorMsg"
            class="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {{ errorMsg }}
          </div>

          <div class="space-y-2">
            <Label for="password">新密码</Label>
            <Input
              id="password"
              v-model="pwdForm.password"
              type="password"
              placeholder="至少 6 位"
              autocomplete="new-password"
            />
          </div>

          <div class="space-y-2">
            <Label for="confirm">确认新密码</Label>
            <Input
              id="confirm"
              v-model="pwdForm.confirm"
              type="password"
              placeholder="再次输入新密码"
              autocomplete="new-password"
            />
          </div>

          <div class="flex gap-2">
            <Button type="button" variant="outline" class="flex-1" @click="goBack">
              返回修改
            </Button>
            <Button type="submit" class="flex-1" :disabled="loading">
              <Loader2 v-if="loading" class="h-4 w-4 animate-spin" />
              {{ loading ? '提交中...' : '重置密码' }}
            </Button>
          </div>
        </form>
      </CardContent>

      <CardFooter class="justify-center">
        <p class="text-sm text-muted-foreground">
          想起密码了？
          <RouterLink to="/login" class="text-primary hover:underline">去登录</RouterLink>
        </p>
      </CardFooter>
    </Card>
  </div>
</template>
