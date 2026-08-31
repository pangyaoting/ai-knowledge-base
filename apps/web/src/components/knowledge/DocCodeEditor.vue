<script setup lang="ts">
defineOptions({ name: 'DocCodeEditor' });

import { ref, computed, onMounted, type Ref } from 'vue';
import { ArrowLeft, Loader2 } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import { toast } from '@/composables/useToast';
import { getDocumentContent, updateDocument } from '@/api/knowledge';
import type { Document } from '@/types/knowledge';

const props = defineProps<{
  knowledgeBaseId: string;
  doc: Document;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved'): void;
}>();

const editFilename = ref(props.doc.filename);
const editContent = ref('');
const loadingContent = ref(false);
const savingEdit = ref(false);

const editGutter = ref<HTMLDivElement | null>(null);
const editPre = ref<HTMLPreElement | null>(null);

function lineNumbersOf(text: string): string {
  const n = text.split('\n').length;
  return Array.from({ length: n }, (_, i) => i + 1).join('\n') + '\n';
}
const editLineNumbers = computed(() => lineNumbersOf(editContent.value));
const editHighlighted = computed(() => highlightCode(editContent.value));

/** 轻量语法高亮（无依赖）：先转义 HTML，再给注释/字符串/关键字/数字包上高亮 span */
function highlightCode(code: string): string {
  const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(
    /(\/\/[^\n]*|#[^\n]*)|(\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|export|import|from|return|if|else|for|while|class|interface|type|extends|implements|new|async|await|def|true|false|null|undefined|public|private|static)\b|\b(\d+(?:\.\d+)?)\b/g,
    (m, lineComment, blockComment, str, kw, num) => {
      if (lineComment)
        return `<span class="text-slate-400 dark:text-slate-500">${lineComment}</span>`;
      if (blockComment)
        return `<span class="text-slate-400 dark:text-slate-500">${blockComment}</span>`;
      if (str) return `<span class="text-amber-600 dark:text-amber-400">${str}</span>`;
      if (kw) return `<span class="text-blue-600 dark:text-blue-400">${kw}</span>`;
      if (num) return `<span class="text-emerald-600 dark:text-emerald-400">${num}</span>`;
      return m;
    },
  );
}

/** 高亮层 + 行号栏与文本框同步滚动 */
function syncEditorScroll(gutter: Ref<HTMLDivElement | null>, pre: Ref<HTMLPreElement | null>) {
  return (e: Event) => {
    const ta = e.target as HTMLTextAreaElement;
    if (gutter.value) gutter.value.scrollTop = ta.scrollTop;
    if (pre.value) {
      pre.value.scrollTop = ta.scrollTop;
      pre.value.scrollLeft = ta.scrollLeft;
    }
  };
}
const onEditScroll = syncEditorScroll(editGutter, editPre);

/** Tab 键插入两个空格（代码缩进友好，不跳焦点） */
function insertTab(content: Ref<string>) {
  return (e: KeyboardEvent) => {
    const ta = e.target as HTMLTextAreaElement;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    content.value = content.value.slice(0, start) + '  ' + content.value.slice(end);
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + 2;
    });
  };
}
const onEditTab = insertTab(editContent);

onMounted(async () => {
  loadingContent.value = true;
  try {
    const data = await getDocumentContent(props.knowledgeBaseId, props.doc.id);
    editContent.value = data.content;
  } catch (e) {
    toast.error((e as Error).message);
    emit('close');
  } finally {
    loadingContent.value = false;
  }
});

function cancelEdit() {
  emit('close');
}

async function saveDocEdit() {
  savingEdit.value = true;
  try {
    await updateDocument(props.knowledgeBaseId, props.doc.id, {
      filename: editFilename.value.trim(),
      content: editContent.value,
    });
    emit('saved');
    emit('close');
    toast.success('文档已保存并重新向量化');
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    savingEdit.value = false;
  }
}
</script>

<template>
  <div class="mx-auto max-w-6xl">
    <div class="mb-4 flex items-center gap-3">
      <Button variant="ghost" size="icon" :disabled="savingEdit" @click="cancelEdit">
        <ArrowLeft class="h-4 w-4" />
      </Button>
      <Input
        v-model="editFilename"
        class="h-9 flex-1 font-mono text-sm"
        placeholder="文件名（可带相对路径，如 src/Button.ts）"
      />
      <Button variant="ghost" size="sm" :disabled="savingEdit" @click="cancelEdit">取消</Button>
      <Button
        size="sm"
        :disabled="savingEdit || loadingContent || !editFilename.trim()"
        @click="saveDocEdit"
      >
        <Loader2 v-if="savingEdit" class="h-4 w-4 animate-spin" />
        {{ savingEdit ? '保存中...' : '保存并重新向量化' }}
      </Button>
    </div>
    <p class="mb-3 text-xs text-muted-foreground">
      编辑只影响知识库内的检索内容，不影响上传的原文件（下载始终拿到原始文件）
    </p>
    <div
      class="flex h-[calc(100vh-15rem)] overflow-hidden rounded-lg border border-input font-mono text-sm leading-relaxed"
    >
      <div
        ref="editGutter"
        class="w-10 shrink-0 select-none overflow-hidden border-r border-input bg-muted/30 py-2 text-right text-muted-foreground/60"
        aria-hidden="true"
      >
        <pre class="px-1.5">{{ editLineNumbers }}</pre>
      </div>
      <div class="relative flex-1 overflow-hidden bg-background">
        <div v-if="loadingContent" class="flex h-full items-center justify-center">
          <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
        <template v-else>
          <pre
            ref="editPre"
            class="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre px-3 py-2 text-foreground"
            aria-hidden="true"
            v-html="editHighlighted"
          />
          <textarea
            v-model="editContent"
            class="absolute inset-0 h-full w-full resize-none overflow-auto whitespace-pre bg-transparent px-3 py-2 text-transparent caret-foreground outline-none selection:bg-primary/25"
            spellcheck="false"
            placeholder="文档内容..."
            @scroll="onEditScroll"
            @keydown.tab.prevent="onEditTab"
          />
        </template>
      </div>
    </div>
  </div>
</template>
