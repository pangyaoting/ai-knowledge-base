<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import { MessageSquare, Plus, Send, Square, Trash2, Loader2, BookOpen } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import {
  getChatSessions,
  createChatSession,
  getChatMessages,
  deleteChatSession,
  askQuestion,
} from '@/api/chat';
import { renderMarkdown, getCopyCode } from '@/utils/markdown';
import type { ChatSession, ChatMessage, ChatSources, RetrievalSource, WebSource } from '@/types/chat';

// ==================== 状态 ====================
const sessions = ref<ChatSession[]>([]);
const currentSessionId = ref<string | null>(null);
const messages = ref<ChatMessage[]>([]);

const input = ref('');
const streaming = ref(false);
const error = ref('');
const loadingSessions = ref(false);
const useWebSearch = ref(false); // 联网检索开关

// 流式回答的中间状态（回答完成后并入 messages）
const streamContent = ref('');
const streamSources = ref<ChatSources>({ kb: [], web: [] });

const abortController = ref<AbortController | null>(null);
const messageContainer = ref<HTMLElement | null>(null);

// ==================== 会话管理 ====================

async function loadSessions() {
  loadingSessions.value = true;
  try {
    sessions.value = await getChatSessions();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loadingSessions.value = false;
  }
}

async function selectSession(id: string) {
  if (streaming.value) return;
  currentSessionId.value = id;
  error.value = '';
  messages.value = [];
  try {
    messages.value = await getChatMessages(id);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function handleNewSession() {
  if (streaming.value) return;
  try {
    const session = await createChatSession({});
    await loadSessions();
    await selectSession(session.id);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function handleDeleteSession(id: string) {
  // eslint-disable-next-line no-alert
  if (!window.confirm('删除该会话及其全部消息？')) return;
  try {
    await deleteChatSession(id);
    if (currentSessionId.value === id) {
      currentSessionId.value = null;
      messages.value = [];
    }
    await loadSessions();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// ==================== 提问与流式 ====================

const canSend = computed(() => input.value.trim().length > 0 && !streaming.value && !!currentSessionId.value);

async function handleSend() {
  const question = input.value.trim();
  if (!question || streaming.value || !currentSessionId.value) return;

  input.value = '';
  error.value = '';
  streaming.value = true;
  streamContent.value = '';
  streamSources.value = { kb: [], web: [] };

  // 乐观渲染：用户消息立即上屏
  messages.value.push({
    id: `local-${Date.now()}`,
    sessionId: currentSessionId.value,
    role: 'user',
    content: question,
    sources: null,
    createdAt: new Date().toISOString(),
  });

  abortController.value = new AbortController();
  try {
    await askQuestion(
      currentSessionId.value,
      question,
      useWebSearch.value,
      abortController.value.signal,
      {
        onSources: (sources) => {
          streamSources.value = sources;
        },
        onDelta: (delta) => {
          streamContent.value += delta;
        },
        onDone: () => {
          // 完成：把流式消息并入正式列表
          messages.value.push({
            id: `local-${Date.now()}`,
            sessionId: currentSessionId.value!,
            role: 'assistant',
            content: streamContent.value,
            sources: streamSources.value,
            createdAt: new Date().toISOString(),
          });
          streamContent.value = '';
          streamSources.value = { kb: [], web: [] };
          loadSessions(); // 刷新标题/消息数
        },
        onError: (message) => {
          error.value = message;
        },
      },
    );
  } finally {
    streaming.value = false;
    abortController.value = null;
  }
}

function handleStop() {
  abortController.value?.abort();
  streaming.value = false;
}

// ==================== 交互 ====================

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

// 自动滚动到底部
watch([messages, streamContent], async () => {
  await nextTick();
  if (messageContainer.value) {
    messageContainer.value.scrollTop = messageContainer.value.scrollHeight;
  }
});

// 初始化：加载会话，没有就新建
onMounted(async () => {
  await loadSessions();
  if (sessions.value.length > 0) {
    await selectSession(sessions.value[0].id);
  } else {
    await handleNewSession();
  }
});

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function similarityPercent(s: number): string {
  return `${Math.round(s * 100)}%`;
}

/** 兼容新旧数据：旧消息 sources 是数组（纯知识库），新消息是 { kb, web } */
function sourcesKb(sources: ChatSources | RetrievalSource[] | null): RetrievalSource[] {
  if (!sources) return [];
  return Array.isArray(sources) ? sources : sources.kb;
}

function sourcesWeb(sources: ChatSources | RetrievalSource[] | null): WebSource[] {
  if (!sources || Array.isArray(sources)) return [];
  return sources.web;
}
</script>

<template>
  <div class="flex h-[calc(100vh-4rem)] overflow-hidden">
    <!-- 左侧：会话列表 -->
    <aside class="flex w-64 flex-col border-r bg-card/50">
      <div class="p-3">
        <Button class="w-full" @click="handleNewSession">
          <Plus class="h-4 w-4" />
          新建对话
        </Button>
      </div>
      <div class="flex-1 overflow-y-auto px-2 pb-2">
        <div v-if="loadingSessions" class="flex justify-center py-8">
          <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
        <button
          v-for="s in sessions"
          :key="s.id"
          class="mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm transition-colors"
          :class="
            s.id === currentSessionId
              ? 'bg-primary/10 text-primary'
              : 'hover:bg-accent text-foreground'
          "
          @click="selectSession(s.id)"
        >
          <MessageSquare class="h-4 w-4 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate">{{ s.title }}</span>
          <span class="shrink-0 text-xs text-muted-foreground">{{ s._count?.messages ?? 0 }}</span>
          <button
            class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            @click.stop="handleDeleteSession(s.id)"
          >
            <Trash2 class="h-3.5 w-3.5" />
          </button>
        </button>
      </div>
    </aside>

    <!-- 右侧：对话区 -->
    <main class="flex flex-1 flex-col">
      <!-- 消息区 -->
      <div ref="messageContainer" class="flex-1 overflow-y-auto">
        <div v-if="!currentSessionId" class="flex h-full flex-col items-center justify-center text-center">
          <BookOpen class="h-12 w-12 text-muted-foreground/40" />
          <p class="mt-3 text-sm text-muted-foreground">选择或新建一个会话开始提问</p>
        </div>

        <div v-else class="mx-auto max-w-3xl space-y-6 px-4 py-6">
          <!-- 历史消息 -->
          <div v-for="(msg, i) in messages" :key="i" class="flex" :class="msg.role === 'user' ? 'justify-end' : 'justify-start'">
            <div :class="msg.role === 'user' ? 'max-w-[80%]' : 'w-full'">
              <div
                v-if="msg.role === 'assistant'"
                class="markdown-body rounded-lg border bg-card px-4 py-3"
                @click="handleMessageClick"
                v-html="renderMarkdown(msg.content)"
              />
              <div
                v-else
                class="rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground whitespace-pre-wrap"
              >
                {{ msg.content }}
              </div>

              <!-- 引用来源（兼容旧数据：旧消息 sources 是数组，新消息是 { kb, web }） -->
              <div
                v-if="
                  msg.role === 'assistant' &&
                  msg.sources &&
                  (sourcesKb(msg.sources).length > 0 || sourcesWeb(msg.sources).length > 0)
                "
                class="mt-2"
              >
                <details class="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
                  <summary class="cursor-pointer font-medium text-muted-foreground">
                    引用来源（知识库 {{ sourcesKb(msg.sources).length }} 条
                    <template v-if="sourcesWeb(msg.sources).length"> · 网络 {{ sourcesWeb(msg.sources).length }} 条</template>）
                  </summary>

                  <!-- 知识库来源 -->
                  <div v-if="sourcesKb(msg.sources).length" class="mt-2">
                    <p class="font-medium text-muted-foreground">📚 知识库</p>
                    <ul class="mt-1.5 space-y-1.5">
                      <li
                        v-for="(src, si) in sourcesKb(msg.sources)"
                        :key="'kb-' + si"
                        class="flex items-start gap-2 text-muted-foreground"
                      >
                        <span class="mt-0.5 shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                          来源{{ si + 1 }}
                        </span>
                        <span class="min-w-0">
                          <span class="font-medium text-foreground">{{ src.filename }}</span>
                          <span class="ml-1.5">相似度 {{ similarityPercent(src.similarity) }}</span>
                          <p class="mt-0.5 line-clamp-2">{{ src.content }}</p>
                        </span>
                      </li>
                    </ul>
                  </div>

                  <!-- 网络来源 -->
                  <div v-if="sourcesWeb(msg.sources).length" class="mt-3">
                    <p class="font-medium text-muted-foreground">🌐 网络</p>
                    <ul class="mt-1.5 space-y-1.5">
                      <li
                        v-for="(src, wi) in sourcesWeb(msg.sources)"
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
              </div>

              <div v-if="msg.role === 'user'" class="mt-1 text-right text-[11px] text-muted-foreground">
                {{ formatTime(msg.createdAt) }}
              </div>
            </div>
          </div>

          <!-- 流式回答中 -->
          <div v-if="streaming" class="flex justify-start">
            <div class="w-full">
              <div
                class="markdown-body rounded-lg border bg-card px-4 py-3"
                @click="handleMessageClick"
                v-html="renderMarkdown(streamContent || '…')"
              />
              <div
                v-if="streamSources.kb.length || streamSources.web.length"
                class="mt-2 text-xs text-muted-foreground"
              >
                已检索到知识库 {{ streamSources.kb.length }} 条
                <template v-if="streamSources.web.length"> + 网络 {{ streamSources.web.length }} 条</template>，正在生成回答...
              </div>
            </div>
          </div>

          <!-- 错误提示 -->
          <p v-if="error" class="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {{ error }}
          </p>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="border-t bg-card/50 p-4">
        <div class="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            v-model="input"
            rows="1"
            class="max-h-40 min-h-[44px] flex-1 resize-y rounded-md border border-input bg-background px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="输入问题，Enter 发送，Shift+Enter 换行"
            :disabled="!currentSessionId"
            @keydown.enter.exact.prevent="handleSend"
          />
          <Button
            v-if="!streaming"
            :disabled="!canSend"
            @click="handleSend"
          >
            <Send class="h-4 w-4" />
            发送
          </Button>
          <Button v-else variant="destructive" @click="handleStop">
            <Square class="h-4 w-4" />
            停止
          </Button>
        </div>
        <p class="mx-auto mt-2 flex max-w-3xl items-center justify-center gap-4 text-[11px] text-muted-foreground">
          <label class="flex cursor-pointer items-center gap-1.5 select-none">
            <input
              v-model="useWebSearch"
              type="checkbox"
              class="h-3.5 w-3.5 rounded border-input"
              :disabled="streaming"
            />
            <span :class="{ 'text-primary': useWebSearch }">🌐 联网检索</span>
          </label>
          <span>回答基于知识库资料生成，开启联网可同时检索最新网页</span>
        </p>
      </div>
    </main>
  </div>
</template>

<style scoped>
/* AI 回答的 Markdown 排版 */
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  font-weight: 600;
  line-height: 1.3;
  margin: 0.75em 0 0.4em;
}
.markdown-body :deep(h1) { font-size: 1.3em; }
.markdown-body :deep(h2) { font-size: 1.15em; }
.markdown-body :deep(h3) { font-size: 1.05em; }
.markdown-body :deep(p) { margin: 0.5em 0; line-height: 1.7; }
.markdown-body :deep(ul),
.markdown-body :deep(ol) { margin: 0.5em 0; padding-left: 1.5em; }
.markdown-body :deep(li) { margin: 0.25em 0; }
.markdown-body :deep(a) { color: var(--primary); text-decoration: underline; }
.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--border);
  padding-left: 0.75em;
  color: var(--muted-foreground);
  margin: 0.5em 0;
}
.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 0.5em 0;
  font-size: 0.9em;
}
.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--border);
  padding: 0.35em 0.6em;
}
.markdown-body :deep(code:not(pre code)) {
  background: var(--muted);
  border-radius: 4px;
  padding: 0.1em 0.35em;
  font-size: 0.9em;
}

/* 代码块 + 复制按钮 */
.markdown-body :deep(.code-block) {
  position: relative;
  margin: 0.6em 0;
}
.markdown-body :deep(.code-block pre) {
  border-radius: 8px;
  overflow-x: auto;
  padding: 0.9em 1em;
  font-size: 0.85em;
  line-height: 1.5;
  background: #f6f8fa;
}
.markdown-body :deep(.code-copy) {
  position: absolute;
  top: 6px;
  right: 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--card);
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
  color: var(--muted-foreground);
}
.markdown-body :deep(.code-copy:hover) {
  color: var(--foreground);
  border-color: var(--foreground);
}
</style>
