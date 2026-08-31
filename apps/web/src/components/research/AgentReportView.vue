<script setup lang="ts">
defineOptions({ name: 'AgentReportView' });

import { computed, ref } from 'vue';
import { ChevronRight, ExternalLink } from 'lucide-vue-next';
import { renderMarkdown, getCopyCode } from '@/utils/markdown';
import type { AgentTask } from '@/types/research-agent';

const props = defineProps<{
  task: AgentTask;
}>();

async function handleReportClick(e: MouseEvent) {
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

interface ReportSection {
  title: string;
  body: string;
  idx: number;
}

/** 按 `## ` 二级标题把报告拆成小节（引言/各方向/结论） */
const sections = computed<ReportSection[]>(() => {
  const report = props.task.report;
  if (!report) return [];
  const parts = report.split(/\n## /);
  const out: ReportSection[] = [];
  for (let i = 1; i < parts.length; i++) {
    const lines = parts[i].split('\n');
    const title = lines[0].replace(/^#+\s*/, '').trim();
    const body = lines.slice(1).join('\n').trim();
    if (title) out.push({ title, body, idx: out.length });
  }
  return out;
});

const isMetaTitle = (t: string) => t === '引言' || t === '结论';
const dirSections = computed(() =>
  sections.value.filter((s) => !isMetaTitle(s.title) && s.body.trim()),
);
const introSection = computed(() =>
  sections.value.find((s) => s.title === '引言' && s.body.trim()),
);
const conclusionSection = computed(() =>
  sections.value.find((s) => s.title === '结论' && s.body.trim()),
);

/** 已展开的方向卡片下标（默认全部折叠，点标题展开） */
const expanded = ref<Set<number>>(new Set());
/** 全部展开/收起 按钮文案状态 */
const allExpanded = ref(false);

function toggleSection(i: number) {
  const next = new Set(expanded.value);
  if (next.has(i)) next.delete(i);
  else next.add(i);
  expanded.value = next;
}

function toggleAllSections() {
  allExpanded.value = !allExpanded.value;
  expanded.value = allExpanded.value ? new Set(dirSections.value.map((s) => s.idx)) : new Set();
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-6">
    <!-- 摘要卡片（含全部展开/收起） -->
    <div
      v-if="props.task.summary"
      class="mb-4 rounded-lg border border-primary/25 bg-primary/5 px-4 py-3"
    >
      <div class="flex items-center justify-between gap-2">
        <p class="text-xs font-semibold tracking-wide text-primary">📋 执行摘要</p>
        <button
          type="button"
          class="shrink-0 text-xs font-medium text-primary hover:underline"
          @click="toggleAllSections"
        >
          {{ allExpanded ? '全部收起' : '全部展开' }}
        </button>
      </div>
      <p class="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">{{ props.task.summary }}</p>
    </div>

    <!-- 引言 -->
    <div v-if="introSection" class="mb-4">
      <p class="mb-1 text-xs font-semibold tracking-wide text-muted-foreground">📖 引言</p>
      <div
        class="markdown-body"
        @click="handleReportClick"
        v-html="renderMarkdown(introSection.body)"
      />
    </div>

    <!-- 方向卡片：一个方向一个卡片（默认折叠，点标题展开） -->
    <div class="space-y-2">
      <div
        v-for="sec in dirSections"
        :key="sec.idx"
        class="overflow-hidden rounded-lg border bg-card"
      >
        <button
          type="button"
          class="flex w-full select-none items-center gap-1.5 px-3 py-2.5 text-left text-sm font-semibold hover:bg-accent/60"
          @click="toggleSection(sec.idx)"
        >
          <ChevronRight
            class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform"
            :class="expanded.has(sec.idx) ? 'rotate-90' : ''"
          />
          {{ sec.title }}
        </button>
        <div
          v-show="expanded.has(sec.idx)"
          class="markdown-body border-t px-4 py-3"
          @click="handleReportClick"
          v-html="renderMarkdown(sec.body)"
        />
      </div>
    </div>

    <!-- 结论 -->
    <div v-if="conclusionSection" class="mt-4">
      <p class="mb-1 text-xs font-semibold tracking-wide text-muted-foreground">🏁 结论</p>
      <div
        class="markdown-body"
        @click="handleReportClick"
        v-html="renderMarkdown(conclusionSection.body)"
      />
    </div>

    <!-- 来源 -->
    <div v-if="props.task.sources?.length" class="mt-4">
      <details class="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
        <summary class="cursor-pointer font-medium text-muted-foreground">
          🌐 引用来源（{{ props.task.sources.length }} 条网页）
        </summary>
        <ul class="mt-2 space-y-1.5">
          <li
            v-for="src in props.task.sources"
            :key="src.number"
            class="flex items-start gap-2 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent/60"
          >
            <span
              class="mt-0.5 shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
            >
              来源{{ src.number }}
            </span>
            <a
              :href="src.url"
              target="_blank"
              rel="noopener noreferrer"
              class="flex min-w-0 items-center gap-1 font-medium text-foreground hover:text-primary hover:underline"
            >
              <span class="truncate">{{ src.title || src.url }}</span>
              <ExternalLink class="h-3 w-3 shrink-0" />
            </a>
          </li>
        </ul>
      </details>
    </div>
  </div>
</template>
