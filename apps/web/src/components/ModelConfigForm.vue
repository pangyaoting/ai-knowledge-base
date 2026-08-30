<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { Loader2, X } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
import { toast } from '@/composables/useToast';
import { createModelConfig, updateModelConfig, listRemoteModels } from '@/api/model-configs';
import type { ModelConfig } from '@/types/model-config';

/**
 * 模型配置表单（新建 / 编辑共用）：
 * - 新建：父组件在列表上方展开；编辑：在所在行下方展开。
 * - 保存成功后 emit('saved')，父组件刷新列表并收起表单。
 */
const props = defineProps<{ editing?: ModelConfig | null }>();
const emit = defineEmits<{ saved: []; cancel: [] }>();

const savingConfig = ref(false);
const configError = ref('');
const loadingModels = ref(false);
const modelOptions = ref<string[]>([]);
const modelFetchError = ref('');
const manualModel = ref(false);

const configForm = reactive({
  name: props.editing?.name ?? '',
  baseURL: props.editing?.baseURL ?? 'https://api.deepseek.com',
  apiKey: '', // 编辑时留空 = 保留原 Key
  model: props.editing?.model ?? '',
  isDefault: props.editing?.isDefault ?? false,
});

/** 获取模型列表按钮是否可用：新建需 baseURL+key；编辑直接用已存 key */
const canFetchModels = computed(() => {
  if (props.editing) return true;
  return !!configForm.baseURL.trim() && !!configForm.apiKey.trim();
});

async function fetchModels() {
  modelFetchError.value = '';
  loadingModels.value = true;
  try {
    const res = await listRemoteModels(
      props.editing
        ? { configId: props.editing.id }
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

async function saveConfig() {
  if (!configForm.name.trim() || !configForm.model.trim()) {
    configError.value = '请填写名称和模型名';
    return;
  }
  if (!props.editing && !configForm.apiKey.trim()) {
    configError.value = '请填写 API Key';
    return;
  }
  savingConfig.value = true;
  configError.value = '';
  try {
    if (props.editing) {
      await updateModelConfig(props.editing.id, {
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
    emit('saved');
  } catch (e) {
    configError.value = (e as Error).message;
  } finally {
    savingConfig.value = false;
  }
}
</script>

<template>
  <div class="rounded-lg border border-primary/30 bg-muted/30 p-4">
    <div class="flex items-center justify-between">
      <p class="text-sm font-medium">
        {{ editing ? `编辑配置：${editing.name}（${editing.model}）` : '新增配置' }}
      </p>
      <button class="rounded p-1 text-muted-foreground hover:bg-accent" @click="emit('cancel')">
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
            :title="editing ? '用已存 Key 探测该接口的模型列表' : '需先填好接口地址和 API Key'"
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
        <Label>API Key（{{ editing ? '留空则保留原 Key' : '加密存储，不返回明文' }}）</Label>
        <Input v-model="configForm.apiKey" type="password" placeholder="sk-..." />
      </div>
    </div>
    <label class="mt-3 flex cursor-pointer items-center gap-2 text-sm select-none">
      <input v-model="configForm.isDefault" type="checkbox" class="h-3.5 w-3.5" />
      设为默认（新建会话 / 研究报告 / 自主研究默认使用）
    </label>
    <p v-if="configError" class="mt-3 text-sm text-destructive">{{ configError }}</p>
    <div class="mt-4 flex justify-end gap-2">
      <Button variant="ghost" size="sm" @click="emit('cancel')">取消</Button>
      <Button size="sm" :disabled="savingConfig" @click="saveConfig">
        <Loader2 v-if="savingConfig" class="h-4 w-4 animate-spin" />
        {{ editing ? '保存修改' : '保存配置' }}
      </Button>
    </div>
  </div>
</template>
