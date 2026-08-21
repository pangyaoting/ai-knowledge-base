<script setup lang="ts">
import { ref, reactive, computed, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { Brain, Loader2, MailCheck } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import { sendCode, verifyCode } from '@/api/auth';
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

// 第一步：邮箱 + 验证码
const step = ref<1 | 2>(1);
const form = reactive({
  email: '',
  code: '',
});
const sending = ref(false);
const checking = ref(false); // 第一步"点下一步"校验中
const countdown = ref(0);
const stepError = ref('');
const codeHint = ref(''); // 开发模式：验证码随响应返回，自动填入并提示

// 第二步：设置密码
const pwdForm = reactive({
  password: '',
  confirm: '',
  nickname: '',
});
const loading = ref(false);
const errorMsg = ref('');

let timer: ReturnType<typeof setInterval> | null = null;
onUnmounted(() => {
  if (timer) clearInterval(timer);
});

const canSend = computed(() => countdown.value <= 0 && !!form.email.trim());
const emailValid = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()));

/** 发送验证码（60 秒重发限制由后端控制，前端倒计时兜底防误触） */
async function handleSendCode() {
  stepError.value = '';
  if (!emailValid.value) {
    stepError.value = '请输入正确的邮箱地址';
    return;
  }
  sending.value = true;
  try {
    const res = await sendCode(form.email.trim(), 'register');
    countdown.value = 60;
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      countdown.value -= 1;
      if (countdown.value <= 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    }, 1000);
    // 开发模式：后端未配置 SMTP，验证码直接随响应返回 → 自动填入方便本地联调
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

/**
 * 第一步校验通过 → 设置密码。
 * 点「下一步」就调后端校验：邮箱是否已被注册 + 验证码是否正确/未过期
 * （只校验不消费，验证码保留到第二步提交注册时再真正使用）。
 */
async function goNext() {
  stepError.value = '';
  if (!emailValid.value) {
    stepError.value = '请输入正确的邮箱地址';
    return;
  }
  if (!form.code.trim() || form.code.trim().length !== 6) {
    stepError.value = '请输入 6 位邮箱验证码（先点击「发送验证码」）';
    return;
  }
  checking.value = true;
  try {
    await verifyCode({ email: form.email.trim(), type: 'register', code: form.code.trim() });
    step.value = 2;
  } catch (e) {
    stepError.value = (e as Error).message;
  } finally {
    checking.value = false;
  }
}

function goBack() {
  step.value = 1;
  errorMsg.value = '';
}

/** 完成注册（后端会再次校验验证码） */
async function handleSubmit() {
  errorMsg.value = '';
  if (pwdForm.password.length < 6) {
    errorMsg.value = '密码至少 6 位';
    return;
  }
  if (pwdForm.password !== pwdForm.confirm) {
    errorMsg.value = '两次输入的密码不一致';
    return;
  }

  loading.value = true;
  try {
    await auth.register({
      email: form.email.trim(),
      code: form.code.trim(),
      password: pwdForm.password,
      nickname: pwdForm.nickname.trim() || undefined,
    });
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
    class="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4"
  >
    <!-- 品牌氛围光斑（暗色下自动变暗） -->
    <div
      class="pointer-events-none absolute -top-24 left-1/2 h-72 w-[36rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
    />
    <Card class="relative w-full max-w-md shadow-xl">
      <CardHeader class="text-center">
        <div
          class="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground"
        >
          <Brain class="h-6 w-6" />
        </div>
        <CardTitle class="text-2xl">创建账号</CardTitle>
        <CardDescription>
          {{ step === 1 ? '验证邮箱后设置密码' : '最后一步：设置登录密码' }}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <!-- 第一步：邮箱验证 -->
        <form v-if="step === 1" class="space-y-4" @submit.prevent="goNext">
          <div
            v-if="stepError"
            class="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {{ stepError }}
          </div>

          <div class="space-y-2">
            <Label for="email">真实邮箱</Label>
            <Input
              id="email"
              v-model="form.email"
              type="email"
              placeholder="you@example.com"
              autocomplete="off"
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
            <p v-if="codeHint" class="text-xs text-green-600 dark:text-green-400">{{ codeHint }}</p>
          </div>

          <Button
            type="submit"
            class="w-full"
            :disabled="!form.email.trim() || !form.code.trim() || checking"
          >
            <Loader2 v-if="checking" class="h-4 w-4 animate-spin" />
            {{ checking ? '校验中...' : '下一步' }}
          </Button>
        </form>

        <!-- 第二步：设置密码 -->
        <form v-else class="space-y-4" @submit.prevent="handleSubmit">
          <div
            class="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
          >
            <MailCheck class="h-4 w-4 text-green-600 dark:text-green-400" />
            <span class="truncate">已验证邮箱：{{ form.email }}</span>
          </div>

          <div
            v-if="errorMsg"
            class="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {{ errorMsg }}
          </div>

          <div class="space-y-2">
            <Label for="password">设置密码</Label>
            <Input
              id="password"
              v-model="pwdForm.password"
              type="password"
              placeholder="至少 6 位"
              autocomplete="new-password"
            />
          </div>

          <div class="space-y-2">
            <Label for="confirm">确认密码</Label>
            <Input
              id="confirm"
              v-model="pwdForm.confirm"
              type="password"
              placeholder="再次输入密码"
              autocomplete="new-password"
            />
          </div>

          <div class="space-y-2">
            <Label for="nickname">昵称（选填）</Label>
            <Input
              id="nickname"
              v-model="pwdForm.nickname"
              type="text"
              placeholder="你的昵称"
              autocomplete="off"
            />
          </div>

          <div class="flex gap-2">
            <Button type="button" variant="outline" class="flex-1" @click="goBack">
              返回修改
            </Button>
            <Button type="submit" class="flex-1" :disabled="loading">
              <Loader2 v-if="loading" class="h-4 w-4 animate-spin" />
              {{ loading ? '注册中...' : '完成注册' }}
            </Button>
          </div>
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
