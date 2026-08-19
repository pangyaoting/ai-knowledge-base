<script setup lang="ts">
import { ref, reactive, computed, onUnmounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { updateProfile, changePassword } from '@/api/user';
import { sendCode, bindEmail } from '@/api/auth';
import { Loader2, UserRound, KeyRound, Mail, ArrowUpRight } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
import { toast } from '@/composables/useToast';

const auth = useAuthStore();

// ===== 资料 =====
const profileForm = reactive({ nickname: auth.user?.nickname ?? '' });
const savingProfile = ref(false);

async function saveProfile() {
  savingProfile.value = true;
  try {
    await updateProfile({ nickname: profileForm.nickname.trim() });
    toast.success('资料已更新');
    auth.fetchProfile().catch(() => undefined);
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    savingProfile.value = false;
  }
}

// ===== 更换邮箱 =====
const bindForm = reactive({ email: '', code: '' });
const sendingCode = ref(false);
const countdown = ref(0);
const binding = ref(false);
const bindError = ref('');
const bindHint = ref('');

let timer: ReturnType<typeof setInterval> | null = null;
onUnmounted(() => {
  if (timer) clearInterval(timer);
});

const canSendBind = computed(() => countdown.value <= 0 && !!bindForm.email.trim());

async function handleSendBindCode() {
  bindError.value = '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bindForm.email.trim())) {
    bindError.value = '请输入正确的邮箱地址';
    return;
  }
  if (bindForm.email.trim().toLowerCase() === (auth.user?.email ?? '').toLowerCase()) {
    bindError.value = '新邮箱与当前邮箱相同';
    return;
  }
  sendingCode.value = true;
  try {
    const res = await sendCode(bindForm.email.trim(), 'bind');
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
      bindForm.code = res.code;
      bindHint.value = '（开发模式）验证码已自动填入：' + res.code;
    } else {
      bindHint.value = '';
    }
  } catch (e) {
    bindError.value = (e as Error).message;
  } finally {
    sendingCode.value = false;
  }
}

async function handleBindEmail() {
  bindError.value = '';
  if (!bindForm.code.trim() || bindForm.code.trim().length !== 6) {
    bindError.value = '请输入 6 位验证码';
    return;
  }
  binding.value = true;
  try {
    const updated = await bindEmail({
      email: bindForm.email.trim(),
      code: bindForm.code.trim(),
    });
    auth.user = updated; // 更新本地用户信息（邮箱已变）
    toast.success('邮箱已更换成功');
    bindForm.email = '';
    bindForm.code = '';
    bindHint.value = '';
  } catch (e) {
    bindError.value = (e as Error).message;
  } finally {
    binding.value = false;
  }
}

// ===== 密码 =====
const passwordForm = reactive({ oldPassword: '', newPassword: '', confirm: '' });
const savingPassword = ref(false);
const pwdMsg = ref('');
const pwdError = ref('');

async function savePassword() {
  pwdError.value = '';
  pwdMsg.value = '';
  if (passwordForm.newPassword.length < 6) {
    pwdError.value = '新密码至少 6 位';
    return;
  }
  if (passwordForm.newPassword !== passwordForm.confirm) {
    pwdError.value = '两次输入的新密码不一致';
    return;
  }
  savingPassword.value = true;
  try {
    await changePassword({
      oldPassword: passwordForm.oldPassword,
      newPassword: passwordForm.newPassword,
    });
    toast.success('密码已修改，下次登录请使用新密码');
    passwordForm.oldPassword = '';
    passwordForm.newPassword = '';
    passwordForm.confirm = '';
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    savingPassword.value = false;
  }
}
</script>

