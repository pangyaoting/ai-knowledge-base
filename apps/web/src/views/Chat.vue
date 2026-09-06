<script setup lang="ts">
defineOptions({ name: 'ChatView' });
import { ref, computed, onMounted, onActivated, onBeforeUnmount, watch, nextTick } from 'vue';
import {
  Menu,
  BookOpen,
  Download,
  PanelLeftClose,
  PanelLeftOpen,
  FileText,
  X,
  RefreshCw,
} from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import DocPreviewDrawer from '@/components/DocPreviewDrawer.vue';
import ChatSessionSidebar from '@/components/chat/ChatSessionSidebar.vue';
import ChatMessageItem from '@/components/chat/ChatMessageItem.vue';
import ChatThinkingBar from '@/components/chat/ChatThinkingBar.vue';
import ChatMessageInput from '@/components/chat/ChatMessageInput.vue';
import ChatKbPickerModal from '@/components/chat/ChatKbPickerModal.vue';
import { toast } from '@/composables/useToast';
import { confirmDialog } from '@/composables/useConfirm';
import {
  getChatSessions,
  createChatSession,
  getChatMessages,
  deleteChatSession,
  updateSessionKnowledgeBases,
  updateSessionModel,
  exportSessionFile,
  askQuestion,
  extractFileText,
} from '@/api/chat';
import { renderMarkdown, getCopyCode } from '@/utils/markdown';
import { copyText } from '@/utils/clipboard';
import { getKnowledgeBases } from '@/api/knowledge';
import { getModelConfigs } from '@/api/model-configs';
import type { KnowledgeBase } from '@/types/knowledge';
import type { ModelConfig } from '@/types/model-config';
import type { ChatSession, ChatMessage, ChatSources, RetrievalSource } from '@/types/chat';
import { MAX_IMAGES_PER_MESSAGE } from '@/types/chat';

// ==================== 状态 ====================
const sessions = ref<ChatSession[]>([]);
const currentSessionId = ref<string | null>(null);
const messages = ref<ChatMessage[]>([]);

const input = ref('');
/** 会话切换请求序号：竞态防护用（快速切换时只采用最后一次请求） */
let sessionReqNo = 0;
/** 乐观渲染消息自增序号：保证 local- 消息 id 唯一（消息列表 key 用 id，id 相同会复用 DOM 导致图片堆叠） */
let localMsgSeq = 0;
/** 每个会话独立的输入草稿：切换会话时保存/恢复，不串台也不丢失 */
const inputDrafts = ref<Record<string, string>>({});
const imageDrafts = ref<Record<string, string[]>>({});

// ==================== 图片（粘贴 / 上传，最多 9 张，压缩后进消息） ====================
const pendingImages = ref<string[]>([]);
const MAX_IMAGES = MAX_IMAGES_PER_MESSAGE;

/** 粘贴图片：收集剪贴板全部图片 → 压缩 → 加入待发送列表 */
async function onPasteImage(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files: File[] = [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (!files.length) return;
  e.preventDefault();
  const imgs = await Promise.all(files.map(compressImage));
  const room = MAX_IMAGES - pendingImages.value.length;
  pendingImages.value.push(...imgs.slice(0, Math.max(0, room)));
  if (imgs.length > room) toast.info(`一次最多 ${MAX_IMAGES} 张图片`);
}

function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1024;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('图片处理失败'));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    img.src = url;
  });
}

function removeImage(i: number) {
  pendingImages.value.splice(i, 1);
}

/** 选择本地图片（子组件传来 File[]）：压缩 → 加入待发送列表（P2：绑定发起时会话，切走不串台） */
async function onPickImage(files: File[]) {
  if (!files.length) return;
  const fromSession = currentSessionId.value; // 发起选择时的会话
  try {
    const imgs = await Promise.all(files.map(compressImage));
    // 压缩是异步的：期间用户可能已切换会话——结果归属发起时会话，不污染当前会话输入
    if (fromSession && currentSessionId.value !== fromSession) {
      imageDrafts.value[fromSession] = [...(imageDrafts.value[fromSession] ?? []), ...imgs].slice(
        0,
        MAX_IMAGES,
      );
      toast.info('图片已加入原会话草稿（你已切换到其他会话）');
      return;
    }
    const room = MAX_IMAGES - pendingImages.value.length;
    pendingImages.value.push(...imgs.slice(0, Math.max(0, room)));
    if (imgs.length > room) toast.info(`一次最多 ${MAX_IMAGES} 张图片`);
  } catch (err) {
    toast.error((err as Error).message);
  }
}

// ==================== 上传文件（文本/代码/PDF/Word，提取内容后随消息发送） ====================
const MAX_FILES = 5;
const pendingFiles = ref<Array<{ name: string; content: string }>>([]);

