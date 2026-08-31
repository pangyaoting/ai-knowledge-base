<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import {
  MessageSquare,
  Plus,
  Send,
  Square,
  Trash2,
  Loader2,
  BookOpen,
  Database,
  Download,
  Menu,
  Search,
  Cpu,
  X,
  ImagePlus,
  FileText,
  Copy,
  GitBranch,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import DocPreviewDrawer from '@/components/DocPreviewDrawer.vue';
import ListSkeleton from '@/components/skeletons/ListSkeleton.vue';
import { toast } from '@/composables/useToast';
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
import { getKnowledgeBases } from '@/api/knowledge';
import { getModelConfigs } from '@/api/model-configs';
import type { KnowledgeBase } from '@/types/knowledge';
import type { ModelConfig } from '@/types/model-config';
import type {
  ChatSession,
  ChatMessage,
  ChatSources,
  RetrievalSource,
  WebSource,
} from '@/types/chat';

// ==================== 状态 ====================
const sessions = ref<ChatSession[]>([]);
const currentSessionId = ref<string | null>(null);
const messages = ref<ChatMessage[]>([]);

const input = ref('');
/** 每个会话独立的输入草稿：切换会话时保存/恢复，不串台也不丢失 */
const inputDrafts = ref<Record<string, string>>({});
const imageDrafts = ref<Record<string, string[]>>({});

// ==================== 图片（粘贴 / 上传，最多 6 张，压缩后进消息） ====================
const MAX_IMAGES = 9;
const pendingImages = ref<string[]>([]);

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

// ==================== 上传本地图片（选择文件，可多选，与粘贴同一压缩链路） ====================
const imageInput = ref<HTMLInputElement | null>(null);

async function onPickImage(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  if (!files.length) return;
  try {
    const imgs = await Promise.all(files.map(compressImage));
    const room = MAX_IMAGES - pendingImages.value.length;
    pendingImages.value.push(...imgs.slice(0, Math.max(0, room)));
    if (imgs.length > room) toast.info(`一次最多 ${MAX_IMAGES} 张图片`);
  } catch (err) {
    toast.error((err as Error).message);
  } finally {
    input.value = '';
  }
}
// ==================== 上传文件（文本/代码/PDF/Word，提取内容后随消息发送） ====================
const MAX_FILES = 5;
const pendingFiles = ref<Array<{ name: string; content: string }>>([]);
const fileInput = ref<HTMLInputElement | null>(null);

async function onPickFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  input.value = '';
  for (const f of files) {
    if (pendingFiles.value.length >= MAX_FILES) {
      toast.info(`一次最多 ${MAX_FILES} 个文件`);
      break;
    }
    try {
      const res = await extractFileText(f);
      pendingFiles.value.push({ name: res.filename, content: res.content });
    } catch (err) {
      toast.error(`${f.name}：${(err as Error).message}`);
    }
  }
}

function removeFile(i: number) {
  pendingFiles.value.splice(i, 1);
}

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

/** 分支：基于该回答新建会话，预填其对应的问题，方便换个角度继续追问 */
async function handleBranch(idx: number) {
  if (streaming.value || !currentSessionId.value) return;
  let question = '';
  // 分支点之前的对话作为历史注入新会话（LLM 能读到前文，继续追问有上下文）
  const seedMessages = messages.value
    .slice(0, idx)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: msgHead(m) }))
    .filter((m) => m.content.trim().length > 0);
  for (let i = idx - 1; i >= 0; i--) {
    if (messages.value[i].role === 'user') {
      question = msgHead(messages.value[i]);
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
    // 预填对应问题（纯图片消息没有文字时给个引导），并聚焦输入框
    input.value = question || '请继续分析刚才的图片/内容：';
    await nextTick();
    messageTextarea.value?.focus();
    toast.success('已基于该回答分支：新会话保留了之前的对话，可直接继续追问');
  } catch (e) {
    toast.error((e as Error).message);
  }
}
/** 右侧文件内容预览面板（点击输入框中的文件 chip 打开） */
const filePreview = ref<{ name: string; content: string } | null>(null);
const messageTextarea = ref<HTMLTextAreaElement | null>(null);
const streaming = ref(false);
const error = ref('');
const loadingSessions = ref(false);
const useWebSearch = ref(false); // 联网检索开关
const sidebarOpen = ref(false); // 移动端：会话列表抽屉开关
const sidebarCollapsed = ref(false); // 桌面端：会话列表侧边栏收起/展开
const sessionSearch = ref(''); // 会话搜索关键词（标题/消息内容全文检索）
let searchTimer: ReturnType<typeof setTimeout> | null = null;