<template>
  <div class="container py-10">
    <div class="mb-8">
      <h1 class="text-2xl font-bold tracking-tight">个人中心</h1>
      <p class="mt-1 text-sm text-muted-foreground">管理你的资料与账号安全</p>
    </div>

    <!-- 提示：模型配置已移到导航栏 -->
    <RouterLink
      to="/model-configs"
      class="mb-6 flex items-center justify-between rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm transition-colors hover:bg-primary/10"
    >
      <span class="text-muted-foreground">
        使用 AI 功能前请先绑定你自己的模型 Key（对话 / 研究报告 / 图谱都由你的 Key 计费）
      </span>
      <span class="flex items-center gap-1 font-medium text-primary">
        去模型配置 <ArrowUpRight class="h-4 w-4" />
      </span>
    </RouterLink>

    <div class="grid gap-6 lg:grid-cols-2">
      <!-- 资料 -->
      <div class="rounded-lg border bg-card p-6">
        <div class="flex items-center gap-2">
          <UserRound class="h-4 w-4 text-primary" />
          <h2 class="font-semibold">基本资料</h2>
        </div>
        <div class="mt-5 space-y-4">
          <div class="space-y-1.5">
            <Label>邮箱</Label>
            <Input :model-value="auth.user?.email ?? ''" disabled />
            <p class="text-xs text-muted-foreground">邮箱为登录账号，更换请用下方「更换邮箱」</p>
          </div>
          <div class="space-y-1.5">
            <Label>昵称</Label>
            <Input v-model="profileForm.nickname" placeholder="你的昵称" />
          </div>
          <Button :disabled="savingProfile" @click="saveProfile">
            <Loader2 v-if="savingProfile" class="h-4 w-4 animate-spin" />
            保存资料
          </Button>
        </div>
      </div>

      <!-- 密码 -->
      <div class="rounded-lg border bg-card p-6">
        <div class="flex items-center gap-2">
          <KeyRound class="h-4 w-4 text-primary" />
          <h2 class="font-semibold">修改密码</h2>
        </div>
        <div class="mt-5 space-y-4">
          <div class="space-y-1.5">
            <Label>当前密码</Label>
            <Input v-model="passwordForm.oldPassword" type="password" placeholder="当前密码" />
          </div>
          <div class="space-y-1.5">
            <Label>新密码</Label>
            <Input v-model="passwordForm.newPassword" type="password" placeholder="至少 6 位" />
          </div>
          <div class="space-y-1.5">
            <Label>确认新密码</Label>
            <Input v-model="passwordForm.confirm" type="password" placeholder="再次输入新密码" />
          </div>
          <Button :disabled="savingPassword" @click="savePassword">
            <Loader2 v-if="savingPassword" class="h-4 w-4 animate-spin" />
            修改密码
          </Button>
        </div>
      </div>
    </div>

    <!-- 更换邮箱 -->
    <div class="mt-6 rounded-lg border bg-card p-6">
      <div class="flex items-center gap-2">
        <Mail class="h-4 w-4 text-primary" />
        <h2 class="font-semibold">更换邮箱</h2>
        <p class="text-xs text-muted-foreground">验证新邮箱后，登录账号将切换为新邮箱</p>
      </div>
      <div class="mt-5 max-w-xl space-y-4">
        <div class="space-y-1.5">
          <Label>新邮箱</Label>
          <Input v-model="bindForm.email" type="email" placeholder="new@example.com" />
        </div>
        <div class="space-y-1.5">
          <Label>新邮箱验证码</Label>
          <div class="flex gap-2">
            <Input
              v-model="bindForm.code"
              type="text"
              inputmode="numeric"
              maxlength="6"
              placeholder="6 位数字"
              class="flex-1"
            />
            <Button
              type="button"
              variant="outline"
              class="shrink-0"
              :disabled="!canSendBind || sendingCode"
              @click="handleSendBindCode"
            >
              <Loader2 v-if="sendingCode" class="h-4 w-4 animate-spin" />
              {{ countdown > 0 ? `${countdown}s 后重发` : '发送验证码' }}
            </Button>
          </div>
          <p v-if="bindHint" class="text-xs text-green-600">{{ bindHint }}</p>
        </div>
        <p v-if="bindError" class="text-sm text-destructive">{{ bindError }}</p>
        <Button :disabled="binding" @click="handleBindEmail">
          <Loader2 v-if="binding" class="h-4 w-4 animate-spin" />
          确认更换
        </Button>
      </div>
    </div>
  </div>
</template>
