<script setup lang="ts">
defineOptions({ name: 'ChatMessageInput' });

import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { Send, Square, X, ImagePlus, FileText, Cpu, Database } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import type { ModelConfig } from '@/types/model-config';

const props = defineProps<{
  modelConfigs: ModelConfig[];
  currentModelName: string;
  currentReasoning: string | null;
  sessionModelConfigId: string | null;
  streaming: boolean;
  canSend: boolean;
  currentSessionId: string | null;
  useWebSearch: boolean;
  inputHint: string;
  scopeLabel: string;
  scopeTitle: string;
  pendingImages: string[];
  pendingFiles: Array<{ name: string; content: string }>;
}>();

const emit = defineEmits<{
  (e: 'update:input', v: string): void;
  (e: 'update:useWebSearch', v: boolean): void;
  (e: 'send'): void;
  (e: 'stop'): void;
  (e: 'open-edit-scope'): void;
  (e: 'select-model', id: string): void;
  (e: 'set-reasoning', effort: string): void;
  (e: 'remove-image', i: number): void;
  (e: 'remove-file', i: number): void;
  (e: 'preview-file', f: { name: string; content: string }): void;
  (e: 'pick-image', files: File[]): void;
  (e: 'pick-file', files: File[]): void;
  (e: 'paste', ev: ClipboardEvent): void;
}>();

const input = defineModel<string>('input', { default: '' });

// ===== 模型下拉（fixed 定位，视口内自适应） =====
const modelDropdownOpen = ref(false);
const modelBtnRef = ref<HTMLElement | null>(null);
const modelDropdownRef = ref<HTMLElement | null>(null);
const modelDropdownPos = ref({ top: 0, left: 0 });

function toggleModelDropdown() {
  if (modelDropdownOpen.value) {
    modelDropdownOpen.value = false;
    return;
  }
  const el = modelBtnRef.value;
  if (el) {
    const r = el.getBoundingClientRect();
    const itemH = 38;
    const h = Math.min(400, props.modelConfigs.length * itemH + 190);
    const top = r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - 248);
    modelDropdownPos.value = { top, left };
  }
  modelDropdownOpen.value = true;
}

function onDocPointerDown(e: MouseEvent) {
  if (!modelDropdownOpen.value) return;
  const t = e.target as Node;
  if (!modelBtnRef.value?.contains(t) && !modelDropdownRef.value?.contains(t)) {
    modelDropdownOpen.value = false;
  }
}

onMounted(() => document.addEventListener('mousedown', onDocPointerDown));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocPointerDown));

// ===== 推理等级 =====
const REASONING_OPTIONS: Array<{ value: string; label: string; desc: string }> = [
  { value: 'low', label: '关闭', desc: '最低推理 · 最快最省' },
  { value: 'high', label: '高', desc: '深度思考 · 更准确' },
  { value: 'max', label: '最高', desc: '最强推理 · 最贵最慢' },
];

const isSendVisible = computed(() => !props.streaming);

// ===== 暴露聚焦方法（父组件分支后预填问题并聚焦） =====
const messageTextarea = ref<HTMLTextAreaElement | null>(null);
const imageInput = ref<HTMLInputElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
function focusTextarea() {
  messageTextarea.value?.focus();
}
defineExpose({ focusTextarea });
</script>

