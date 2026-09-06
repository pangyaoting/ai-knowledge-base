<script setup lang="ts">
/**
 * 全局确认/输入对话框宿主（P1-6/P2-2）：App.vue 挂载一次，
 * 组件内用 confirmDialog() / promptDialog() 弹出，替换原生 window.confirm / window.prompt
 * （浏览器样式不一致且挡 UI）。
 */
import { ref, watch, onBeforeUnmount, nextTick } from 'vue';
import { AlertTriangle, Loader2 } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import { useConfirmDialogState, resolveConfirm, resolvePrompt } from '@/composables/useConfirm';

const state = useConfirmDialogState();

const confirmLoading = ref(false);
const cancelLoading = ref(false);
const inputRef = ref<InstanceType<typeof Input> | null>(null);

function onKeydown(e: KeyboardEvent) {
  if (!state.open) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (state.inputMode) resolvePrompt(null);
    else resolveConfirm(false);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    void doConfirm();
  }
}

watch(
  () => state.open,
  async (open) => {
    if (open) {
      document.addEventListener('keydown', onKeydown);
      confirmLoading.value = false;
      cancelLoading.value = false;
      // 输入模式：打开后聚焦输入框并全选预填值（重命名场景直接打字覆盖）
      if (state.inputMode) {
        await nextTick();
        (inputRef.value?.$el as HTMLInputElement | undefined)?.focus();
        (inputRef.value?.$el as HTMLInputElement | undefined)?.select();
      }
    } else {
      document.removeEventListener('keydown', onKeydown);
    }
  },
);

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));

/** 确认按钮的异步等待：部分调用方在确认后仍要 await 网络请求，期间禁用并转圈防连点 */
async function doConfirm() {
  if (confirmLoading.value || cancelLoading.value) return;
  confirmLoading.value = true;
  // 让渲染帧先出（按钮态更新），随后调用方继续执行后续 await
  await new Promise((r) => setTimeout(r, 30));
  if (state.inputMode) {
    const v = state.inputText.trim();
    resolvePrompt(v === '' ? null : v); // 空输入等同取消（避免空名提交）
  } else {
    resolveConfirm(true);
  }
  confirmLoading.value = false;
}

function doCancel() {
  if (confirmLoading.value || cancelLoading.value) return;
  cancelLoading.value = true;
  if (state.inputMode) resolvePrompt(null);
  else resolveConfirm(false);
  cancelLoading.value = false;
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="state.open"
        class="fixed inset-0 z-[120] flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        :aria-label="state.inputMode ? '输入' : '确认操作'"
      >
        <!-- 遮罩：点击空白取消 -->
        <div class="absolute inset-0 bg-black/50" @click="doCancel" />

        <!-- 对话框 -->
        <div class="relative w-full max-w-md rounded-xl border bg-card p-5 shadow-2xl" @click.stop>
          <div class="flex items-start gap-3">
            <div
              class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
              :class="
                state.inputMode
                  ? 'bg-primary/10 text-primary'
                  : state.options.danger
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-primary/10 text-primary'
              "
            >
              <AlertTriangle class="h-5 w-5" />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-base font-semibold">{{ state.options.title }}</h3>
              <p
                v-if="state.options.message"
                class="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground"
              >
                {{ state.options.message }}
              </p>
              <!-- 输入模式（P2-2：替换 window.prompt） -->
              <Input
                v-if="state.inputMode"
                ref="inputRef"
                v-model="state.inputText"
                class="mt-3"
                :placeholder="state.inputPlaceholder || '请输入'"
                @keydown.enter.exact.prevent="doConfirm"
              />
            </div>
          </div>

          <div class="mt-5 flex justify-end gap-2">
            <Button variant="ghost" :disabled="confirmLoading || cancelLoading" @click="doCancel">
              <Loader2 v-if="cancelLoading" class="h-4 w-4 animate-spin" />
              {{ state.options.cancelText }}
            </Button>
            <Button
              :variant="!state.inputMode && state.options.danger ? 'destructive' : 'default'"
              :disabled="confirmLoading || cancelLoading"
              @click="doConfirm"
            >
              <Loader2 v-if="confirmLoading" class="h-4 w-4 animate-spin" />
              {{ state.options.confirmText }}
            </Button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