// 模型配置（BYO 大模型 API）：会话可选用户自带的 key
const modelConfigs = ref<ModelConfig[]>([]);
const modelDropdownOpen = ref(false);
/** 下拉定位（fixed，视口内自适应：底部空间不足向上弹、右侧不足左移） */
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
    // 下拉含「选择模型」+「推理等级」两个分区（3 个等级 + 标题/分隔 ≈ 150px），估算要算进去
    const h = Math.min(400, modelConfigs.value.length * itemH + 190);
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
const defaultModelConfigId = computed(
  () => modelConfigs.value.find((c) => c.isDefault)?.id ?? null,
);

/** 视觉模型名启发式（与后端一致）：vision / VL / 4V / Omni / GLM-4V 等 */
const VISION_RE = /vision|[-/]vl\b|vl[-.\d]|4v|omni|glm-4v|internvl|minicpm/i;

/** 当前会话实际使用的模型 ID（会话绑定 → 默认配置；用于发图时判断是否会自动路由） */
const activeModelId = computed(() => {
  const sid = currentSession.value?.modelConfigId;
  if (sid) return modelConfigs.value.find((c) => c.id === sid)?.model ?? null;
  return modelConfigs.value.find((c) => c.isDefault)?.model ?? null;
});

/** 当前会话使用的模型名（未绑定 = 跟随默认配置，直接显示默认配置名） */
const currentModelName = computed(() => {
  const bound = currentSession.value?.modelConfig;
  if (bound) return bound.name;
  return modelConfigs.value.find((c) => c.isDefault)?.name ?? '未绑定模型';
});

async function loadModelConfigs() {
  try {
    modelConfigs.value = await getModelConfigs();
  } catch {
    modelConfigs.value = [];
  }
}

