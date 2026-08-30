<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { Loader2, Cpu, Plus, Trash2, Star, Pencil, FlaskConical, X, Info } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { toast } from '@/composables/useToast';
import {
  getModelConfigs,
  createModelConfig,
  updateModelConfig,
  deleteModelConfig,
  testModelConfig,
  listRemoteModels,
} from '@/api/model-configs';
import type { ModelConfig } from '@/types/model-config';

const configs = ref<ModelConfig[]>([]);
/** 正在编辑的配置（编辑框标题显示"改的是谁"） */
const editingConfig = computed(() =>
  editingId.value ? (configs.value.find((c) => c.id === editingId.value) ?? null) : null,
);
const loadingConfigs = ref(false);
const formOpen = ref(false);
const editingId = ref<string | null>(null);
const savingConfig = ref(false);
const testingId = ref<string | null>(null);
const configError = ref('');
const testResults = ref<Record<string, string>>({});

// 模型名下拉选择（探测提供商 /models）：不手写，避免打错模型名
const loadingModels = ref(false);
const modelOptions = ref<string[]>([]);
const modelFetchError = ref('');
const manualModel = ref(false); // 个别网关不开放 /models 时的手动输入兜底

const configForm = reactive({
  name: '',
  baseURL: 'https://api.deepseek.com',
  apiKey: '',
  model: '',
  isDefault: false,
});

/** 获取模型列表按钮是否可用：新建需 baseURL+key；编辑直接用已存 key */
const canFetchModels = computed(() => {
  if (editingId.value) return true;
  return !!configForm.baseURL.trim() && !!configForm.apiKey.trim();
});

async function fetchModels() {
  modelFetchError.value = '';
  loadingModels.value = true;
  try {
    const res = await listRemoteModels(
      editingId.value
        ? { configId: editingId.value }
        : { baseURL: configForm.baseURL.trim(), apiKey: configForm.apiKey.trim() },
    );
    modelOptions.value = res.models;
    if (modelOptions.value.length === 0) {
      modelFetchError.value = '该接口没有返回可用模型，可切换「手动输入」';
      return;
    }
    // 当前模型不在列表里时默认选第一个（新建）；在列表里则保持
    if (!modelOptions.value.includes(configForm.model)) {
      configForm.model = modelOptions.value[0];
    }
  } catch (e) {
    modelFetchError.value = (e as Error).message;
    toast.error((e as Error).message);
  } finally {
    loadingModels.value = false;
  }
}

async function loadConfigs() {
  loadingConfigs.value = true;
  try {
    configs.value = await getModelConfigs();
  } catch (e) {
    toast.error((e as Error).message);
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
  configError.value = '';
  modelOptions.value = [];
  modelFetchError.value = '';
  manualModel.value = false;
  formOpen.value = true;
}

function openEdit(c: ModelConfig) {
  editingId.value = c.id;
  configForm.name = c.name;
  configForm.baseURL = c.baseURL;
  configForm.apiKey = ''; // 编辑时 key 可留空（保留原 key）
  configForm.model = c.model;
  configForm.isDefault = c.isDefault;
  configError.value = '';
  modelOptions.value = [];
  modelFetchError.value = '';
  manualModel.value = false;
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
      toast.success('配置已更新');
    } else {
      await createModelConfig({
        name: configForm.name.trim(),
        baseURL: configForm.baseURL.trim(),
        apiKey: configForm.apiKey.trim(),
        model: configForm.model.trim(),
        isDefault: configForm.isDefault,
      });
      toast.success('配置已保存');
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
    toast.success(`配置「${name}」已删除`);
  } catch (e) {
    toast.error((e as Error).message);
  }
}

async function handleSetDefault(id: string) {
  try {
    await updateModelConfig(id, { isDefault: true });
    await loadConfigs();
    toast.success('已设为默认配置');
  } catch (e) {
    toast.error((e as Error).message);
  }
}

async function handleTest(id: string) {
  testingId.value = id;
  testResults.value[id] = '测试中...';
  try {
    const res = await testModelConfig(id);
    testResults.value[id] = res.ok ? '✅ 连接成功' : `❌ ${res.message}`;
    if (!res.ok) toast.error(res.message);
  } catch (e) {
    testResults.value[id] = `❌ ${(e as Error).message}`;
    toast.error((e as Error).message);
  } finally {
    testingId.value = null;
  }
}

onMounted(loadConfigs);
</script>

