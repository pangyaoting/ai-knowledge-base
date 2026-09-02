<script setup lang="ts">
defineOptions({ name: 'ChatMessageItem' });

import { FileText, Copy, GitBranch } from 'lucide-vue-next';
import { computed } from 'vue';
import ChatSourcePanel from './ChatSourcePanel.vue';
import { renderMarkdown, getCopyCode } from '@/utils/markdown';
import { toast } from '@/composables/useToast';
import type { ChatMessage, RetrievalSource } from '@/types/chat';

const props = defineProps<{
  msg: ChatMessage;
  index: number;
  useKnowledgeBase: boolean;
}>();

// 渲染结果缓存：内容不变就不重跑 markdown-it + 代码高亮（父组件重渲染时不再全量重算）
const msgHtml = computed(() => renderMarkdown(props.msg.content));

// 图片列表防御性解析：imageDataUrls 在旧数据/未更新后端时可能是 JSON 字符串，
// 直接 v-for 字符串会按字符拆出无数张废图（图片叠满屏）——统一转成数组
const imgList = computed<string[]>(() => {
  const u = props.msg.imageDataUrls as unknown as string[] | string | null | undefined;
  if (Array.isArray(u)) return u;
  if (typeof u === 'string') {
    try {
      const arr = JSON.parse(u) as unknown;
      return Array.isArray(arr) ? (arr as string[]) : [];
    } catch {
      return [];
    }
  }
  return [];
});

const emit = defineEmits<{
  (e: 'copy', msg: ChatMessage): void;
  (e: 'branch', index: number): void;
  (e: 'open-source', src: RetrievalSource): void;
  (e: 'preview-file', f: { name: string; content: string }): void;
}>();

/** 用户消息渲染：文件内容折叠（不整屏铺开） */
function msgHead(msg: ChatMessage): string {
  const i = msg.content.indexOf('【上传文件内容】');
  return i < 0 ? msg.content : msg.content.slice(0, i).trim();
}
function msgFileBlock(msg: ChatMessage): string {
  const i = msg.content.indexOf('【上传文件内容】');
  return i < 0 ? '' : msg.content.slice(i);
}

/** 解析消息里上传文件的 { 文件名, 内容 } 列表（点击文件名在右侧预览） */
function msgFiles(msg: ChatMessage): Array<{ name: string; content: string }> {
  const block = msgFileBlock(msg);
  if (!block) return [];
  const parts = block.split(/\n---\s/).slice(1);
  return parts
    .map((p) => {
      const nl = p.indexOf('\n');
      const name = (nl < 0 ? p : p.slice(0, nl))
        .replace(/^\s*---\s*/, '')
        .replace(/\s*---\s*$/, '')
        .trim();
      const content = nl < 0 ? '' : p.slice(nl + 1).trim();
      return { name, content };
    })
    .filter((f) => f.name);
}

/** 复制整条消息（回答或提问） */
async function copyMessage(msg: ChatMessage) {
  try {
    await navigator.clipboard.writeText(msg.content);
    toast.success('已复制');
  } catch {
    toast.error('复制失败');
  }
}