<template>
  <div class="border-t bg-card/50 p-4">
    <!-- 问答范围（常驻可见，点击可修改当前会话） + 模型选择 -->
    <div
      v-if="props.currentSessionId"
      class="mx-auto mb-2 flex max-w-5xl items-center gap-2 text-[11px]"
    >
      <span class="shrink-0 text-muted-foreground">问答范围</span>
      <button
        class="inline-flex max-w-[65%] items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs text-foreground transition-colors hover:bg-muted"
        :title="props.scopeTitle"
        @click="emit('open-edit-scope')"
      >
        <Database class="h-3 w-3 shrink-0 text-muted-foreground" />
        <span class="truncate">{{ props.scopeLabel }}</span>
        <span class="shrink-0 text-muted-foreground">修改</span>
      </button>

      <span class="shrink-0 text-muted-foreground">模型</span>
      <div class="relative">
        <button
          ref="modelBtnRef"
          class="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs text-foreground transition-colors hover:bg-muted"
          :class="
            props.modelConfigs.length === 0
              ? 'border-destructive/40 bg-destructive/5 text-destructive'
              : 'border bg-muted/40'
          "
          :title="'当前模型：' + props.currentModelName + '（点击切换，Token 按所选模型计费）'"
          @click="toggleModelDropdown"
        >
          <Cpu class="h-3 w-3 shrink-0 text-muted-foreground" />
          <span class="max-w-[140px] truncate">{{ props.currentModelName }}</span>
        </button>
        <!-- 下拉面板：fixed 定位，视口内自适应（底部空间不足时向上弹） -->
        <div
          v-if="modelDropdownOpen"
          ref="modelDropdownRef"
          class="fixed z-50 max-h-[70vh] w-60 overflow-y-auto rounded-lg border bg-card py-1 shadow-lg"
          :style="{ top: modelDropdownPos.top + 'px', left: modelDropdownPos.left + 'px' }"
          @click.stop
        >
          <p v-if="props.modelConfigs.length === 0" class="px-3 py-2 text-xs text-muted-foreground">
            还没有绑定任何模型 Key，AI 功能无法使用。
          </p>
          <RouterLink
            v-if="props.modelConfigs.length === 0"
            to="/model-configs"
            class="flex items-center gap-1 px-3 py-2 text-xs font-medium text-primary hover:underline"
            @click="modelDropdownOpen = false"
          >
            去「模型配置」绑定自己的 API Key →
          </RouterLink>
          <template v-else>
            <p class="px-3 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">选择模型</p>
            <button
              v-for="c in props.modelConfigs"
              :key="c.id"
              class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
              :class="props.sessionModelConfigId === c.id ? 'text-primary' : ''"
              @click="emit('select-model', c.id)"
            >
              <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
              <span class="shrink-0 text-xs text-muted-foreground">{{ c.model }}</span>
              <span v-if="props.sessionModelConfigId === c.id" class="shrink-0 text-xs">✓</span>
            </button>
            <p class="border-t px-3 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">
              推理等级（思考越多越准也越贵）
            </p>
            <p class="px-3 pb-1 text-[10px] text-muted-foreground/70">
              不设置 = 模型默认（V4 默认会简单思考）；部分模型不支持该参数，报错时请选「关闭」
            </p>
            <button
              v-for="e in REASONING_OPTIONS"
              :key="e.value"
              class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
              :class="props.currentReasoning === e.value ? 'text-primary' : ''"
              @click="emit('set-reasoning', e.value)"
            >
              <span>{{ e.label }}</span>
              <span class="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
                {{ e.desc }}
              </span>
              <span v-if="props.currentReasoning === e.value" class="shrink-0 text-xs">✓</span>
            </button>
          </template>
        </div>
      </div>
    </div>

    <!-- 待发送图片/文件预览：在输入框上方横排展示（有图片或文件时显示） -->
    <div
      v-if="props.pendingImages.length || props.pendingFiles.length"
      class="mx-auto mb-2 flex max-w-5xl items-center gap-2 overflow-x-auto pb-1"
    >
      <div v-for="(img, i) in props.pendingImages" :key="i" class="relative shrink-0">
        <img
          :src="img"
          class="h-20 w-20 rounded-md border border-primary/40 object-cover"
          alt="待发送图片"
        />
        <button
          class="absolute right-1 top-1 rounded-full bg-destructive/90 p-0.5 text-white shadow"
          title="移除这张图片"
          @click="emit('remove-image', i)"
        >
          <X class="h-3 w-3" />
        </button>
      </div>
      <p class="flex items-center text-[11px] text-muted-foreground">
        {{ props.pendingImages.length }}/9
      </p>
      <div
        v-for="(f, i) in props.pendingFiles"
        :key="'file-' + i"
        class="group relative flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs transition-colors hover:bg-accent"
        title="点击在右侧查看文件内容"
        @click="emit('preview-file', f)"
      >
        <FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span class="max-w-[140px] truncate">{{ f.name }}</span>
        <button
          class="rounded p-0.5 text-muted-foreground opacity-60 transition-colors hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          title="移除这个文件"
          @click.stop="emit('remove-file', i)"
        >
          <X class="h-3 w-3" />
        </button>
      </div>
    </div>

    <div class="mx-auto flex max-w-5xl items-end gap-2">
      <!-- 上传本地图片（可多选） -->
      <button
        type="button"
        class="shrink-0 rounded-md border p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="上传图片（支持多选，视觉模型可识别）"
        @click="imageInput?.click()"
      >
        <ImagePlus class="h-4 w-4" />
      </button>
      <input
        ref="imageInput"
        type="file"
        accept="image/*"
        multiple
        class="hidden"
        @change="
          (e) => {
            const el = e.target as HTMLInputElement;
            if (el.files?.length) emit('pick-image', Array.from(el.files));
            el.value = '';
          }
        "
      />
      <!-- 上传文件（文本/代码/PDF/Word，提取内容随消息发送） -->
      <button
        type="button"
        class="shrink-0 rounded-md border p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="上传文件（txt/md/代码/PDF/Word，内容随问题一起发给模型）"
        @click="fileInput?.click()"
      >
        <FileText class="h-4 w-4" />
      </button>
      <input
        ref="fileInput"
        type="file"
        accept=".txt,.md,.markdown,.json,.csv,.py,.js,.jsx,.ts,.tsx,.vue,.java,.go,.c,.cpp,.h,.hpp,.rs,.php,.rb,.sh,.yml,.yaml,.xml,.html,.css,.pdf,.doc,.docx"
        multiple
        class="hidden"
        @change="
          (e) => {
            const el = e.target as HTMLInputElement;
            if (el.files?.length) emit('pick-file', Array.from(el.files));
            el.value = '';
          }
        "
      />
      <textarea
        ref="messageTextarea"
        v-model="input"
        rows="1"
        class="max-h-40 min-h-[44px] flex-1 resize-y rounded-md border border-input bg-background px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        placeholder="输入问题，Enter 发送，Shift+Enter 换行；可粘贴图片（需视觉模型识别）"
        :disabled="!props.currentSessionId"
        @keydown.enter.exact.prevent="emit('send')"
        @paste="emit('paste', $event)"
      />
      <Button v-if="isSendVisible" :disabled="!props.canSend" @click="emit('send')">
        <Send class="h-4 w-4" />
        发送
      </Button>
      <Button v-else variant="destructive" @click="emit('stop')">
        <Square class="h-4 w-4" />
        停止
      </Button>
    </div>
    <p
      class="mx-auto mt-2 flex max-w-5xl items-center justify-center gap-4 text-[11px] text-muted-foreground"
    >
      <label class="flex cursor-pointer items-center gap-1.5 select-none">
        <input
          :checked="props.useWebSearch"
          type="checkbox"
          class="h-3.5 w-3.5 rounded border-input"
          :disabled="props.streaming"
          @change="emit('update:useWebSearch', ($event.target as HTMLInputElement).checked)"
        />
        <span :class="{ 'text-primary': props.useWebSearch }">🌐 联网检索</span>
      </label>
      <span>{{ props.inputHint }}</span>
    </p>
  </div>
</template>
