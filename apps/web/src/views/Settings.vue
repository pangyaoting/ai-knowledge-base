<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { updateProfile, changePassword } from '@/api/user';
import {
  Loader2,
  UserRound,
  KeyRound,
  Cpu,
  Plus,
  Trash2,
  Star,
  Pencil,
  FlaskConical,
  X,
} from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
import {
  getModelConfigs,
  createModelConfig,
  updateModelConfig,
  deleteModelConfig,
  testModelConfig,
} from '@/api/model-configs';
import type { ModelConfig } from '@/types/model-config';

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

// ===== 模型配置（BYO 大模型 API）=====
const configs = ref<ModelConfig[]>([]);
const loadingConfigs = ref(false);
const formOpen = ref(false);
const editingId = ref<string | null>(null);
const savingConfig = ref(false);
const testingId = ref<string | null>(null);
const configMsg = ref('');
const configError = ref('');
const testResults = ref<Record<string, string>>({});

const configForm = reactive({
  name: '',
  baseURL: 'https://api.deepseek.com',
  apiKey: '',
  model: '',
  isDefault: false,
});

async function loadConfigs() {
  loadingConfigs.value = true;
  try {
    configs.value = await getModelConfigs();
  } catch (e) {
    configError.value = (e as Error).message;
  } finally {
    loadingConfigs.value = false;
  }
}

function openCreate() {
  editingId.value = null;
  configForm.name = '';
  configForm.baseURL = 'https://api.deepseek.com';
  configForm.apiKey = '';
  configForm.model = '';
  configForm.isDefault = false;
  configMsg.value = '';
  configError.value = '';
  formOpen.value = true;
}

function openEdit(c: ModelConfig) {
  editingId.value = c.id;
  configForm.name = c.name;
  configForm.baseURL = c.baseURL;
  configForm.apiKey = ''; // 编辑时 key 可留空（保留原 key）
  configForm.model = c.model;
  configForm.isDefault = c.isDefault;
  configMsg.value = '';
  configError.value = '';
  formOpen.value = true;
}

async function saveConfig() {
  if (!configForm.name.trim() || !configForm.model.trim()) {
    configError.value = '请填写名称和模型名';
    return;
  }
  if (!editingId.value && !configForm.apiKey.trim()) {
    configError.value = '请填写 API Key';
    return;
  }
  savingConfig.value = true;
  configMsg.value = '';
  configError.value = '';
  try {
    if (editingId.value) {
      await updateModelConfig(editingId.value, {
        name: configForm.name.trim(),
        baseURL: configForm.baseURL.trim(),
        model: configForm.model.trim(),
        isDefault: configForm.isDefault,
        ...(configForm.apiKey.trim() ? { apiKey: configForm.apiKey.trim() } : {}),
      });
      configMsg.value = '配置已更新';
    } else {
      await createModelConfig({
        name: configForm.name.trim(),
        baseURL: configForm.baseURL.trim(),
        apiKey: configForm.apiKey.trim(),
        model: configForm.model.trim(),
        isDefault: configForm.isDefault,
      });
      configMsg.value = '配置已保存';
    }
    formOpen.value = false;
    await loadConfigs();
  } catch (e) {
    configError.value = (e as Error).message;
  } finally {
    savingConfig.value = false;
  }
}

async function handleDelete(id: string, name: string) {
  // eslint-disable-next-line no-alert
  if (!window.confirm(`删除模型配置「${name}」？`)) return;
  try {
    await deleteModelConfig(id);
    await loadConfigs();
  } catch (e) {
    configError.value = (e as Error).message;
  }
}

async function handleSetDefault(id: string) {
  try {
    await updateModelConfig(id, { isDefault: true });
    await loadConfigs();
  } catch (e) {
    configError.value = (e as Error).message;
  }
}

async function handleTest(id: string) {
  testingId.value = id;
  testResults.value[id] = '测试中...';
  try {
    const res = await testModelConfig(id);
    testResults.value[id] = res.ok ? '✅ 连接成功' : `❌ ${res.message}`;
  } catch (e) {
    testResults.value[id] = `❌ ${(e as Error).message}`;
  } finally {
    testingId.value = null;
  }
}