async function onPickFile(files: File[]) {
  const fromSession = currentSessionId.value; // 发起选择时的会话（P2：提取是异步的，切走不串台）
  for (const f of files) {
    if (pendingFiles.value.length >= MAX_FILES) {
      toast.info(`一次最多 ${MAX_FILES} 个文件`);
      break;
    }
    // P2-10：与后端 FileInterceptor 限制一致（20MB），超限前端直接拒绝，不走网络请求
    if (f.size > 20 * 1024 * 1024) {
      toast.error(`「${f.name}」超过 20MB 上限，请压缩后重试`);
      continue;
    }
    try {
      const res = await extractFileText(f);
      if (fromSession && currentSessionId.value !== fromSession) {
        // 提取期间切走了会话：内容归属发起时会话（文件草稿未做跨会话持久化，提示用户回去重选即可）
        toast.info(`「${res.filename}」内容已提取，请回到原会话重新添加（防止串台）`);
        return;
      }
      pendingFiles.value.push({ name: res.filename, content: res.content });
      // P2-10：后端对超长文件做了截断（30k 字符），明确告知用户避免误解为完整内容
      if (res.truncated) toast.info(`「${res.filename}」过长已截断（仅保留前 3 万字符）`);
    } catch (err) {
      toast.error(`${f.name}：${(err as Error).message}`);
    }
  }
}

function removeFile(i: number) {
  pendingFiles.value.splice(i, 1);
}

/** 右侧文件内容预览面板（点击输入框中的文件 chip 打开） */
const filePreview = ref<{ name: string; content: string } | null>(null);
const streaming = ref(false);
const error = ref('');
const loadingSessions = ref(false);
// 联网检索开关（localStorage 持久化：刷新/重进页面保持勾选状态）
const useWebSearch = ref(localStorage.getItem('kb-use-web-search') === '1');
watch(useWebSearch, (v) => localStorage.setItem('kb-use-web-search', v ? '1' : '0'));
const sidebarOpen = ref(false); // 移动端：会话列表抽屉开关
const sidebarCollapsed = ref(false); // 桌面端：会话列表侧边栏收起/展开
const sessionSearch = ref(''); // 会话搜索关键词（标题/消息内容全文检索）
let searchTimer: ReturnType<typeof setTimeout> | null = null;

// 模型配置（BYO 大模型 API）：会话可选用户自带的 key
const modelConfigs = ref<ModelConfig[]>([]);

const defaultModelConfigId = computed(
  () => modelConfigs.value.find((c) => c.isDefault)?.id ?? null,
);

/** 视觉模型名启发式（与后端一致）：vision / VL / 4V / Omni / GLM-4V 等 */
const VISION_RE = /vision|[-/]vl\b|vl[-.\d]|4v|omni|glm-4v|internvl|minicpm/i;

/** 当前会话实际使用的模型名（会话绑定配置+模型 → 默认配置；用于发图时判断是否会自动路由） */
const activeModelId = computed(() => {
  const sid = currentSession.value?.modelConfigId;
  if (sid) return currentSession.value?.model ?? null;
  return modelConfigs.value.find((c) => c.isDefault)?.model ?? null;
});

/** 当前会话使用的模型显示名（配置名 / 模型名；未绑定 = 跟随默认配置） */
const currentModelName = computed(() => {
  const sid = currentSession.value?.modelConfigId;
  if (sid) {
    const c = modelConfigs.value.find((x) => x.id === sid);
    if (c)
      return currentSession.value?.model && currentSession.value.model !== c.model
        ? `${c.name} / ${currentSession.value.model}`
        : c.name;
  }
  return modelConfigs.value.find((c) => c.isDefault)?.name ?? '未绑定模型';
});

async function loadModelConfigs() {
  try {
    modelConfigs.value = await getModelConfigs();
  } catch {
    modelConfigs.value = [];
  }
}