<template>
  <div class="container py-10">
    <div class="mb-6">
      <h1 class="flex items-center gap-2 text-2xl font-bold tracking-tight">
        <Cpu class="h-6 w-6 text-primary" />
        模型配置
      </h1>
      <p class="mt-1 text-sm text-muted-foreground">
        绑定你自己的大模型 API Key，所有 AI 功能（对话 / 研究报告 / 自主研究）都由你的 Key 计费
      </p>
    </div>

    <!-- 使用前引导（BYO 说明） -->
    <div class="mb-6 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div class="flex items-start gap-2">
        <Info class="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div class="space-y-1 text-sm">
          <p class="font-medium">开始使用前，请先在这里绑定你自己的大模型 API Key</p>
          <ul class="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            <li>
              平台不提供兜底模型：对话、研究报告、自主研究产生的所有 Token 消耗都由<b
                >你自己的 Key</b
              >
              承担，费用直接结算到你的模型服务商账户。
            </li>
            <li>
              API Key 使用 AES-256-GCM 加密存储，任何接口都不会返回明文（列表只显示
              <code class="rounded bg-muted px-1">sk-****</code>）。
            </li>
            <li>
              支持任何 OpenAI 兼容协议的模型服务（DeepSeek / 硅基流动 / OpenAI / Moonshot…）。
            </li>
            <li>
              绑定后建议点「测试连接」验证 Key 可用；把常用配置「设为默认」，新建对话会优先使用它。
            </li>
          </ul>
        </div>
      </div>
    </div>

    <div class="rounded-lg border bg-card p-6">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="font-semibold">我的模型</h2>
        <span v-if="configs.length" class="text-xs text-muted-foreground">
          {{ configs.length }} 个配置
        </span>
        <Button variant="outline" size="sm" class="ml-auto" @click="openCreate">
          <Plus class="h-4 w-4" />
          新增配置
        </Button>
      </div>

      <!-- 新建/编辑表单 -->
      <div v-if="formOpen" class="mt-4 rounded-lg border border-primary/30 bg-muted/30 p-4">
        <div class="flex items-center justify-between">
          <p class="text-sm font-medium">
            {{
              editingConfig
                ? `编辑配置：${editingConfig.name}（${editingConfig.model}）`
                : '新增配置'
            }}
          </p>
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
            <Label>模型名（从菜单里选，不用手写）</Label>
            <!-- 列表选择模式（默认） -->
            <div v-if="!manualModel" class="flex gap-2">
              <select
                v-model="configForm.model"
                class="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="" disabled>
                  {{ modelOptions.length ? '选择模型…' : '先点「获取模型列表」' }}
                </option>
                <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
              </select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                class="shrink-0"
                :disabled="!canFetchModels || loadingModels"
                :title="
                  editingId ? '用已存 Key 探测该接口的模型列表' : '需先填好接口地址和 API Key'
                "
                @click="fetchModels"
              >
                <Loader2 v-if="loadingModels" class="h-4 w-4 animate-spin" />
                {{ loadingModels ? '获取中…' : '获取模型列表' }}
              </Button>
              <button
                type="button"
                class="shrink-0 text-xs text-muted-foreground hover:text-primary hover:underline"
                @click="manualModel = true"
              >
                手动输入
              </button>
            </div>
            <!-- 手动输入兜底（个别网关不开放 /models） -->
            <div v-else class="flex gap-2">
              <Input
                v-model="configForm.model"
                placeholder="如：deepseek-chat（需与该接口支持的模型名完全一致）"
                class="flex-1"
              />
              <button
                type="button"
                class="shrink-0 text-xs text-muted-foreground hover:text-primary hover:underline"
                @click="manualModel = false"
              >
                用列表选择
              </button>
            </div>
            <p v-if="modelFetchError" class="text-xs text-destructive">{{ modelFetchError }}</p>
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
          设为默认（新建会话 / 研究报告 / 自主研究默认使用）
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
      <div v-if="loadingConfigs" class="mt-4 space-y-2">
        <div v-for="i in 3" :key="i" class="flex items-center gap-3 rounded-lg border px-4 py-3">
          <div class="min-w-0 flex-1 space-y-2">
            <Skeleton class="h-3.5 w-32" />
            <Skeleton class="h-3 w-52" />
          </div>
          <Skeleton class="h-7 w-24 shrink-0" />
        </div>
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
              :class="
                testResults[c.id]!.startsWith('✅')
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-destructive'
              "
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