onMounted(loadConfigs);
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

    <!-- 模型配置（BYO 大模型 API） -->
    <div class="mt-6 rounded-lg border bg-card p-6">
      <div class="flex flex-wrap items-center gap-2">
        <Cpu class="h-4 w-4 text-primary" />
        <h2 class="font-semibold">模型配置</h2>
        <span class="text-xs text-muted-foreground">
          绑定你自己的大模型 API Key（OpenAI 兼容协议），回答的 Token 由你的 Key 计费
        </span>
        <Button variant="outline" size="sm" class="ml-auto" @click="openCreate">
          <Plus class="h-4 w-4" />
          新增配置
        </Button>
      </div>

      <!-- 新建/编辑表单 -->
      <div v-if="formOpen" class="mt-4 rounded-lg border border-primary/30 bg-muted/30 p-4">
        <div class="flex items-center justify-between">
          <p class="text-sm font-medium">{{ editingId ? '编辑配置' : '新增配置' }}</p>
          <button
            class="rounded p-1 text-muted-foreground hover:bg-accent"
            @click="formOpen = false"
          >
            <X class="h-4 w-4" />
          </button>
        </div>
        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label>名称</Label>
            <Input v-model="configForm.name" placeholder="如：我的 DeepSeek" />
          </div>
          <div class="space-y-1.5">
            <Label>模型名</Label>
            <Input v-model="configForm.model" placeholder="如：deepseek-chat" />
          </div>
          <div class="space-y-1.5">
            <Label>接口地址（OpenAI 兼容）</Label>
            <Input v-model="configForm.baseURL" placeholder="https://api.deepseek.com" />
          </div>
          <div class="space-y-1.5">
            <Label>API Key（{{ editingId ? '留空则保留原 Key' : '加密存储，不返回明文' }}）</Label>
            <Input v-model="configForm.apiKey" type="password" placeholder="sk-..." />
          </div>
        </div>
        <label class="mt-3 flex cursor-pointer items-center gap-2 text-sm select-none">
          <input v-model="configForm.isDefault" type="checkbox" class="h-3.5 w-3.5" />
          设为默认（新建会话默认使用）
        </label>
        <p v-if="configError" class="mt-3 text-sm text-destructive">{{ configError }}</p>
        <div class="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="formOpen = false">取消</Button>
          <Button size="sm" :disabled="savingConfig" @click="saveConfig">
            <Loader2 v-if="savingConfig" class="h-4 w-4 animate-spin" />
            {{ editingId ? '保存修改' : '保存配置' }}
          </Button>
        </div>
      </div>

      <!-- 列表 -->
      <div v-if="loadingConfigs" class="flex justify-center py-8">
        <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
      <div
        v-else-if="configs.length === 0 && !formOpen"
        class="mt-4 rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground"
      >
        还没有模型配置——点「新增配置」绑定你自己的 API Key（如 DeepSeek / 硅基流动 / OpenAI
        兼容服务）
      </div>
      <div v-else-if="configs.length" class="mt-4 space-y-2">
        <div
          v-for="c in configs"
          :key="c.id"
          class="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3"
        >
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-2 text-sm font-medium">
              {{ c.name }}
              <span
                v-if="c.isDefault"
                class="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
              >
                默认
              </span>
            </p>
            <p class="mt-0.5 truncate text-xs text-muted-foreground">
              {{ c.baseURL }} · {{ c.model }} · Key: {{ c.apiKeyMasked }}
            </p>
            <p
              v-if="testResults[c.id]"
              class="mt-0.5 text-xs"
              :class="testResults[c.id]!.startsWith('✅') ? 'text-green-600' : 'text-destructive'"
            >
              {{ testResults[c.id] }}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button
              class="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="测试连接"
              @click="handleTest(c.id)"
            >
              <Loader2 v-if="testingId === c.id" class="h-4 w-4 animate-spin" />
              <FlaskConical v-else class="h-4 w-4" />
            </button>
            <button
              v-if="!c.isDefault"
              class="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="设为默认"
              @click="handleSetDefault(c.id)"
            >
              <Star class="h-4 w-4" />
            </button>
            <button
              class="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="编辑"
              @click="openEdit(c)"
            >
              <Pencil class="h-4 w-4" />
            </button>
            <button
              class="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              title="删除"
              @click="handleDelete(c.id, c.name)"
            >
              <Trash2 class="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
