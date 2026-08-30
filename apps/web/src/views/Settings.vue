<script setup lang="ts">
import { ref, reactive, computed, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { updateProfile, changePassword, uploadAvatar } from '@/api/user';
import { sendCode, bindEmail, forgotPassword, deleteAccount } from '@/api/auth';
import { Loader2, UserRound, KeyRound, Mail, Trash2 } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
import { toast } from '@/composables/useToast';

const auth = useAuthStore();
const router = useRouter();

// ===== 资料 =====
const profileForm = reactive({ nickname: auth.user?.nickname ?? '' });
const savingProfile = ref(false);

// ===== 头像 =====
const avatarInput = ref<HTMLInputElement | null>(null);
const avatarUploading = ref(false);

/** 压缩并居中裁剪成 200x200 方形 JPEG */
function compressAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const size = 200;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('图片处理失败'));
        return;
      }
      const side = Math.min(img.width, img.height);
      ctx.drawImage(
        img,
        (img.width - side) / 2,
        (img.height - side) / 2,
        side,
        side,
        0,
        0,
        size,
        size,
      );
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    img.src = url;
  });
}

async function onAvatarChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  avatarUploading.value = true;
  try {
    const dataUrl = await compressAvatar(file);
    await uploadAvatar(dataUrl);
    toast.success('头像已更新');
    await auth.fetchProfile();
  } catch (err) {
    toast.error((err as Error).message);
  } finally {
    avatarUploading.value = false;
    input.value = '';
  }
}

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

// ===== 忘记原密码：邮箱验证码重设（与原密码修改同一入口） =====
const showForgotPwd = ref(false);
const forgotForm = reactive({ code: '', newPassword: '', confirm: '' });
const forgotSending = ref(false);
const forgotCountdown = ref(0);
const forgotResetting = ref(false);
const forgotHint = ref('');
const forgotError = ref('');
const forgotMsg = ref('');

let forgotTimer: ReturnType<typeof setInterval> | null = null;
onUnmounted(() => {
  if (forgotTimer) clearInterval(forgotTimer);
});

const canSendForgot = computed(() => forgotCountdown.value <= 0 && !!auth.user?.email);

async function handleSendForgotCode() {
  forgotError.value = '';
  forgotMsg.value = '';
  const email = auth.user?.email;
  if (!email) {
    forgotError.value = '未获取到当前登录邮箱，请重新登录';
    return;
  }
  forgotSending.value = true;
  try {
    const res = await sendCode(email, 'forgot');
    forgotCountdown.value = 60;
    if (forgotTimer) clearInterval(forgotTimer);
    forgotTimer = setInterval(() => {
      forgotCountdown.value -= 1;
      if (forgotCountdown.value <= 0 && forgotTimer) {
        clearInterval(forgotTimer);
        forgotTimer = null;
      }
    }, 1000);
    if (res.devMode && res.code) {
      forgotForm.code = res.code;
      forgotHint.value = '（开发模式）验证码已自动填入：' + res.code;
    } else {
      forgotHint.value = '';
    }
  } catch (e) {
    forgotError.value = (e as Error).message;
  } finally {
    forgotSending.value = false;
  }
}

async function handleForgotReset() {
  forgotError.value = '';
  forgotMsg.value = '';
  const email = auth.user?.email;
  if (!email) return;
  if (!forgotForm.code.trim() || forgotForm.code.trim().length !== 6) {
    forgotError.value = '请输入 6 位邮箱验证码';
    return;
  }
  if (forgotForm.newPassword.length < 6) {
    forgotError.value = '新密码至少 6 位';
    return;
  }
  if (forgotForm.newPassword !== forgotForm.confirm) {
    forgotError.value = '两次输入的新密码不一致';
    return;
  }
  forgotResetting.value = true;
  try {
    await forgotPassword({
      email,
      code: forgotForm.code.trim(),
      newPassword: forgotForm.newPassword,
    });
    forgotMsg.value = '密码已通过邮箱验证重置，下次登录请使用新密码';
    forgotForm.code = '';
    forgotForm.newPassword = '';
    forgotForm.confirm = '';
    forgotHint.value = '';
    showForgotPwd.value = false;
    toast.success('密码已重置，下次登录请使用新密码');
  } catch (e) {
    forgotError.value = (e as Error).message;
  } finally {
    forgotResetting.value = false;
  }
}

// ===== 注销账号 =====
const deleteForm = reactive({ password: '' });
const deleting = ref(false);

