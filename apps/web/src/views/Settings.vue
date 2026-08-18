<script setup lang="ts">
import { ref, reactive } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { updateProfile, changePassword } from '@/api/user';
import { Loader2, UserRound, KeyRound } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';

const auth = useAuthStore();

// ===== 资料 =====
const profileForm = reactive({ nickname: auth.user?.nickname ?? '' });
const savingProfile = ref(false);
const profileMsg = ref('');
const profileError = ref('');

async function saveProfile() {
  savingProfile.value = true;
  profileMsg.value = '';
  profileError.value = '';
  try {
    await updateProfile({ nickname: profileForm.nickname.trim() });
    profileMsg.value = '资料已更新';
    auth.fetchProfile().catch(() => undefined);
  } catch (e) {
    profileError.value = (e as Error).message;
  } finally {
    savingProfile.value = false;
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
    pwdMsg.value = '密码已修改，下次登录请使用新密码';
    passwordForm.oldPassword = '';
    passwordForm.newPassword = '';
    passwordForm.confirm = '';
  } catch (e) {
    pwdError.value = (e as Error).message;
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

    <div class="grid gap-6 lg:grid-cols-2">
      <!-- 资料 -->
      <div class="rounded-lg border bg-card p-6">
        <div class="flex items-center gap-2">
          <UserRound class="h-4 w-4 text-primary" />
          <h2 class="font-semibold">基本资料</h2>
        </div>
        <div class="mt-5 space-y-4">
          <div class="space-y-1.5">
            <Label>邮箱（不可修改）</Label>
            <Input :model-value="auth.user?.email ?? ''" disabled />
          </div>
          <div class="space-y-1.5">
            <Label>昵称</Label>
            <Input v-model="profileForm.nickname" placeholder="你的昵称" />
          </div>
          <p v-if="profileMsg" class="text-sm text-green-600">{{ profileMsg }}</p>
          <p v-if="profileError" class="text-sm text-destructive">{{ profileError }}</p>
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
          <p v-if="pwdMsg" class="text-sm text-green-600">{{ pwdMsg }}</p>
          <p v-if="pwdError" class="text-sm text-destructive">{{ pwdError }}</p>
          <Button :disabled="savingPassword" @click="savePassword">
            <Loader2 v-if="savingPassword" class="h-4 w-4 animate-spin" />
            修改密码
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
