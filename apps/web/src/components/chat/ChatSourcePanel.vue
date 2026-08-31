<script setup lang="ts">
defineOptions({ name: 'ChatSourcePanel' });

import type { ChatSources, RetrievalSource, WebSource } from '@/types/chat';

const props = defineProps<{
  sources: ChatSources | RetrievalSource[] | null;
}>();

const emit = defineEmits<{
  (e: 'open-source', src: RetrievalSource): void;
}>();

/** 兼容新旧数据：旧消息 sources 是数组（纯知识库），新消息是 { kb, web } */
function sourcesKb(sources: ChatSources | RetrievalSource[] | null): RetrievalSource[] {
  if (!sources) return [];
  return Array.isArray(sources) ? sources : sources.kb;
}

function sourcesWeb(sources: ChatSources | RetrievalSource[] | null): WebSource[] {
  if (!sources || Array.isArray(sources)) return [];
  return sources.web;
}

function similarityPercent(s: number | null): string {
  return s == null ? '相关' : `${Math.round(s * 100)}%`;
}
</script>

<template>
  <details class="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
    <summary class="cursor-pointer font-medium text-muted-foreground">
      引用来源（知识库 {{ sourcesKb(props.sources).length }} 条
      <template v-if="sourcesWeb(props.sources).length">
        · 网络 {{ sourcesWeb(props.sources).length }} 条</template
      >）
    </summary>

    <!-- 知识库来源（点击可定位到原文文本块） -->
    <div v-if="sourcesKb(props.sources).length" class="mt-2">
      <p class="font-medium text-muted-foreground">📚 知识库</p>
      <ul class="mt-1.5 space-y-1.5">
        <li
          v-for="(src, si) in sourcesKb(props.sources)"
          :key="'kb-' + si"
          class="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent/60"
          :title="'点击定位到原文第 ' + (src.chunkIndex + 1) + ' 段'"
          @click="emit('open-source', src)"
        >
          <span
            class="mt-0.5 shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
          >
            来源{{ si + 1 }}
          </span>
          <span class="min-w-0">
            <span class="font-medium text-foreground">{{ src.filename }}</span>
            <span class="ml-1.5">相似度 {{ similarityPercent(src.similarity) }}</span>
            <p class="mt-0.5 line-clamp-2">{{ src.content }}</p>
          </span>
        </li>
      </ul>
      <p class="mt-1.5 text-[11px] text-muted-foreground/70">💡 点击来源可定位到文档原文位置</p>
    </div>

    <!-- 网络来源 -->
    <div v-if="sourcesWeb(props.sources).length" class="mt-3">
      <p class="font-medium text-muted-foreground">🌐 网络</p>
      <ul class="mt-1.5 space-y-1.5">
        <li
          v-for="(src, wi) in sourcesWeb(props.sources)"
          :key="'web-' + wi"
          class="flex items-start gap-2 text-muted-foreground"
        >
          <span class="mt-0.5 shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-600">
            网络{{ wi + 1 }}
          </span>
          <span class="min-w-0">
            <a
              :href="src.url"
              target="_blank"
              rel="noopener noreferrer"
              class="font-medium text-primary underline-offset-2 hover:underline"
            >
              {{ src.title }}
            </a>
            <p class="mt-0.5 line-clamp-2">{{ src.content }}</p>
          </span>
        </li>
      </ul>
    </div>
  </details>
</template>