async function handleDeleteAccount() {
  if (!deleteForm.password) {
    toast.error('请输入当前密码确认注销');
    return;
  }
  // eslint-disable-next-line no-alert
  if (
    !window.confirm(
      '确定要注销账号吗？账号及全部数据（知识库、文档、对话、研究报告、自主研究任务、模型配置）将被永久删除，且不可恢复。',
    )
  ) {
    return;
  }
  deleting.value = true;
  try {
    await deleteAccount(deleteForm.password);
    auth.clearAuth();
    toast.success('账号已注销，感谢使用');
    router.push('/login');
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    deleting.value = false;
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
          <!-- 头像：默认显示邮箱首字母，可上传自定义头像 -->
          <div class="flex items-center gap-4">
            <div
              class="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-2xl font-bold text-primary"
            >
              <img
                v-if="auth.user?.avatar"
                :src="auth.user.avatar"
                class="h-full w-full object-cover"
                alt="头像"
              />
              <span v-else>{{ (auth.user?.email || '?')[0].toUpperCase() }}</span>
            </div>
            <div class="space-y-1">
              <Button
                variant="outline"
                size="sm"
                :disabled="avatarUploading"
                @click="avatarInput?.click()"
              >
                <Loader2 v-if="avatarUploading" class="h-4 w-4 animate-spin" />
                {{ auth.user?.avatar ? '更换头像' : '上传头像' }}
              </Button>
              <p class="text-[11px] text-muted-foreground">
                支持 png / jpeg，建议方形图片；不设置则显示邮箱首字母
              </p>
              <input
                ref="avatarInput"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                class="hidden"
                @change="onAvatarChange"
              />
            </div>
          </div>
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

          <!-- 忘记原密码：邮箱验证码重设 -->
          <div class="border-t pt-4">
            <button
              class="text-xs text-muted-foreground transition-colors hover:text-primary hover:underline"
              @click="showForgotPwd = !showForgotPwd"
            >
              {{ showForgotPwd ? '收起「忘记原密码」' : '忘记原密码？用邮箱验证码重设' }}
            </button>
            <div v-if="showForgotPwd" class="mt-3 space-y-3">
              <div class="space-y-1.5">
                <Label>注册邮箱</Label>
                <Input :model-value="auth.user?.email ?? ''" disabled />
              </div>
              <div class="space-y-1.5">
                <Label>邮箱验证码</Label>
                <div class="flex gap-2">
                  <Input
                    v-model="forgotForm.code"
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
                    :disabled="!canSendForgot || forgotSending"
                    @click="handleSendForgotCode"
                  >
                    <Loader2 v-if="forgotSending" class="h-4 w-4 animate-spin" />
                    {{ forgotCountdown > 0 ? `${forgotCountdown}s 后重发` : '发送验证码' }}
                  </Button>
                </div>
                <p v-if="forgotHint" class="text-xs text-green-600 dark:text-green-400">
                  {{ forgotHint }}
                </p>
              </div>
              <div class="space-y-1.5">
                <Label>新密码</Label>
                <Input v-model="forgotForm.newPassword" type="password" placeholder="至少 6 位" />
              </div>
              <div class="space-y-1.5">
                <Label>确认新密码</Label>
                <Input v-model="forgotForm.confirm" type="password" placeholder="再次输入新密码" />
              </div>
              <p v-if="forgotMsg" class="text-sm text-green-600 dark:text-green-400">
                {{ forgotMsg }}
              </p>
              <p v-if="forgotError" class="text-sm text-destructive">{{ forgotError }}</p>
              <Button :disabled="forgotResetting" @click="handleForgotReset">
                <Loader2 v-if="forgotResetting" class="h-4 w-4 animate-spin" />
                通过邮箱验证重置密码
              </Button>
            </div>
          </div>
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
          <p v-if="bindHint" class="text-xs text-green-600 dark:text-green-400">{{ bindHint }}</p>
        </div>
        <p v-if="bindError" class="text-sm text-destructive">{{ bindError }}</p>
        <Button :disabled="binding" @click="handleBindEmail">
          <Loader2 v-if="binding" class="h-4 w-4 animate-spin" />
          确认更换
        </Button>
      </div>
    </div>

    <!-- 注销账号（危险操作） -->
    <div class="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 p-6">
      <div class="flex items-center gap-2">
        <Trash2 class="h-4 w-4 text-destructive" />
        <h2 class="font-semibold text-destructive">注销账号</h2>
      </div>
      <p class="mt-2 text-sm text-muted-foreground">
        注销后账号及全部数据（知识库、文档、对话、研究报告、自主研究任务、模型配置）将被永久删除，不可恢复。请谨慎操作。
      </p>
      <div class="mt-4 flex max-w-xl items-end gap-3">
        <div class="flex-1 space-y-1.5">
          <Label>当前密码</Label>
          <Input
            v-model="deleteForm.password"
            type="password"
            placeholder="输入当前密码确认注销"
            autocomplete="off"
          />
        </div>
        <Button variant="destructive" :disabled="deleting" @click="handleDeleteAccount">
          <Loader2 v-if="deleting" class="h-4 w-4 animate-spin" />
          注销账号
        </Button>
      </div>
    </div>
  </div>
</template>
