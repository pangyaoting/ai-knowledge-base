<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { Loader2, X, ChevronDown, Check } from 'lucide-vue-next';
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
 * - 模型名下拉点开即自动加载该接口的模型列表（编辑打开表单就预加载），无需手动点按钮。
 */
const props = defineProps<{ editing?: ModelConfig | null }>();
const emit = defineEmits<{ saved: []; cancel: [] }>();

const savingConfig = ref(false);
const configError = ref('');
const loadingModels = ref(false);
const modelOptions = ref<string[]>([]);
const modelFetchError = ref('');
const manualModel = ref(false);
const modelPickerOpen = ref(false);

const configForm = reactive({
  name: props.editing?.name ?? '',
  baseURL: props.editing?.baseURL ?? 'https://api.deepseek.com',
  apiKey: '', // 编辑时留空 = 保留原 Key
  model: props.editing?.model ?? '',
});

// 编辑时：当前模型名直接显示（不依赖探测），一眼看到在改谁
if (props.editing) {
  modelOptions.value = [props.editing.model];
}

/** 是否可探测模型列表：新建需 baseURL+key；编辑直接用已存 key */
const canFetchModels = computed(() => {
  if (props.editing) return true;
  return !!configForm.baseURL.trim() && !!configForm.apiKey.trim();
});

// 编辑时自动预加载该接口的模型列表：点开下拉立即可选，不用手动点按钮
onMounted(() => {
  if (props.editing) fetchModels();
});

/** 打开/收起模型下拉；点开且还没加载 → 自动探测 */
function toggleModelPicker() {
  modelPickerOpen.value = !modelPickerOpen.value;
  if (modelPickerOpen.value && modelOptions.value.length === 0 && canFetchModels.value) {
    fetchModels();
  }
}

function pickModel(m: string) {
  configForm.model = m;
  modelPickerOpen.value = false;
}

async function fetchModels() {
  modelFetchError.value = '';
  loadingModels.value = true;
  try {
    const res = await listRemoteModels(
      props.editing
        ? { configId: props.editing.id }
        : { baseURL: configForm.baseURL.trim(), apiKey: configForm.apiKey.trim() },
    );
    // 探测结果与当前值合并：编辑时当前模型不在探测列表里也保留（不悄悄改掉用户选的模型）
    const fetched = res.models;
    const merged =
      fetched.includes(configForm.model) || !configForm.model
        ? fetched
        : [configForm.model, ...fetched];
    modelOptions.value = merged;
    if (merged.length === 0) {
      modelFetchError.value = '该接口没有返回可用模型，可切换「手动输入」';
      return;
    }
    // 新建且未选模型 → 默认选第一个
    if (!configForm.model) {
      configForm.model = merged[0];
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
        ...(configForm.apiKey.trim() ? { apiKey: configForm.apiKey.trim() } : {}),
      });
      toast.success('配置已更新');
    } else {
      await createModelConfig({
        name: configForm.name.trim(),
        baseURL: configForm.baseURL.trim(),
        apiKey: configForm.apiKey.trim(),
        model: configForm.model.trim(),
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
        <Label>模型名</Label>
        <!-- 下拉选择：点开自动加载该接口的模型列表 -->
        <div v-if="!manualModel" class="relative">
          <button
            type="button"
            class="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            @click="toggleModelPicker"
          >
            <span class="min-w-0 truncate text-left">
              {{ configForm.model || (loadingModels ? '加载模型列表…' : '点击选择模型') }}
            </span>
            <ChevronDown
              class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform"
              :class="modelPickerOpen ? 'rotate-180' : ''"
            />
          </button>
          <div
            v-if="modelPickerOpen"
            class="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border bg-card py-1 shadow-lg"
          >
            <p v-if="loadingModels" class="px-3 py-2 text-xs text-muted-foreground">
              正在加载模型列表…
            </p>
            <template v-else>
              <p
                v-if="!canFetchModels && !modelOptions.length"
                class="px-3 py-2 text-xs text-muted-foreground"
              >
                请先填写接口地址和 API Key
              </p>
              <button
                v-for="m in modelOptions"
                :key="m"
                type="button"
                class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                :class="m === configForm.model ? 'text-primary' : ''"
                @click="pickModel(m)"
              >
                <span class="min-w-0 truncate">{{ m }}</span>
                <Check v-if="m === configForm.model" class="h-3 w-3 shrink-0" />
              </button>
              <p
                v-if="modelFetchError && !modelOptions.length"
                class="px-3 py-2 text-xs text-destructive"
              >
                {{ modelFetchError }}
              </p>
              <button
                type="button"
                class="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent"
                @click="
                  manualModel = true;
                  modelPickerOpen = false;
                "
              >
                手动输入模型名…
              </button>
              <button
                type="button"
                class="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-primary transition-colors hover:bg-accent"
                :disabled="loadingModels"
                @click="fetchModels"
              >
                ↻ 刷新模型列表
              </button>
            </template>
          </div>
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