/** 点击复制代码按钮（事件委托） */
async function handleMessageClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (target.classList.contains('code-copy')) {
    const code = getCopyCode(target);
    if (code) {
      await navigator.clipboard.writeText(code);
      target.textContent = '已复制';
      setTimeout(() => (target.textContent = '复制'), 1500);
    }
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 兼容新旧数据：旧消息 sources 是数组（纯知识库），新消息是 { kb, web } */
function sourcesKb(s: ChatMessage['sources']): RetrievalSource[] {
  if (!s) return [];
  return Array.isArray(s) ? s : s.kb;
}
function hasWebSources(s: ChatMessage['sources']): boolean {
  return !!s && !Array.isArray(s) && s.web.length > 0;
}
const hasAnySources = (s: ChatMessage['sources']) => sourcesKb(s).length > 0 || hasWebSources(s);
</script>

<template>
  <div class="group flex" :class="props.msg.role === 'user' ? 'justify-end' : 'justify-start'">
    <div
      :class="
        props.msg.role === 'user' ? 'ml-auto flex w-fit max-w-[80%] flex-col items-end' : 'w-full'
      "
    >
      <!-- 用户消息：图片/文件独立展示在气泡外，文字用中性气泡 -->
      <template v-if="props.msg.role === 'user'">
        <div
          v-if="imgList.length"
          class="mb-1.5 grid max-w-[360px] gap-1.5"
          :class="imgList.length > 1 ? 'grid-cols-2' : ''"
        >
          <img
            v-for="(u, i) in imgList"
            :key="i"
            :src="u"
            loading="lazy"
            decoding="async"
            class="max-h-48 w-full rounded-md object-cover"
            :class="imgList.length === 1 ? 'max-w-[280px]' : ''"
            alt="图片"
          />
        </div>
        <img
          v-else-if="props.msg.imageDataUrl"
          :src="props.msg.imageDataUrl"
          loading="lazy"
          decoding="async"
          class="mb-1.5 max-h-48 rounded-md object-cover"
          alt="粘贴图片"
        />
        <div v-if="msgFiles(props.msg).length" class="mb-1.5 flex flex-wrap gap-1.5">
          <button
            v-for="(f, fi) in msgFiles(props.msg)"
            :key="fi"
            class="flex cursor-pointer items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs transition-colors hover:bg-accent"
            title="点击在右侧查看文件内容"
            @click="emit('preview-file', f)"
          >
            <FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span class="max-w-[200px] truncate">{{ f.name }}</span>
          </button>
        </div>
        <div
          v-if="msgHead(props.msg)"
          class="inline-block max-w-full whitespace-pre-wrap rounded-2xl rounded-br-sm bg-muted px-4 py-2.5 text-[18px] text-foreground"
        >
          {{ msgHead(props.msg) }}
        </div>
      </template>
      <!-- 助手消息：Markdown -->
      <div v-else class="markdown-body px-1" @click="handleMessageClick" v-html="msgHtml" />
      <!-- 操作条：复制（提问/回答）+ 分支（回答）；一直显示，提问右对齐 -->
      <div
        class="mt-1.5 flex items-center gap-1"
        :class="props.msg.role === 'user' ? 'justify-end' : 'justify-start'"
      >
        <button
          class="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="复制整条消息"
          @click="copyMessage(props.msg)"
        >
          <Copy class="h-3.5 w-3.5" />
          复制
        </button>
        <button
          v-if="props.msg.role === 'assistant'"
          class="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="基于这条回答新建会话，换个角度继续提问"
          @click="emit('branch', props.index)"
        >
          <GitBranch class="h-3.5 w-3.5" />
          分支
        </button>
      </div>

      <!-- 知识库模式但没有任何引用：回答来自模型自身知识，明示来源 -->
      <p
        v-if="
          props.msg.role === 'assistant' &&
          props.msg.sources &&
          sourcesKb(props.msg.sources).length === 0 &&
          !hasWebSources(props.msg.sources) &&
          props.useKnowledgeBase
        "
        class="mt-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
      >
        ⚠️ 未检索到知识库资料，以上回答基于模型自身知识（可在知识库补充相关文档后重问）
      </p>

      <!-- 引用来源 -->
      <ChatSourcePanel
        v-if="props.msg.role === 'assistant' && hasAnySources(props.msg.sources)"
        class="mt-2"
        :sources="props.msg.sources"
        @open-source="emit('open-source', $event)"
      />

      <div
        v-if="props.msg.role === 'user'"
        class="mt-1 text-right text-[11px] text-muted-foreground"
      >
        {{ formatTime(props.msg.createdAt) }}
      </div>
    </div>
  </div>
</template>