/** 切换当前会话的模型配置 + 具体模型名（null = 跟随用户默认配置） */
async function selectModel(configId: string | null, model?: string | null) {
  if (!currentSessionId.value) return;
  try {
    await updateSessionModel(currentSessionId.value, configId, model ?? null);
    await loadSessions();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

const currentReasoning = computed(() => currentSession.value?.reasoningEffort ?? null);

async function setReasoningEffort(effort: string) {
  if (!currentSessionId.value) return;
  try {
    await updateSessionModel(
      currentSessionId.value,
      currentSession.value?.modelConfigId ?? null,
      undefined, // 不改模型名
      effort,
    );
    await loadSessions();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// 新建会话时选择问答来源：三种模式
const kbs = ref<KnowledgeBase[]>([]);
const showKbPicker = ref(false);
const pickerMode = ref<'create' | 'edit'>('create');
const pickerScope = ref<'none' | 'all' | 'specific'>('all');
const pickingKbIds = ref<string[]>([]);

/** 切换模式（radio 互斥）；勾选具体库会自动切到"指定"模式 */
function setPickerScope(scope: 'none' | 'all' | 'specific') {
  pickerScope.value = scope;
}

function toggleKb(id: string) {
  if (pickerScope.value === 'all') {
    pickerScope.value = 'specific';
    pickingKbIds.value = kbs.value.map((k) => k.id).filter((x) => x !== id);
    return;
  }
  if (pickerScope.value !== 'specific') {
    pickerScope.value = 'specific';
    pickingKbIds.value = [id];
    return;
  }
  const i = pickingKbIds.value.indexOf(id);
  if (i >= 0) pickingKbIds.value.splice(i, 1);
  else pickingKbIds.value.push(id);
}

/** 指定模式下至少要选一个库才允许提交（none/all 模式始终可提交） */
const canSubmitPicker = computed(
  () => pickerScope.value !== 'specific' || pickingKbIds.value.length > 0,
);

/** 当前会话对象（读 useKnowledgeBase 判断是否纯对话模式） */
const currentSession = computed(
  () => sessions.value.find((x) => x.id === currentSessionId.value) ?? null,
);
const useKnowledgeBase = computed(() => currentSession.value?.useKnowledgeBase ?? true);

/** 当前会话绑定的知识库（用于顶部的"问答范围"标签） */
const currentScope = computed<ChatSession['knowledgeBases']>(() => {
  const s = sessions.value.find((x) => x.id === currentSessionId.value);
  return s?.knowledgeBases ?? [];
});

/** 当前会话标题（对话区头部显示） */
const currentTitle = computed(() => {
  const s = sessions.value.find((x) => x.id === currentSessionId.value);
  return s?.title ?? '';
});

/** 范围标签：纯聊天 / 全部知识库 / 指定库名 */
function scopeLabel(bound: ChatSession['knowledgeBases'], useKb: boolean): string {
  if (!useKb) return '纯聊天';
  if (bound.length) {
    const names = bound.map((k) => k.knowledgeBase.name);
    return names.length <= 2
      ? names.join('、')
      : `${names.slice(0, 2).join('、')} 等${names.length}个`;
  }
  return '全部知识库';
}

const scopeTitle = computed(() => {
  if (!useKnowledgeBase.value) return '当前会话不使用知识库（纯对话模式），点击可修改';
  if (currentScope.value.length) {
    return (
      '问答范围：' + currentScope.value.map((k) => k.knowledgeBase.name).join('、') + '，点击可修改'
    );
  }
  return '问答范围：全部知识库，点击可修改';
});

/** 输入区下方提示文案（跟随是否纯对话模式） */
const inputHint = computed(() =>
  useKnowledgeBase.value
    ? '回答基于知识库资料生成，开启联网可同时检索最新网页'
    : '当前为纯对话模式（不检索知识库），开启联网可检索最新网页',
);

// 流式回答的中间状态（回答完成后并入 messages）
const streamContent = ref('');
const streamSources = ref<ChatSources>({ kb: [], web: [] });

const abortController = ref<AbortController | null>(null);
const messageContainer = ref<HTMLElement | null>(null);
const messageInputRef = ref<InstanceType<typeof ChatMessageInput> | null>(null);

/** 思考计时：发送开始计时，首个 token/完成/停止时清零停表（右侧显示已等待时间） */
const thinkingSeconds = ref(0);
let thinkingTimer: ReturnType<typeof setInterval> | null = null;
function startThinkingTimer() {
  stopThinkingTimer();
  thinkingSeconds.value = 0;
  thinkingTimer = setInterval(() => thinkingSeconds.value++, 1000);
}
function stopThinkingTimer() {
  if (thinkingTimer) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
}

// 文档预览抽屉（点击引用来源 → 定位到原文文本块）
const previewDocId = ref<string | null>(null);
const previewChunkIndex = ref<number | null>(null);

function openSource(src: RetrievalSource) {
  previewDocId.value = src.documentId;
  previewChunkIndex.value = src.chunkIndex;
}

// ==================== 会话管理 ====================

async function loadSessions(q?: string) {
  loadingSessions.value = true;
  try {
    sessions.value = await getChatSessions(q);
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    loadingSessions.value = false;
  }
}

// 会话搜索：防抖 300ms 后请求后端全文检索（标题 / 消息内容）
watch(sessionSearch, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    loadSessions(sessionSearch.value.trim() || undefined);
  }, 300);
});

async function selectSession(id: string) {
  if (streaming.value) return;
  // 记忆当前会话：切到别的导航再回来，仍停留在该会话
  sessionStorage.setItem('chat-active-session', id);
  // 按会话保存/恢复输入草稿：切走时存当前输入，切回时恢复（不串台也不丢失）
  if (currentSessionId.value) {
    inputDrafts.value[currentSessionId.value] = input.value;
    imageDrafts.value[currentSessionId.value] = [...pendingImages.value];
  }
  input.value = inputDrafts.value[id] ?? '';
  pendingImages.value = imageDrafts.value[id] ?? [];
  currentSessionId.value = id;
  error.value = '';
  messages.value = [];
  // P2：切换会话后滚动状态重置——新会话默认停在最新消息（autoScroll=true），
  // 并清掉上一个会话记录的历史位置（否则翻过历史的会话 B 会带偏会话 A 的恢复）
  autoScroll = true;
  savedChatScrollTop = 0;
  // 竞态防护：快速连续切换会话时，只采用最后一次请求的结果（避免旧会话消息覆盖当前会话）
  const reqNo = ++sessionReqNo;
  try {
    const list = await getChatMessages(id);
    if (reqNo === sessionReqNo) messages.value = list;
  } catch (e) {
    if (reqNo === sessionReqNo) error.value = (e as Error).message;
  }
}

async function handleNewSession() {
  if (streaming.value) return;
  try {
    const session = await createChatSession({
      ...(defaultModelConfigId.value ? { modelConfigId: defaultModelConfigId.value } : {}),
    });
    sessionSearch.value = '';
    await loadSessions();
    await selectSession(session.id);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

/** 点「新建对话」：先弹知识来源选择器 */
async function openNewSessionPicker() {
  if (streaming.value) return;
  try {
    if (kbs.value.length === 0) kbs.value = await getKnowledgeBases();
  } catch {
    kbs.value = [];
  }
  pickerScope.value = 'all';
  pickingKbIds.value = [];
  pickerMode.value = 'create';
  showKbPicker.value = true;
}

/** 点顶部"问答范围"标签：修改当前会话的绑定（不新建会话） */
async function openEditScope() {
  if (streaming.value || !currentSessionId.value) return;
  try {
    if (kbs.value.length === 0) kbs.value = await getKnowledgeBases();
  } catch {
    kbs.value = [];
  }
  const scope = currentScope.value.map((k) => k.knowledgeBase.id);
  pickerScope.value = useKnowledgeBase.value === false ? 'none' : scope.length ? 'specific' : 'all';
  pickingKbIds.value = [...scope];
  pickerMode.value = 'edit';
  showKbPicker.value = true;
}

/** 确认：新建会话 或 修改当前会话范围 */
async function confirmCreateSession() {
  showKbPicker.value = false;
  if (streaming.value) return;
  const ids = pickerScope.value === 'specific' ? [...pickingKbIds.value] : [];
  const useKb = pickerScope.value !== 'none';
  try {
    if (pickerMode.value === 'edit' && currentSessionId.value) {
      await updateSessionKnowledgeBases(currentSessionId.value, ids, useKb);
      await loadSessions();
    } else {
      const session = await createChatSession({
        knowledgeBaseIds: ids,
        useKnowledgeBase: useKb,
        ...(defaultModelConfigId.value ? { modelConfigId: defaultModelConfigId.value } : {}),
      });
      sessionSearch.value = '';
      await loadSessions();
      await selectSession(session.id);
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function handleDeleteSession(id: string) {
  // P1-2：流式生成中的会话禁止删除（按钮已禁用，这里双保险）
  if (streaming.value && currentSessionId.value === id) return;
  if (!(await confirmDialog('删除该会话及其全部消息？此操作不可恢复。'))) return;
  try {
    await deleteChatSession(id);
    delete inputDrafts.value[id];
    delete imageDrafts.value[id];
    if (currentSessionId.value === id) {
      currentSessionId.value = null;
      messages.value = [];
    }
    await loadSessions();
    toast.success('会话已删除');
  } catch (e) {
    toast.error((e as Error).message);
  }
}

/** 导出会话为 Markdown 文件 */
async function handleExportSession(id: string) {
  try {
    const blob = await exportSessionFile(id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `会话-${id.slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// ==================== 提问与流式 ====================

const canSend = computed(
  () =>
    (input.value.trim().length > 0 ||
      pendingImages.value.length > 0 ||
      pendingFiles.value.length > 0) &&
    !streaming.value &&
    !!currentSessionId.value,
);

async function handleSend() {
  const question = input.value.trim();
  const images = [...pendingImages.value];
  const files = [...pendingFiles.value];
  if (
    (!question && images.length === 0 && files.length === 0) ||
    streaming.value ||
    !currentSessionId.value
  )
    return;
  await sendPayload(question, images, files);
}

/** 失败重试上下文：发送失败后保留原内容，供"重试"一键重发（P2-7） */
const retryDraft = ref<{
  question: string;
  images: string[];
  files: Array<{ name: string; content: string }>;
} | null>(null);
/** 最近一次乐观渲染的用户消息 id（重试前需移除，避免与后端重发重复） */
const lastOptimisticMsgId = ref<string | null>(null);

/**
 * 实际发送（输入框触发与失败重试共用）
 * @param question 纯文本问题（不含文件块；文件内容单独传，发送时拼接）
 * @param images 图片 data URL 列表
 * @param files 待拼接的文件内容列表
 * @param isRetry 是否为失败重试（重试时不移除旧的乐观消息——它已在失败处理中移除）
 */
async function sendPayload(
  question: string,
  images: string[],
  files: Array<{ name: string; content: string }>,
  isRetry = false,
) {
  const payloadImages = [...images];
  const payloadFiles = [...files];
  if (!currentSessionId.value) return;
  if (!isRetry) retryDraft.value = null; // 新发送：清掉上次的失败草稿

  // 发图提示：当前模型不支持视觉但用户配置里有视觉模型 → 后端会自动路由
  if (payloadImages.length > 0 && activeModelId.value && !VISION_RE.test(activeModelId.value)) {
    const v = modelConfigs.value.find((c) => VISION_RE.test(c.model));
    if (v) toast.info(`图片将自动使用视觉模型 ${v.model} 识别，文字对话仍用当前模型`);
  }

  // 上传文件内容拼进消息（模型据此回答）
  const fileBlock = payloadFiles.length
    ? `\n\n【上传文件内容】\n${payloadFiles.map((f) => `--- ${f.name} ---\n${f.content}`).join('\n\n')}`
    : '';
  const content = question + fileBlock;

  input.value = '';
  pendingImages.value = [];
  pendingFiles.value = [];
  error.value = '';
  streaming.value = true;
  streamContent.value = '';
  streamSources.value = { kb: [], web: [] };
  startThinkingTimer();

  // 乐观渲染：用户消息立即上屏（id 唯一，防止与历史消息 key 撞车导致图片 DOM 复用堆叠）
  const optimisticId = `local-${Date.now()}-${++localMsgSeq}`;
  lastOptimisticMsgId.value = optimisticId;
  messages.value.push({
    id: optimisticId,
    sessionId: currentSessionId.value,
    role: 'user',
    content,
    imageDataUrl: payloadImages[0] ?? null,
    imageDataUrls: payloadImages.length ? payloadImages : null,
    sources: null,
    createdAt: new Date().toISOString(),
  });

  // 发送新问题时强制滚到新问题所在位置（即使用户刚才在翻历史，也要回到最新）
  autoScroll = true;
  await nextTick();
  const el = messageContainer.value;
  if (el) el.scrollTop = el.scrollHeight;

  abortController.value = new AbortController();
  const ac = abortController.value; // P1-3：局部持有本次请求的控制器
  // 流式渲染节流：SSE token 频率远高于屏幕刷新率，每帧最多刷一次 DOM，
  // 避免每个 token 都全量跑 markdown-it + 代码高亮（长回答会卡）
  let pendingStream = '';
  let streamRaf = 0;
  const flushStream = () => {
    streamRaf = 0;
    streamContent.value = pendingStream;
  };
  try {
    await askQuestion(
      currentSessionId.value,
      content,
      useWebSearch.value,
      ac.signal,
      {
        onSources: (sources) => {
          streamSources.value = sources;
        },
        onDelta: (delta) => {
          pendingStream += delta;
          if (!streamRaf) streamRaf = requestAnimationFrame(flushStream);
        },
        onDone: () => {
          if (streamRaf) {
            cancelAnimationFrame(streamRaf);
            streamRaf = 0;
            streamContent.value = pendingStream;
          }
          // 空回答保护（服务端已兜底报错，前端双保险）：不 push 空气泡，按失败处理可重试
          if (!streamContent.value.trim()) {
            error.value = '模型未返回内容，请重试';
            retryDraft.value = { question, images: payloadImages, files: payloadFiles };
            streamContent.value = '';
            streamSources.value = { kb: [], web: [] };
            return;
          }
          messages.value.push({
            id: `local-${Date.now()}-${++localMsgSeq}`,
            sessionId: currentSessionId.value!,
            role: 'assistant',
            content: streamContent.value,
            sources: streamSources.value,
            createdAt: new Date().toISOString(),
          });
          streamContent.value = '';
          streamSources.value = { kb: [], web: [] };
          loadSessions();
        },
        onError: (message) => {
          // P2-7：失败时保留本次内容供"重试"（后端已回滚未成功的用户消息，前端可安全重发）
          error.value = message;
          retryDraft.value = { question, images: payloadImages, files: payloadFiles };
        },
      },
      payloadImages.length ? payloadImages : undefined,
    );
  } finally {
    // P1-3：Stop 后立刻重发时，旧请求的 finally 晚到不能清掉新流的控制器与状态——
    // 仅当 abortController.value 仍指向本次请求（ac）才复位
    stopThinkingTimer();
    if (abortController.value === ac) {
      streaming.value = false;
      abortController.value = null;
    }
  }
}

/** 失败"重试"：移除失败的乐观用户消息（后端已回滚，不重复），用原内容重新发送 */
async function handleRetrySend() {
  const d = retryDraft.value;
  if (!d || streaming.value) return;
  // 移除失败的乐观用户消息——后端失败时已回滚该消息，不删会残留一条假消息
  if (lastOptimisticMsgId.value) {
    messages.value = messages.value.filter((m) => m.id !== lastOptimisticMsgId.value);
    lastOptimisticMsgId.value = null;
  }
  await sendPayload(d.question, d.images, d.files, true);
}

/** 失败"放弃"：清掉草稿与失败的乐观消息 */
function handleDiscardFailed() {
  retryDraft.value = null;
  if (lastOptimisticMsgId.value) {
    messages.value = messages.value.filter((m) => m.id !== lastOptimisticMsgId.value);
    lastOptimisticMsgId.value = null;
  }
  error.value = '';
}

function handleStop() {
  abortController.value?.abort();
  // 保留已生成的部分回答：停止后把流式累积的内容落成一条 assistant 消息
  // （否则中止时 onDone 不触发，回答到一半的内容就丢了）
  if (streamContent.value.trim()) {
    messages.value.push({
      id: `local-${Date.now()}-${++localMsgSeq}`,
      sessionId: currentSessionId.value!,
      role: 'assistant',
      content: streamContent.value,
      sources: streamSources.value,
      createdAt: new Date().toISOString(),
    });
    streamContent.value = '';
    streamSources.value = { kb: [], web: [] };
  }
  streaming.value = false;
  stopThinkingTimer();
}

/** 流式生成中的回答块点击（事件委托）：代码块"复制"按钮在生成过程中也可用（P2） */
async function handleStreamClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (target.classList.contains('code-copy')) {
    const code = getCopyCode(target);
    if (code && (await copyText(code))) {
      target.textContent = '已复制';
      setTimeout(() => (target.textContent = '复制'), 1500);
    }
  }
}

/** 分支：基于该回答新建会话，预填其对应的问题 */
async function handleBranch(idx: number) {
  if (streaming.value || !currentSessionId.value) return;
  let question = '';
  const seedMessages = messages.value
    .slice(0, idx + 1)
    .map((m) => {
      const i = m.content.indexOf('【上传文件内容】');
      const head = i < 0 ? m.content : m.content.slice(0, i).trim();
      return { role: m.role as 'user' | 'assistant', content: head };
    })
    .filter((m) => m.content.trim().length > 0);
  for (let i = idx - 1; i >= 0; i--) {
    if (messages.value[i].role === 'user') {
      const head = messages.value[i].content.indexOf('【上传文件内容】');
      question =
        head < 0 ? messages.value[i].content : messages.value[i].content.slice(0, head).trim();
      break;
    }
  }
  try {
    const session = await createChatSession({
      ...(defaultModelConfigId.value ? { modelConfigId: defaultModelConfigId.value } : {}),
      ...(seedMessages.length ? { seedMessages } : {}),
    });
    sessionSearch.value = '';
    await loadSessions();
    await selectSession(session.id);
    input.value = question || '请继续分析刚才的图片/内容：';
    await nextTick();
    messageInputRef.value?.focusTextarea();
    toast.success('已基于该回答分支：新会话保留了之前的对话，可直接继续追问');
  } catch (e) {
    toast.error((e as Error).message);
  }
}

// ==================== 交互 ====================

// 自动滚动到底部：监听消息条数与流式内容变化；用户手动上滚时暂停，避免被拉回
let autoScroll = true;
/** KeepAlive 切回时恢复用的滚动位置：只在滚动事件/程序滚底时更新。
 *  注意：不要在 deactivated 里保存——此时 DOM 已脱管（scrollHeight=0），
 *  读到 0 会覆盖掉正确值，导致切回永远恢复不了（实测根因）。 */
let savedChatScrollTop = 0;
function onMessageScroll() {
  const el = messageContainer.value;
  if (!el) return;
  autoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  savedChatScrollTop = el.scrollTop; // 用户滚动时记录位置（供翻历史后切回恢复）
}
watch([() => messages.value.length, streamContent], async () => {
  if (!autoScroll) return;
  await nextTick();
  const el = messageContainer.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
    savedChatScrollTop = el.scrollTop; // 程序滚底也记录（scrollTop 赋值不触发 scroll 事件）
  }
});

// KeepAlive 缓存：从「模型配置」页新增/修改模型后返回本页时，刷新模型列表，
// 否则新绑定的模型要刷新页面才出现在模型下拉里
onActivated(async () => {
  loadModelConfigs();
  // 切回本页：KeepAlive 重插 DOM 后 scrollTop 被浏览器清 0（实测 activated 时内容完整但 top=0）。
  // 此时容器可读可写：停在底部意图（autoScroll=true）→ 滚到底；翻过历史 → 恢复记录的位置
  await nextTick();
  const el = messageContainer.value;
  if (!el) return;
  if (autoScroll) {
    el.scrollTop = el.scrollHeight;
  } else if (savedChatScrollTop > 0) {
    el.scrollTop = savedChatScrollTop;
  }
});

// 初始化：加载会话，没有就新建
onMounted(async () => {
  loadModelConfigs();
  await loadSessions();
  const saved = sessionStorage.getItem('chat-active-session');
  if (saved && sessions.value.some((s) => s.id === saved)) {
    await selectSession(saved);
  } else if (sessions.value.length > 0) {
    await selectSession(sessions.value[0].id);
  } else {
    await handleNewSession();
  }
});

// 真正卸载（登出/退出）：中止进行中的 SSE，避免后台继续消耗 token（P1-4）
onBeforeUnmount(() => {
  stopThinkingTimer();
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  abortController.value?.abort();
  abortController.value = null;
});
</script>

<template>
  <div class="relative flex h-[calc(100dvh-4rem-1px)] overflow-hidden">
    <!-- 移动端：打开会话列表时的遮罩 -->
    <div
      v-if="sidebarOpen"
      class="absolute inset-0 z-30 bg-black/40 md:hidden"
      @click="sidebarOpen = false"
    />

    <ChatSessionSidebar
      :sessions="sessions"
      :current-session-id="currentSessionId"
      :loading-sessions="loadingSessions"
      :session-search="sessionSearch"
      :sidebar-open="sidebarOpen"
      :sidebar-collapsed="sidebarCollapsed"
      :streaming="streaming"
      @update:session-search="sessionSearch = $event"
      @select="selectSession"
      @create="openNewSessionPicker"
      @delete="handleDeleteSession"
      @close-mobile="sidebarOpen = false"
      @toggle-collapse="sidebarCollapsed = !sidebarCollapsed"
    />

    <!-- 右侧：对话区 -->
    <main class="flex flex-1 flex-col">
      <!-- 会话头部：标题 + 问答范围 + 导出（显眼入口） -->
      <div
        v-if="currentSessionId"
        class="flex flex-wrap items-center gap-2 border-b bg-card/50 px-3 py-2 md:px-4"
      >
        <button
          class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
          aria-label="会话列表"
          @click="sidebarOpen = !sidebarOpen"
        >
          <Menu class="h-5 w-5" />
        </button>
        <button
          class="hidden rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:inline-flex"
          :title="sidebarCollapsed ? '展开会话列表' : '收起会话列表'"
          @click="sidebarCollapsed = !sidebarCollapsed"
        >
          <PanelLeftClose v-if="!sidebarCollapsed" class="h-4 w-4" />
          <PanelLeftOpen v-else class="h-4 w-4" />
        </button>
        <h2 class="min-w-0 flex-1 truncate text-sm font-semibold">{{ currentTitle }}</h2>
        <span
          class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
          :title="scopeTitle"
        >
          {{ scopeLabel(currentScope, useKnowledgeBase) }}
        </span>
        <Button
          variant="ghost"
          size="sm"
          title="把本次对话导出为 Markdown 文件"
          @click="handleExportSession(currentSessionId)"
        >
          <Download class="h-4 w-4" />
          导出
        </Button>
      </div>
      <!-- 消息区 -->
      <div ref="messageContainer" class="flex-1 overflow-y-auto" @scroll="onMessageScroll">
        <div
          v-if="!currentSessionId"
          class="relative flex h-full flex-col items-center justify-center text-center"
        >
          <button
            class="absolute left-3 top-3 rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
            aria-label="会话列表"
            @click="sidebarOpen = true"
          >
            <Menu class="h-5 w-5" />
          </button>
          <BookOpen class="h-12 w-12 text-muted-foreground/40" />
          <p class="mt-3 text-sm text-muted-foreground">选择或新建一个会话开始提问</p>
        </div>

        <div v-else class="mx-auto max-w-5xl space-y-6 px-4 py-6">
          <!-- 历史消息 -->
          <ChatMessageItem
            v-for="(msg, i) in messages"
            :key="msg.id"
            :msg="msg"
            :index="i"
            :use-knowledge-base="useKnowledgeBase"
            @branch="handleBranch"
            @open-source="openSource"
            @preview-file="filePreview = $event"
          />

          <!-- 流式回答中 -->
          <div v-if="streaming" class="flex justify-start">
            <div class="w-full">
              <!-- 等待首个 token：蓝色文字 + 白色光条从左到右扫过（循环）+ 右侧计时 -->
              <ChatThinkingBar v-if="!streamContent" :thinking-seconds="thinkingSeconds" />
              <div
                v-else
                class="markdown-body px-1"
                @click="handleStreamClick"
                v-html="renderMarkdown(streamContent)"
              />
              <div
                v-if="streamSources.kb.length || streamSources.web.length"
                class="mt-2 text-xs text-muted-foreground"
              >
                已检索到知识库 {{ streamSources.kb.length }} 条
                <template v-if="streamSources.web.length">
                  + 网络 {{ streamSources.web.length }} 条</template
                >，正在生成回答
              </div>
            </div>
          </div>

          <!-- 错误提示（P2-7：附 重试/放弃，发送失败内容不丢） -->
          <div
            v-if="error"
            class="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            <span class="min-w-0 flex-1">{{ error }}</span>
            <Button
              v-if="retryDraft"
              variant="default"
              size="sm"
              :disabled="streaming"
              @click="handleRetrySend"
            >
              <RefreshCw class="mr-1 h-3.5 w-3.5" />
              重试
            </Button>
            <Button
              v-if="retryDraft"
              variant="ghost"
              size="sm"
              :disabled="streaming"
              @click="handleDiscardFailed"
            >
              放弃
            </Button>
          </div>
        </div>
      </div>

      <!-- 输入区 -->
      <ChatMessageInput
        ref="messageInputRef"
        v-model:input="input"
        :model-configs="modelConfigs"
        :current-model-name="currentModelName"
        :current-reasoning="currentReasoning"
        :session-model-config-id="currentSession?.modelConfigId ?? null"
        :session-model="currentSession?.model ?? null"
        :streaming="streaming"
        :can-send="canSend"
        :current-session-id="currentSessionId"
        :use-web-search="useWebSearch"
        :input-hint="inputHint"
        :scope-label="scopeLabel(currentScope, useKnowledgeBase)"
        :scope-title="scopeTitle"
        :pending-images="pendingImages"
        :pending-files="pendingFiles"
        @update:use-web-search="useWebSearch = $event"
        @send="handleSend"
        @stop="handleStop"
        @open-edit-scope="openEditScope"
        @select-model="selectModel"
        @set-reasoning="setReasoningEffort"
        @remove-image="removeImage"
        @remove-file="removeFile"
        @preview-file="filePreview = $event"
        @pick-image="onPickImage"
        @pick-file="onPickFile"
        @paste="onPasteImage"
      />
    </main>

    <!-- 新建对话：选择问答范围（知识库）弹窗 -->
    <ChatKbPickerModal
      v-if="showKbPicker"
      :kbs="kbs"
      :mode="pickerMode"
      :scope="pickerScope"
      :picking-kb-ids="pickingKbIds"
      :can-submit="canSubmitPicker"
      @close="showKbPicker = false"
      @set-scope="setPickerScope"
      @toggle-kb="toggleKb"
      @confirm="confirmCreateSession"
    />

    <!-- 文档预览抽屉：点击引用来源定位到原文文本块 -->
    <DocPreviewDrawer
      :document-id="previewDocId"
      :highlight-chunk-index="previewChunkIndex"
      @close="
        previewDocId = null;
        previewChunkIndex = null;
      "
    />

    <!-- 上传文件内容预览：右侧弹出，占一半宽度（点击输入框中的文件 chip 打开） -->
    <div
      v-if="filePreview"
      class="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-card shadow-2xl sm:w-1/2"
    >
      <div class="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <p class="min-w-0 truncate text-sm font-semibold">
          <FileText class="mr-1.5 inline h-4 w-4 text-muted-foreground" />
          {{ filePreview.name }}
        </p>
        <button
          class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="关闭预览"
          @click="filePreview = null"
        >
          <X class="h-4 w-4" />
        </button>
      </div>
      <pre
        class="hide-scrollbar flex-1 overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed text-foreground"
        >{{ filePreview.content }}</pre>
    </div>
  </div>
</template>

<style scoped>
/* 隐藏碍眼的滚动条（保留滚动功能） */
.hide-scrollbar {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.hide-scrollbar::-webkit-scrollbar {
  display: none;
}
</style>