/** 切换当前会话的模型配置（null = 跟随用户默认配置）；保持下拉打开，可继续调推理等级 */
async function selectModel(id: string | null) {
  if (!currentSessionId.value) return;
  try {
    await updateSessionModel(currentSessionId.value, id);
    await loadSessions();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// ===== 推理等级（低≈关闭 / 高 / 最高）=====
const REASONING_OPTIONS: Array<{ value: string; label: string; desc: string }> = [
  { value: 'low', label: '关闭', desc: '最低推理 · 最快最省' },
  { value: 'high', label: '高', desc: '深度思考 · 更准确' },
  { value: 'max', label: '最高', desc: '最强推理 · 最贵最慢' },
];
const currentReasoning = computed(() => currentSession.value?.reasoningEffort ?? null);

async function setReasoningEffort(effort: string | null) {
  if (!currentSessionId.value) return;
  try {
    await updateSessionModel(
      currentSessionId.value,
      currentSession.value?.modelConfigId ?? null,
      effort,
    );
    await loadSessions();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// 新建会话时选择问答来源：三种模式
// none = 不使用知识库（纯对话）/ all = 全部知识库 / specific = 指定若干库
const kbs = ref<KnowledgeBase[]>([]);
const showKbPicker = ref(false);
const pickerMode = ref<'create' | 'edit'>('create'); // create=新建会话 / edit=修改当前会话范围
const pickerScope = ref<'none' | 'all' | 'specific'>('all');
const pickingKbIds = ref<string[]>([]);

/** 知识库勾选态：全部模式全显示已勾选；纯对话模式全不勾；指定模式按勾选 */
function kbChecked(id: string): boolean {
  if (pickerScope.value === 'all') return true;
  if (pickerScope.value === 'specific') return pickingKbIds.value.includes(id);
  return false;
}

/** 切换模式（radio 互斥）；勾选具体库会自动切到"指定"模式 */
function setPickerScope(scope: 'none' | 'all' | 'specific') {
  pickerScope.value = scope;
}

function toggleKb(id: string) {
  if (pickerScope.value === 'all') {
    // 在"全部"模式下取消某个库 → 切到"指定"模式，勾选其余全部（与"全部已勾选"的视觉一致）
    pickerScope.value = 'specific';
    pickingKbIds.value = kbs.value.map((k) => k.id).filter((x) => x !== id);
    return;
  }
  if (pickerScope.value !== 'specific') {
    // 从"不使用"模式勾选某个库 → 切到"指定"模式
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

/** 会话绑定知识库的展示名（最多显示 2 个，多了折叠成"等N个"） */
function kbNames(bound: ChatSession['knowledgeBases']): string {
  const names = bound.map((k) => k.knowledgeBase.name);
  if (names.length <= 2) return names.join('、');
  return `${names.slice(0, 2).join('、')} 等${names.length}个`;
}

/** 范围标签：纯聊天 / 全部知识库 / 指定库名 */
function scopeLabel(bound: ChatSession['knowledgeBases'], useKb: boolean): string {
  if (!useKb) return '纯聊天';
  if (bound.length) return kbNames(bound);
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
  try {
    messages.value = await getChatMessages(id);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function handleNewSession() {
  if (streaming.value) return;
  try {
    // 默认用用户配置的默认模型（BYO key）
    const session = await createChatSession({
      ...(defaultModelConfigId.value ? { modelConfigId: defaultModelConfigId.value } : {}),
    });
    sessionSearch.value = ''; // 清掉搜索，保证新会话可见
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
  pickerScope.value = 'all'; // 默认全部知识库
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

/** 确认：新建会话 或 修改当前会话范围（none=纯对话 / all=全部 / specific=指定库） */
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
      sessionSearch.value = ''; // 清掉搜索，保证新会话可见
      await loadSessions();
      await selectSession(session.id);
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function handleDeleteSession(id: string) {
  // eslint-disable-next-line no-alert
  if (!window.confirm('删除该会话及其全部消息？')) return;
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

  // 发图提示：当前模型不支持视觉但用户配置里有视觉模型 → 后端会自动路由（对话仍用当前模型）
  if (images.length > 0 && activeModelId.value && !VISION_RE.test(activeModelId.value)) {
    const v = modelConfigs.value.find((c) => VISION_RE.test(c.model));
    if (v) toast.info(`图片将自动使用视觉模型 ${v.model} 识别，文字对话仍用当前模型`);
  }

  // 上传文件内容拼进消息（模型据此回答）
  const fileBlock = files.length
    ? `\n\n【上传文件内容】\n${files.map((f) => `--- ${f.name} ---\n${f.content}`).join('\n\n')}`
    : '';
  const content = question + fileBlock;

  input.value = '';
  pendingImages.value = [];
  pendingFiles.value = [];
  error.value = '';
  streaming.value = true;
  streamContent.value = '';
  streamSources.value = { kb: [], web: [] };

  // 乐观渲染：用户消息立即上屏
  messages.value.push({
    id: `local-${Date.now()}`,
    sessionId: currentSessionId.value,
    role: 'user',
    content,
    imageDataUrl: images[0] ?? null,
    imageDataUrls: images.length ? images : null,
    sources: null,
    createdAt: new Date().toISOString(),
  });

  abortController.value = new AbortController();
  try {
    await askQuestion(
      currentSessionId.value,
      content,
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
      images.length ? images : undefined,
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
  loadModelConfigs(); // 模型下拉选项（BYO key）
  await loadSessions();
  // 优先恢复上次的会话（切导航再回来仍在旧会话）；不存在则选第一个
  const saved = sessionStorage.getItem('chat-active-session');
  if (saved && sessions.value.some((s) => s.id === saved)) {
    await selectSession(saved);
  } else if (sessions.value.length > 0) {
    await selectSession(sessions.value[0].id);
  } else {
    await handleNewSession();
  }
});

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function similarityPercent(s: number | null): string {
  return s == null ? '相关' : `${Math.round(s * 100)}%`;
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
  <div class="relative flex h-[calc(100dvh-4rem-1px)] overflow-hidden">
    <!-- 移动端：打开会话列表时的遮罩 -->
    <div
      v-if="sidebarOpen"
      class="absolute inset-0 z-30 bg-black/40 md:hidden"
      @click="sidebarOpen = false"
    />

    <!-- 左侧：会话列表（移动端默认收起，从左侧滑出） -->
    <aside
      class="absolute inset-y-0 left-0 z-40 flex w-64 -translate-x-full flex-col border-r bg-card/50 shadow-xl transition-all duration-200 md:static md:z-auto md:translate-x-0 md:shadow-none"
      :class="[
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        sidebarCollapsed ? 'md:w-0 md:overflow-hidden md:border-r-0' : 'md:w-64',
      ]"
    >
      <div class="p-3">
        <Button class="w-full" @click="openNewSessionPicker">
          <Plus class="h-4 w-4" />
          新建对话
        </Button>
      </div>
      <!-- 会话搜索（标题/消息内容全文检索） -->
      <div class="px-3 pb-2">
        <div class="relative">
          <Search
            class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            v-model="sessionSearch"
            type="text"
            placeholder="搜索会话（标题/内容）"
            class="h-8 pl-8 text-xs"
          />
        </div>
      </div>
      <div class="flex-1 overflow-y-auto px-2 pb-2">
        <div v-if="loadingSessions" class="py-2">
          <ListSkeleton :rows="8" />
        </div>
        <p
          v-else-if="sessionSearch.trim() && sessions.length === 0"
          class="py-8 text-center text-xs text-muted-foreground"
        >
          没有匹配的会话，换个关键词试试
        </p>
        <div
          v-for="s in sessions"
          :key="s.id"
          role="button"
          tabindex="0"
          class="mb-1 flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm transition-colors"
          :class="
            s.id === currentSessionId
              ? 'bg-primary/10 text-primary'
              : 'hover:bg-accent text-foreground'
          "
          @click="selectSession(s.id)"
          @keydown.enter="selectSession(s.id)"
        >
          <MessageSquare class="h-4 w-4 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate">{{ s.title }}</span>
          <span
            v-if="s.useKnowledgeBase === false"
            class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            title="纯对话模式，不检索知识库"
          >
            纯聊天
          </span>
          <span
            v-else-if="s.knowledgeBases.length"
            class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            :title="'问答范围：' + s.knowledgeBases.map((k) => k.knowledgeBase.name).join('、')"
          >
            {{ kbNames(s.knowledgeBases) }}
          </span>
          <span class="shrink-0 text-xs text-muted-foreground">{{ s._count?.messages ?? 0 }}</span>
          <button
            class="shrink-0 rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:opacity-100 hover:text-destructive"
            title="删除会话"
            @click.stop="handleDeleteSession(s.id)"
          >
            <Trash2 class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>

    <!-- 右侧：对话区 -->
    <main class="flex flex-1 flex-col">
      <!-- 会话头部：标题 + 问答范围 + 导出（显眼入口） -->
      <div
        v-if="currentSessionId"
        class="flex flex-wrap items-center gap-2 border-b bg-card/50 px-3 py-2 md:px-4"
      >
        <!-- 移动端：会话列表开关 -->
        <button
          class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
          aria-label="会话列表"
          @click="sidebarOpen = !sidebarOpen"
        >
          <Menu class="h-5 w-5" />
        </button>
        <!-- 桌面端：收起/展开会话列表侧边栏 -->
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
      <div ref="messageContainer" class="flex-1 overflow-y-auto">
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
          <div
            v-for="(msg, i) in messages"
            :key="i"
            class="group flex"
            :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
          >
            <div
              :class="
                msg.role === 'user' ? 'ml-auto flex w-fit max-w-[80%] flex-col items-end' : 'w-full'
              "
            >
              <!-- 用户消息：图片/文件独立展示在气泡外，文字用中性气泡 -->
              <template v-if="msg.role === 'user'">
                <div
                  v-if="msg.imageDataUrls?.length"
                  class="mb-1.5 grid max-w-[360px] gap-1.5"
                  :class="msg.imageDataUrls.length > 1 ? 'grid-cols-2' : ''"
                >
                  <img
                    v-for="(u, i) in msg.imageDataUrls"
                    :key="i"
                    :src="u"
                    class="max-h-48 w-full rounded-md object-cover"
                    :class="msg.imageDataUrls.length === 1 ? 'max-w-[280px]' : ''"
                    alt="图片"
                  />
                </div>
                <img
                  v-else-if="msg.imageDataUrl"
                  :src="msg.imageDataUrl"
                  class="mb-1.5 max-h-48 rounded-md object-cover"
                  alt="粘贴图片"
                />
                <div v-if="msgFiles(msg).length" class="mb-1.5 flex flex-wrap gap-1.5">
                  <button
                    v-for="(f, fi) in msgFiles(msg)"
                    :key="fi"
                    class="flex cursor-pointer items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs transition-colors hover:bg-accent"
                    title="点击在右侧查看文件内容"
                    @click="filePreview = f"
                  >
                    <FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span class="max-w-[200px] truncate">{{ f.name }}</span>
                  </button>
                </div>
                <div
                  v-if="msgHead(msg)"
                  class="inline-block max-w-full whitespace-pre-wrap rounded-2xl rounded-br-sm bg-muted px-4 py-2.5 text-[18px] text-foreground"
                >
                  {{ msgHead(msg) }}
                </div>
              </template>
              <!-- 助手消息：Markdown -->
              <div
                v-else
                class="markdown-body px-1"
                @click="handleMessageClick"
                v-html="renderMarkdown(msg.content)"
              />
              <!-- 操作条：复制（提问/回答）+ 分支（回答）；一直显示，提问右对齐 -->
              <div
                class="mt-1.5 flex items-center gap-1"
                :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
              >
                <button
                  class="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  title="复制整条消息"
                  @click="copyMessage(msg)"
                >
                  <Copy class="h-3.5 w-3.5" />
                  复制
                </button>
                <button
                  v-if="msg.role === 'assistant'"
                  class="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  title="基于这条回答新建会话，换个角度继续提问"
                  @click="handleBranch(i)"
                >
                  <GitBranch class="h-3.5 w-3.5" />
                  分支
                </button>
              </div>

              <!-- 知识库模式但没有任何引用：回答来自模型自身知识，明示来源 -->
              <p
                v-if="
                  msg.role === 'assistant' &&
                  msg.sources &&
                  sourcesKb(msg.sources).length === 0 &&
                  sourcesWeb(msg.sources).length === 0 &&
                  useKnowledgeBase
                "
                class="mt-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
              >
                ⚠️ 未检索到知识库资料，以上回答基于模型自身知识（可在知识库补充相关文档后重问）
              </p>

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
                    <template v-if="sourcesWeb(msg.sources).length">
                      · 网络 {{ sourcesWeb(msg.sources).length }} 条</template
                    >）
                  </summary>

                  <!-- 知识库来源（点击可定位到原文文本块） -->
                  <div v-if="sourcesKb(msg.sources).length" class="mt-2">
                    <p class="font-medium text-muted-foreground">📚 知识库</p>
                    <ul class="mt-1.5 space-y-1.5">
                      <li
                        v-for="(src, si) in sourcesKb(msg.sources)"
                        :key="'kb-' + si"
                        class="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent/60"
                        :title="'点击定位到原文第 ' + (src.chunkIndex + 1) + ' 段'"
                        @click="openSource(src)"
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
                    <p class="mt-1.5 text-[11px] text-muted-foreground/70">
                      💡 点击来源可定位到文档原文位置
                    </p>
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
                        <span
                          class="mt-0.5 shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-600"
                        >
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

              <div
                v-if="msg.role === 'user'"
                class="mt-1 text-right text-[11px] text-muted-foreground"
              >
                {{ formatTime(msg.createdAt) }}
              </div>
            </div>
          </div>

          <!-- 流式回答中 -->
          <div v-if="streaming" class="flex justify-start">
            <div class="w-full">
              <div
                class="markdown-body px-1"
                @click="handleMessageClick"
                v-html="renderMarkdown(streamContent || '…')"
              />
              <div
                v-if="streamSources.kb.length || streamSources.web.length"
                class="mt-2 text-xs text-muted-foreground"
              >
                已检索到知识库 {{ streamSources.kb.length }} 条
                <template v-if="streamSources.web.length">
                  + 网络 {{ streamSources.web.length }} 条</template
                >，正在生成回答...
              </div>
            </div>
          </div>

          <!-- 错误提示 -->
          <p
            v-if="error"
            class="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {{ error }}
          </p>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="border-t bg-card/50 p-4">
        <!-- 问答范围（常驻可见，点击可修改当前会话） -->
        <div
          v-if="currentSessionId"
          class="mx-auto mb-2 flex max-w-5xl items-center gap-2 text-[11px]"
        >
          <span class="shrink-0 text-muted-foreground">问答范围</span>
          <button
            class="inline-flex max-w-[65%] items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs text-foreground transition-colors hover:bg-muted"
            :title="scopeTitle"
            @click="openEditScope"
          >
            <Database class="h-3 w-3 shrink-0 text-muted-foreground" />
            <span class="truncate">{{ scopeLabel(currentScope, useKnowledgeBase) }}</span>
            <span class="shrink-0 text-muted-foreground">修改</span>
          </button>

          <!-- 模型选择（BYO 大模型 API：会话绑定 / 默认配置） -->
          <span class="shrink-0 text-muted-foreground">模型</span>
          <div class="relative">
            <button
              ref="modelBtnRef"
              class="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs text-foreground transition-colors hover:bg-muted"
              :class="
                modelConfigs.length === 0
                  ? 'border-destructive/40 bg-destructive/5 text-destructive'
                  : 'border bg-muted/40'
              "
              :title="'当前模型：' + currentModelName + '（点击切换，Token 按所选模型计费）'"
              @click="toggleModelDropdown"
            >
              <Cpu class="h-3 w-3 shrink-0 text-muted-foreground" />
              <span class="max-w-[140px] truncate">{{ currentModelName }}</span>
            </button>
            <!-- 下拉面板：fixed 定位，视口内自适应（底部空间不足时向上弹） -->
            <div
              v-if="modelDropdownOpen"
              ref="modelDropdownRef"
              class="fixed z-50 max-h-[70vh] w-60 overflow-y-auto rounded-lg border bg-card py-1 shadow-lg"
              :style="{ top: modelDropdownPos.top + 'px', left: modelDropdownPos.left + 'px' }"
              @click.stop
            >
              <p v-if="modelConfigs.length === 0" class="px-3 py-2 text-xs text-muted-foreground">
                还没有绑定任何模型 Key，AI 功能无法使用。
              </p>
              <RouterLink
                v-if="modelConfigs.length === 0"
                to="/model-configs"
                class="flex items-center gap-1 px-3 py-2 text-xs font-medium text-primary hover:underline"
                @click="modelDropdownOpen = false"
              >
                去「模型配置」绑定自己的 API Key →
              </RouterLink>
              <template v-else>
                <p class="px-3 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">选择模型</p>
                <button
                  v-for="c in modelConfigs"
                  :key="c.id"
                  class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                  :class="currentSession?.modelConfigId === c.id ? 'text-primary' : ''"
                  @click="selectModel(c.id)"
                >
                  <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
                  <span class="shrink-0 text-xs text-muted-foreground">{{ c.model }}</span>
                  <span v-if="currentSession?.modelConfigId === c.id" class="shrink-0 text-xs"
                    >✓</span
                  >
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
                  :class="currentReasoning === e.value ? 'text-primary' : ''"
                  @click="setReasoningEffort(e.value)"
                >
                  <span>{{ e.label }}</span>
                  <span class="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
                    {{ e.desc }}
                  </span>
                  <span v-if="currentReasoning === e.value" class="shrink-0 text-xs">✓</span>
                </button>
              </template>
            </div>
          </div>
        </div>
        <!-- 待发送图片/文件预览：在输入框上方横排展示（有图片或文件时显示） -->
        <div
          v-if="pendingImages.length || pendingFiles.length"
          class="mx-auto mb-2 flex max-w-5xl items-center gap-2 overflow-x-auto pb-1"
        >
          <div v-for="(img, i) in pendingImages" :key="i" class="relative shrink-0">
            <img
              :src="img"
              class="h-20 w-20 rounded-md border border-primary/40 object-cover"
              alt="待发送图片"
            />
            <button
              class="absolute right-1 top-1 rounded-full bg-destructive/90 p-0.5 text-white shadow"
              title="移除这张图片"
              @click="removeImage(i)"
            >
              <X class="h-3 w-3" />
            </button>
          </div>
          <p class="flex items-center text-[11px] text-muted-foreground">
            {{ pendingImages.length }}/9
          </p>
          <div
            v-for="(f, i) in pendingFiles"
            :key="'file-' + i"
            class="group relative flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs transition-colors hover:bg-accent"
            title="点击在右侧查看文件内容"
            @click="filePreview = f"
          >
            <FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span class="max-w-[140px] truncate">{{ f.name }}</span>
            <button
              class="rounded p-0.5 text-muted-foreground opacity-60 transition-colors hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
              title="移除这个文件"
              @click.stop="removeFile(i)"
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
            @change="onPickImage"
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
            @change="onPickFile"
          />
          <textarea
            ref="messageTextarea"
            v-model="input"
            rows="1"
            class="max-h-40 min-h-[44px] flex-1 resize-y rounded-md border border-input bg-background px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="输入问题，Enter 发送，Shift+Enter 换行；可粘贴图片（需视觉模型识别）"
            :disabled="!currentSessionId"
            @keydown.enter.exact.prevent="handleSend"
            @paste="onPasteImage"
          />
          <Button v-if="!streaming" :disabled="!canSend" @click="handleSend">
            <Send class="h-4 w-4" />
            发送
          </Button>
          <Button v-else variant="destructive" @click="handleStop">
            <Square class="h-4 w-4" />
            停止
          </Button>
        </div>
        <p
          class="mx-auto mt-2 flex max-w-5xl items-center justify-center gap-4 text-[11px] text-muted-foreground"
        >
          <label class="flex cursor-pointer items-center gap-1.5 select-none">
            <input
              v-model="useWebSearch"
              type="checkbox"
              class="h-3.5 w-3.5 rounded border-input"
              :disabled="streaming"
            />
            <span :class="{ 'text-primary': useWebSearch }">🌐 联网检索</span>
          </label>
          <span>{{ inputHint }}</span>
        </p>
      </div>
    </main>

    <!-- 新建对话：选择问答范围（知识库）弹窗 -->
    <div
      v-if="showKbPicker"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="showKbPicker = false"
    >
      <div class="w-full max-w-md rounded-lg border bg-card p-5 shadow-xl">
        <h3 class="text-base font-semibold">
          {{ pickerMode === 'create' ? '新建对话' : '修改问答范围' }}
        </h3>
        <p class="mt-1 text-xs text-muted-foreground">
          {{
            pickerMode === 'create'
              ? '选择本次问答的知识来源（可随时修改）'
              : '修改后立即生效，之后的问题按新范围检索'
          }}
        </p>
        <div class="mt-4 max-h-72 space-y-1.5 overflow-y-auto">
          <!-- 模式：不使用知识库（纯对话） -->
          <label
            class="flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm transition-colors hover:bg-accent"
            :class="pickerScope === 'none' ? 'border-primary' : ''"
          >
            <input
              type="radio"
              class="h-3.5 w-3.5"
              :checked="pickerScope === 'none'"
              @change="setPickerScope('none')"
            />
            <span class="font-medium">不使用知识库</span>
            <span class="ml-auto text-xs text-muted-foreground">纯对话，不检索资料</span>
          </label>
          <!-- 模式：全部知识库 -->
          <label
            class="flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm transition-colors hover:bg-accent"
            :class="pickerScope === 'all' ? 'border-primary' : ''"
          >
            <input
              type="radio"
              class="h-3.5 w-3.5"
              :checked="pickerScope === 'all'"
              @change="setPickerScope('all')"
            />
            <span class="font-medium">全部知识库</span>
            <span class="ml-auto text-xs text-muted-foreground">搜索你所有知识库</span>
          </label>

          <p v-if="kbs.length" class="px-1 pt-2 text-xs text-muted-foreground">
            或勾选指定知识库（点击即切换到指定模式）：
          </p>
          <label
            v-for="kb in kbs"
            :key="kb.id"
            class="flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm transition-colors hover:bg-accent"
            :class="kbChecked(kb.id) ? 'border-primary' : ''"
          >
            <input
              type="checkbox"
              class="h-3.5 w-3.5"
              :checked="kbChecked(kb.id)"
              @change="toggleKb(kb.id)"
            />
            <span class="min-w-0 flex-1 truncate font-medium">{{ kb.name }}</span>
            <span class="ml-2 shrink-0 text-xs text-muted-foreground">
              {{ kb._count?.documents ?? 0 }} 个文档
            </span>
          </label>
          <p v-if="kbs.length === 0" class="py-4 text-center text-xs text-muted-foreground">
            还没有知识库，可先选「不使用知识库」开始纯对话，或去「知识库」页上传文档
          </p>
          <p
            v-if="pickerScope === 'specific' && pickingKbIds.length === 0"
            class="py-2 text-center text-xs text-destructive"
          >
            请至少勾选一个知识库，或改用「全部知识库 / 不使用知识库」
          </p>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="showKbPicker = false">取消</Button>
          <Button size="sm" :disabled="!canSubmitPicker" @click="confirmCreateSession">
            {{ pickerMode === 'create' ? '开始对话' : '保存修改' }}
          </Button>
        </div>
      </div>
    </div>

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

/* AI 回答的 Markdown 排版（无白色卡片背景，直接铺在页面背景上；暗黑可读）
   正文只放大不加粗；标题按等级加粗 + 大小 */
.markdown-body {
  font-size: 1.25rem;
  font-weight: 400;
  color: var(--foreground);
}
/* 宽屏布局：字号再大一档 */

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  font-weight: 700;
  line-height: 1.3;
  margin: 0.75em 0 0.4em;
}
.markdown-body :deep(h1) {
  font-size: 1.5em;
  font-weight: 700;
}
.markdown-body :deep(h2) {
  font-size: 1.32em;
  font-weight: 700;
}
.markdown-body :deep(h3) {
  font-size: 1.16em;
  font-weight: 700;
}
.markdown-body :deep(h4) {
  font-size: 1.05em;
  font-weight: 600;
}
.markdown-body :deep(p) {
  margin: 0.5em 0;
  line-height: 1.8;
  font-size: 1.25rem;
  font-weight: 400;
}
.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.5em;
}
.markdown-body :deep(li) {
  margin: 0.25em 0;
}
.markdown-body :deep(a) {
  color: var(--primary);
  text-decoration: underline;
}
.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--border);
  padding-left: 0.75em;
  color: hsl(var(--foreground) / 0.72);
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
  background: hsl(var(--muted));
  border-radius: 4px;
  padding: 0.1em 0.35em;
  font-size: 0.95em;
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
  font-size: 0.95em;
  line-height: 1.6;
  background: hsl(var(--muted));
  color: var(--foreground);
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
