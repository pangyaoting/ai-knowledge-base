<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Loader2, Cpu, Plus, Trash2, Star, Pencil, FlaskConical, Info } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import ModelConfigForm from '@/components/ModelConfigForm.vue';
import { toast } from '@/composables/useToast';
import {
  getModelConfigs,
  deleteModelConfig,
  updateModelConfig,
  testModelConfig,
} from '@/api/model-configs';
import type { ModelConfig } from '@/types/model-config';

const configs = ref<ModelConfig[]>([]);
const loadingConfigs = ref(false);
/** 新建表单是否展开（列表上方）；编辑表单在对应行的下方展开 */
const formOpen = ref(false);
/** 正在编辑的配置 id（null = 新建模式） */
const editingId = ref<string | null>(null);
const testingId = ref<string | null>(null);
const testResults = ref<Record<string, string>>({});

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
  formOpen.value = true;
}

function openEdit(c: ModelConfig) {
  formOpen.value = false;
  editingId.value = c.id;
}

/** 表单保存成功：收起表单并刷新列表 */
async function onFormSaved() {
  formOpen.value = false;
  editingId.value = null;
  await loadConfigs();
}

async function handleDelete(id: string, name: string) {
  // eslint-disable-next-line no-alert
  if (!window.confirm(`删除模型配置「${name}」？`)) return;
  try {
    await deleteModelConfig(id);
    if (editingId.value === id) editingId.value = null;
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

      <!-- 新建表单：列表上方展开 -->
      <div v-if="formOpen && !editingId" class="mt-4">
        <ModelConfigForm @saved="onFormSaved" @cancel="formOpen = false" />
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
          <!-- 编辑表单：在所在行的下方就地展开 -->
          <div v-if="editingId === c.id" class="mt-1 w-full">
            <ModelConfigForm :editing="c" @saved="onFormSaved" @cancel="editingId = null" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
