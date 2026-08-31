<script setup lang="ts">
/**
 * 文档管理页（知识库内）
 *
 * 交互设计（参考 Cherry）：
 * - 选择文件/目录即自动上传，不先列出待传文件（目录几百上千个文件时无需滚动确认）
 * - 上传/解析用环形百分比进度提示，列表后台自动刷新（自适应轮询）
 * - 文件图标按扩展名着色 + 扩展名徽标（区分 html/css/ts/vue…）
 * - 支持代码文件参与检索、图片等作为附件保管；自动跳过 node_modules/.git/dist 与 .env
 */
defineOptions({ name: 'KnowledgeDocumentsView' });
import { ref, computed, reactive, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft, RefreshCw, FolderOpen, FolderTree, Search } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import DocCodeEditor from '@/components/knowledge/DocCodeEditor.vue';
import DocTableRow from '@/components/knowledge/DocTableRow.vue';
import { toast } from '@/composables/useToast';
import {
  getDocuments,
  uploadDocument,
  deleteDocument,
  downloadDocumentFile,
  updateDocument,
} from '@/api/knowledge';
import {
  buildDocTree,
  flattenTree,
  countFolders,
  collectFolderFiles,
  type DocTreeNode,
} from '@/utils/doc-tree';
import type { Document } from '@/types/knowledge';

const route = useRoute();
const router = useRouter();
const knowledgeBaseId = route.params.id as string;

const list = ref<Document[]>([]);
const loading = ref(false);
const docSearch = ref(''); // 文档搜索（本地过滤）

/** 按文件名过滤文档（即时响应） */
const filteredDocs = computed(() => {
  const q = docSearch.value.trim().toLowerCase();
  if (!q) return list.value;
  return list.value.filter((d) => d.filename.toLowerCase().includes(q));
});

// ==================== 目录树 ====================

const tree = computed(() => buildDocTree(list.value));

/** 展开状态放 reactive Set（computed 每次重建树，放 Set 里才响应） */
const expandedPaths = reactive(new Set<string>());

function isExpanded(node: DocTreeNode): boolean {
  return expandedPaths.has(node.path);
}

function toggleFolder(node: DocTreeNode) {
  if (expandedPaths.has(node.path)) expandedPaths.delete(node.path);
  else expandedPaths.add(node.path);
}

function toggleAll(expand: boolean) {
  const walk = (nodes: DocTreeNode[]) => {
    nodes.forEach((n) => {
      if (n.type === 'folder') {
        if (expand) expandedPaths.add(n.path);
        else expandedPaths.delete(n.path);
        walk(n.children!);
      }
    });
  };
  walk(tree.value);
}

/** 搜索时展示扁平列表，否则展示目录树 */
const displayNodes = computed(() =>
  docSearch.value.trim() ? null : flattenTree(tree.value, isExpanded),
);

/** 文件夹总数（工具条统计） */
const folderCount = computed(() => countFolders(tree.value));

// ==================== 上传（选择即传，Cherry 风格 + 环形进度） ====================

/** 自动跳过的噪音目录与敏感文件 */
const IGNORE_SEGMENT_RE =
  /(^|\/)(node_modules|\.git|dist|build|\.next|\.nuxt|coverage|__pycache__|\.idea|\.vscode|\.cache)(\/|$)/i;
const IGNORE_SENSITIVE_RE = /(^|\/)(\.env(\.[a-z0-9]+)?|[^/]*\.(pem|p12|pfx|key))$/i;
const MAX_UPLOAD_FILES = 2000;
const UPLOAD_CONCURRENCY = 5;

const fileInput = ref<HTMLInputElement | null>(null);
const dirInput = ref<HTMLInputElement | null>(null);

const uploadPhase = ref<'idle' | 'uploading' | 'parsing'>('idle');
const uploadPercent = ref<number | null>(null); // 当前文件 HTTP 传输进度
const uploadDone = ref(0);
const uploadTotal = ref(0);
const uploadErrors = ref<string[]>([]);
/** 增量向量化：同名同内容的文件被后端跳过（不重复解析/嵌入）的数量 */
const uploadSkipped = ref(0);

const uploading = computed(() => uploadPhase.value !== 'idle');

const RING_CIRC = 2 * Math.PI * 26;
// 解析进度（轻量轮询计数，不刷新表格——解析期间列表冻结，可安心浏览其他文件）
const parseStats = ref({ done: 0, total: 0 });
const ringPercent = computed(() => {
  if (uploadPhase.value === 'uploading') {
    return uploadTotal.value ? Math.round((uploadDone.value / uploadTotal.value) * 100) : 0;
  }
  if (uploadPhase.value === 'parsing') {
    return parseStats.value.total
      ? Math.round((parseStats.value.done / parseStats.value.total) * 100)
      : 0;
  }
  return 0;
});
const ringLabel = computed(() => {
  if (uploadPhase.value === 'uploading') {
    return `上传中 ${uploadDone.value}/${uploadTotal.value}`;
  }
  if (uploadPhase.value === 'parsing') {
    return parseStats.value.done < parseStats.value.total
      ? `解析中 ${parseStats.value.done}/${parseStats.value.total}`
      : '解析完成';
  }
  return '';
});

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  addPendingFiles(Array.from(input.files ?? []));
  input.value = '';
}

function onDirChange(e: Event) {
  const input = e.target as HTMLInputElement;
  addPendingFiles(Array.from(input.files ?? []));
  input.value = '';
}

/** 过滤噪音/敏感/超限后立即上传（不展示待传列表） */
function addPendingFiles(files: File[]) {
  const skipped: string[] = [];
  const kept: File[] = [];
  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (IGNORE_SEGMENT_RE.test('/' + rel) || IGNORE_SENSITIVE_RE.test(rel)) {
      skipped.push(rel.split('/').pop() ?? f.name);
      continue;
    }
    kept.push(f);
  }
  if (skipped.length) {
    toast.info(
      `已自动跳过 ${skipped.length} 个文件（node_modules/.git/dist 等构建产物与 .env 密钥文件）`,
      5000,
    );
  }
  if (kept.length > MAX_UPLOAD_FILES) {
    toast.error(
      `文件过多（${kept.length} 个，单次上限 ${MAX_UPLOAD_FILES}），请拆分目录或先排除大目录`,
    );
    return;
  }
  if (kept.length) void startUpload(kept);
}

async function startUpload(files: File[]) {
  const nonEmpty = files.filter((f) => f.size > 0);
  const skippedEmpty = files.length - nonEmpty.length;
  if (!nonEmpty.length) {
    toast.error('所选文件均为空文件，无法上传');
    return;
  }
  const dup = nonEmpty.find((f) => {
    const name = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    return list.value.some((d) => d.filename === name);
  });
  if (
    dup &&
    // eslint-disable-next-line no-alert
    !window.confirm(
      `存在同名文件「${(dup as File & { webkitRelativePath?: string }).webkitRelativePath || dup.name}」，上传后将替换旧版（旧文档及其向量数据将被删除）。继续？`,
    )
  ) {
    return;
  }

  uploadPhase.value = 'uploading';
  uploadErrors.value = [];
  uploadDone.value = 0;
  uploadSkipped.value = 0;
  uploadTotal.value = nonEmpty.length;
  try {
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < nonEmpty.length) {
        const idx = nextIndex++;
        if (idx >= nonEmpty.length) break;
        const f = nonEmpty[idx];
        const name = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        try {
          const res = await uploadDocument(
            knowledgeBaseId,
            f,
            (percent) => (uploadPercent.value = percent),
            name,
          );
          // 增量向量化：同名同内容 → 后端跳过，不算"待解析"
          if ('skipped' in res && res.skipped) {
            uploadSkipped.value++;
          }
        } catch (e) {
          uploadErrors.value.push(`${name}: ${(e as Error).message}`);
        }
        uploadDone.value++;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(UPLOAD_CONCURRENCY, nonEmpty.length) }, () => worker()),
    );
    uploadPercent.value = null;
    // 进入后台解析阶段：环形进度走轻量轮询；列表保持原样（不显示"排队中"），
    // 解析全部完成后一次性刷新展示新文档
    // 会话持久化：刷新页面后环形进度继续显示，不丢失
    sessionStorage.setItem(
      'kb-parse-total',
      String(Math.max(nonEmpty.length - uploadErrors.value.length - uploadSkipped.value, 0)),
    );
    uploadPhase.value = 'parsing';
    startParsePoll();
    const submitted = nonEmpty.length - uploadErrors.value.length - uploadSkipped.value;
    const skippedText = uploadSkipped.value ? `，${uploadSkipped.value} 个内容未变化已跳过` : '';
    if (uploadErrors.value.length) {
      toast.error(
        `${uploadErrors.value.length} 个文件上传失败，其余 ${submitted} 个已提交${skippedText}`,
      );
    } else {
      toast.success(
        `已提交 ${submitted} 个文件，后台解析中${skippedEmpty ? `（跳过 ${skippedEmpty} 个空文件）` : ''}${skippedText}`,
      );
    }
  } finally {
    // 上传状态由 uploadPhase 驱动；异常时兜底复位
    if (uploadPhase.value === 'uploading') uploadPhase.value = 'idle';
  }
}

// ==================== 解析进度轮询：增量补丁（完成一个亮一个，不整表刷新） ====================

let parsePollTimer: number | undefined;

/**
 * 把后端返回的文档列表"就地合并"进当前列表：
 * - 已存在的文档：只更新 status/error/chunk 数 → 只触发那一行重渲染（其余行与滚动不动）
 * - 新增文档追加、被删文档移除
 * 这样解析期间每完成一个文件，它那一行自动流转为"已完成"，不打断浏览。
 */
function mergeDocs(remote: Document[]) {
  const byId = new Map(remote.map((d) => [d.id, d]));
  for (const local of list.value) {
    const r = byId.get(local.id);
    if (r) {
      if (local.status !== r.status) local.status = r.status;
      if ((local.error ?? '') !== (r.error ?? '')) local.error = r.error;
      const lc = local._count?.chunks ?? 0;
      const rc = r._count?.chunks ?? 0;
      if (lc !== rc && local._count) local._count.chunks = rc;
      byId.delete(local.id);
    }
  }
  const added = [...byId.values()];
  if (added.length) list.value = [...list.value, ...added];
  const remoteIds = new Set(remote.map((d) => d.id));
  if (list.value.some((d) => !remoteIds.has(d.id))) {
    list.value = list.value.filter((d) => remoteIds.has(d.id));
  }
}

function startParsePoll() {
  stopParsePoll();
  const total = Math.max(uploadTotal.value - uploadErrors.value.length, 0);
  parseStats.value = { done: 0, total };
  const tick = async () => {
    try {
      const docs = await getDocuments(knowledgeBaseId);
      // 就地补丁：完成一个，那一行自己亮成"已完成"
      mergeDocs(docs);
      const busy = docs.filter((d) => d.status === 'pending' || d.status === 'processing').length;
      const done = Math.min(total - busy, total);
      parseStats.value = { done, total };
      if (done >= total || busy === 0) {
        // 全部完成：收尾做一次完整同步（树/统计一致性）+ 提示复位
        sessionStorage.removeItem('kb-parse-total');
        uploadPhase.value = 'idle';
        await load();
        toast.success('全部文档解析完成');
        return;
      }
    } catch {
      /* 网络抖动忽略，下轮再试 */
    }
    parsePollTimer = window.setTimeout(tick, 2000);
  };
  parsePollTimer = window.setTimeout(tick, 1200);
}
function stopParsePoll() {
  if (parsePollTimer) {
    clearTimeout(parsePollTimer);
    parsePollTimer = undefined;
  }
}

/**
 * 刷新页面后接管后台解析：轻量轮询 + 增量补丁（完成一个亮一个），全部完成自动停止。
 * 若恢复了上传会话（sessionStorage 有总数），同时驱动环形进度。
 */
function watchBusyDocs() {
  stopParsePoll();
  const tick = async () => {
    try {
      const docs = await getDocuments(knowledgeBaseId);
      mergeDocs(docs);
      const busy = docs.filter((d) => d.status === 'pending' || d.status === 'processing').length;
      // 恢复会话时：环形进度持续推进
      if (uploadPhase.value === 'parsing') {
        const total = Math.max(uploadTotal.value, 0);
        parseStats.value = { done: Math.min(total - busy, total), total };
      }
      if (busy === 0) {
        // 全部完成，停止轮询
        sessionStorage.removeItem('kb-parse-total');
        if (uploadPhase.value === 'parsing') {
          uploadPhase.value = 'idle';
          await load();
          toast.success('全部文档解析完成');
        }
        return;
      }
    } catch {
      /* 网络抖动忽略，下轮再试 */
    }
    parsePollTimer = window.setTimeout(tick, 2500);
  };
  parsePollTimer = window.setTimeout(tick, 1500);
}

// ==================== 列表 / 文档操作 ====================

async function load() {
  loading.value = true;
  try {
    list.value = await getDocuments(knowledgeBaseId);
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function handleDelete(docId: string, filename: string) {
  // eslint-disable-next-line no-alert
  if (!window.confirm(`删除文档「${filename}」及其向量数据？`)) return;
  try {
    await deleteDocument(knowledgeBaseId, docId);
    await load();
    toast.success(`文档「${filename}」已删除`);
  } catch (e) {
    toast.error((e as Error).message);
  }
}

async function handleDownload(doc: Document) {
  try {
    const blob = await downloadDocumentFile(knowledgeBaseId, doc.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = doc.filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('文件已开始下载');
  } catch (e) {
    toast.error((e as Error).message);
  }
}

// ==================== 更新（重新上传替换） ====================

const updatingId = ref<string | null>(null);

function onReplaceFileChange(e: Event, docId: string) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  // eslint-disable-next-line no-alert
  if (!window.confirm(`用「${file.name}」替换当前文档？旧文档及其向量数据将被删除。`)) return;
  void handleReplace(docId, file);
}

/** 轮询等待指定文档处理完成（替换流程用） */
async function waitForDoc(id: string) {
  for (let i = 0; i < 60; i++) {
    await load();
    const d = list.value.find((x) => x.id === id);
    if (!d || d.status === 'done' || d.status === 'failed') return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function handleReplace(docId: string, file: File) {
  updatingId.value = docId;
  try {
    const oldDoc = list.value.find((d) => d.id === docId);
    // 先提交新版本（后台队列处理），等新文档处理完成后再删旧版——避免中间真空期、失败不丢旧数据
    const created = await uploadDocument(knowledgeBaseId, file);
    // 增量向量化：内容没变 → 后端跳过，无需等待/删除
    if ('skipped' in created) {
      await load();
      toast.success('文件内容未变化，无需重新向量化');
      return;
    }
    await waitForDoc(created.id);
    // 若新旧文件名相同，后端队列已自动替换（旧文档已被删），无需再手动删（否则会 404 报"文档不存在"）
    if (created.filename !== oldDoc?.filename) {
      await deleteDocument(knowledgeBaseId, docId);
    }
    await load();
    toast.success('文档已更新并重新向量化');
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    updatingId.value = null;
  }
}

// ==================== 文件夹操作（重命名 / 删除） ====================

/** 重命名文件夹 = 批量把其下所有文件的路径前缀换成新名 */
async function handleRenameFolder(node: DocTreeNode) {
  const oldPath = node.path;
  // eslint-disable-next-line no-alert
  const newName = window.prompt('输入新的文件夹名称：', node.name)?.trim();
  if (!newName || newName === node.name) return;
  if (newName.includes('/') || newName.includes('\\')) {
    toast.error('文件夹名称不能包含路径分隔符');
    return;
  }
  const docs = collectFolderFiles(node).filter((d) => d.filename.startsWith(oldPath + '/'));
  if (!docs.length) {
    toast.error('文件夹下没有文件');
    return;
  }
  const targets = new Set(docs.map((d) => newName + d.filename.slice(oldPath.length)));
  const conflict = list.value.find(
    (d) => targets.has(d.filename) && !docs.some((x) => x.id === d.id),
  );
  if (conflict) {
    toast.error(`重命名冲突：「${conflict.filename}」已存在`);
    return;
  }
  const errors: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < docs.length) {
      const idx = next++;
      if (idx >= docs.length) break;
      const d = docs[idx];
      try {
        await updateDocument(knowledgeBaseId, d.id, {
          filename: newName + d.filename.slice(oldPath.length),
        });
      } catch {
        errors.push(d.filename);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, docs.length) }, () => worker()));
  await load();
  if (errors.length) toast.error(`重命名部分失败（${errors.length} 个），其余已更新`);
  else
    toast.success(`已重命名文件夹「${node.name}」→「${newName}」，更新 ${docs.length} 个文件路径`);
}

/** 删除文件夹 = 删除其下全部文档（含向量数据）；并发执行，大目录（上千文件）也能一次删完 */
async function handleDeleteFolder(node: DocTreeNode) {
  const docs = collectFolderFiles(node);
  if (!docs.length) {
    toast.error('文件夹下没有文件');
    return;
  }
  // eslint-disable-next-line no-alert
  if (!window.confirm(`删除文件夹「${node.name}」及其下 ${docs.length} 个文档（含向量数据）？`)) {
    return;
  }
  const errors: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < docs.length) {
      const idx = next++;
      if (idx >= docs.length) break;
      const d = docs[idx];
      try {
        await deleteDocument(knowledgeBaseId, d.id);
      } catch {
        errors.push(d.filename);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, docs.length) }, () => worker()));
  await load();
  if (errors.length) toast.error(`删除部分失败（${errors.length} 个）`);
  else toast.success(`文件夹「${node.name}」已删除（${docs.length} 个文档）`);
}

// ==================== 状态展示 ====================

// ---- 多选批量删除（部分删除：勾选若干文件后统一删除） ----
const selectedIds = reactive(new Set<string>());
const hasSelection = computed(() => selectedIds.size > 0);

function toggleSelect(id: string) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
}

function clearSelection() {
  selectedIds.clear();
}

async function deleteSelected() {
  const docs = list.value.filter((d) => selectedIds.has(d.id));
  if (!docs.length) return;
  // eslint-disable-next-line no-alert
  if (!window.confirm(`删除选中的 ${docs.length} 个文档（含向量数据）？`)) return;
  const errors: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < docs.length) {
      const idx = next++;
      if (idx >= docs.length) break;
      const d = docs[idx];
      try {
        await deleteDocument(knowledgeBaseId, d.id);
      } catch {
        errors.push(d.filename);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, docs.length) }, () => worker()));
  selectedIds.clear();
  await load();
  if (errors.length) toast.error(`删除部分失败（${errors.length} 个）`);
  else toast.success(`已删除 ${docs.length} 个文档`);
}

/** 勾选文件夹 = 勾选/取消其下全部文件（含子文件夹） */
function toggleSelectFolder(node: DocTreeNode) {
  const docs = collectFolderFiles(node);
  if (!docs.length) return;
  const allSelected = docs.every((d) => selectedIds.has(d.id));
  for (const d of docs) {
    if (allSelected) selectedIds.delete(d.id);
    else selectedIds.add(d.id);
  }
}

// ---- 代码编辑（整页编辑视图） ----
const editingDoc = ref<Document | null>(null);

function openDocEdit(doc: Document) {
  editingDoc.value = doc;
}

onMounted(async () => {
  await load();
  const busy = list.value.filter((d) => d.status === 'pending' || d.status === 'processing').length;
  if (busy > 0) {
    // 恢复上传会话：解析环不因刷新消失（总数从 sessionStorage 取）
    const storedTotal = Number(sessionStorage.getItem('kb-parse-total') || '0');
    if (storedTotal > 0) {
      uploadPhase.value = 'parsing';
      uploadTotal.value = storedTotal;
      parseStats.value = { done: Math.min(storedTotal - busy, storedTotal), total: storedTotal };
    }
    watchBusyDocs();
  }
});
onBeforeUnmount(stopParsePoll);
</script>

<template>
  <div class="container py-10">
    <!-- 整页编辑视图（非小弹窗）：编辑代码/文档时替代列表 -->
    <DocCodeEditor
      v-if="editingDoc"
      :knowledge-base-id="knowledgeBaseId"
      :doc="editingDoc"
      @close="editingDoc = null"
      @saved="load"
    />

    <!-- 列表视图 -->
    <template v-else>
      <div class="mb-6 flex items-center gap-3">
        <Button variant="ghost" size="icon" @click="router.push('/knowledge')">
          <ArrowLeft class="h-4 w-4" />
        </Button>
        <div>
          <h1 class="text-2xl font-bold tracking-tight">文档管理</h1>
          <p class="mt-0.5 text-sm text-muted-foreground">
            选择文件/目录即自动上传解析；代码与文档参与检索，图片等作为附件保管
          </p>
        </div>
        <div class="relative ml-auto w-44 sm:w-56">
          <Search
            class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input v-model="docSearch" type="text" placeholder="搜索文档" class="h-8 pl-8 text-xs" />
        </div>
        <Button
          variant="outline"
          size="icon"
          class="h-8 w-8 shrink-0"
          title="刷新列表"
          @click="load"
        >
          <RefreshCw class="h-4 w-4" />
        </Button>
      </div>

      <!-- 上传区：选择即上传（Cherry 风格）+ 环形进度 -->
      <div class="mb-8 rounded-lg border border-dashed bg-card p-6">
        <div class="flex flex-col items-center gap-4">
          <input ref="fileInput" type="file" multiple class="hidden" @change="onFileChange" />
          <input ref="dirInput" type="file" webkitdirectory class="hidden" @change="onDirChange" />
          <div class="flex flex-wrap items-center justify-center gap-3">
            <Button variant="outline" :disabled="uploading" @click="fileInput?.click()">
              <FolderOpen class="h-4 w-4" />
              选择文件（可多选）
            </Button>
            <Button variant="outline" :disabled="uploading" @click="dirInput?.click()">
              <FolderTree class="h-4 w-4" />
              选择目录
            </Button>
          </div>
          <p class="max-w-lg text-center text-xs text-muted-foreground">
            选择后自动上传，无需确认；自动跳过 node_modules/.git/dist 等构建产物与 .env 密钥文件，
            图片等类型作为附件保管
          </p>

          <!-- 环形进度：上传中 / 解析中 -->
          <div v-if="uploadPhase !== 'idle'" class="flex flex-col items-center gap-2">
            <svg class="h-16 w-16 -rotate-90" viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="26" fill="none" stroke-width="5" class="stroke-muted" />
              <circle
                cx="32"
                cy="32"
                r="26"
                fill="none"
                stroke-width="5"
                stroke-linecap="round"
                class="stroke-primary transition-[stroke-dashoffset] duration-300"
                :stroke-dasharray="RING_CIRC"
                :stroke-dashoffset="RING_CIRC * (1 - ringPercent / 100)"
              />
            </svg>
            <p class="text-sm text-muted-foreground">{{ ringLabel }}</p>
          </div>

          <!-- 上传失败汇总 -->
          <div
            v-if="uploadErrors.length"
            class="w-full max-w-md rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
          >
            <p class="font-medium text-destructive">以下文件上传失败：</p>
            <ul
              class="mt-1 max-h-32 list-inside list-disc overflow-auto text-xs text-muted-foreground"
            >
              <li v-for="(msg, i) in uploadErrors" :key="i">{{ msg }}</li>
            </ul>
          </div>
        </div>
      </div>

      <!-- 文档列表 -->
      <div v-if="loading">
        <div class="space-y-2">
          <div
            v-for="i in 6"
            :key="i"
            class="flex items-center gap-4 rounded-lg border bg-card px-4 py-3"
          >
            <div class="h-4 w-4 rounded bg-muted" />
            <div class="h-3 flex-1 rounded bg-muted" />
            <div class="h-3 w-16 rounded bg-muted" />
          </div>
        </div>
      </div>

      <div v-else class="overflow-x-auto rounded-lg border">
        <!-- 目录树工具条：有文件夹时提供全部展开/折叠 -->
        <div
          v-if="folderCount > 0 && !docSearch.trim()"
          class="flex items-center justify-between border-b bg-muted/20 px-4 py-2 text-xs text-muted-foreground"
        >
          <span>共 {{ list.length }} 个文档 · {{ folderCount }} 个文件夹</span>
          <div class="flex gap-3">
            <button
              class="transition-colors hover:text-foreground hover:underline"
              @click="toggleAll(true)"
            >
              全部展开
            </button>
            <button
              class="transition-colors hover:text-foreground hover:underline"
              @click="toggleAll(false)"
            >
              全部折叠
            </button>
          </div>
        </div>

        <!-- 多选批量删除条（勾选若干文件后出现） -->
        <div
          v-if="hasSelection"
          class="flex items-center justify-between border-b bg-primary/5 px-4 py-2 text-xs"
        >
          <span class="text-foreground">已选 {{ selectedIds.size }} 个文档</span>
          <div class="flex items-center gap-4">
            <button
              class="text-muted-foreground transition-colors hover:text-foreground hover:underline"
              @click="clearSelection"
            >
              取消选择
            </button>
            <button
              class="font-medium text-destructive transition-colors hover:underline"
              @click="deleteSelected"
            >
              删除选中
            </button>
          </div>
        </div>
        <table class="w-full min-w-[760px] text-sm">
          <thead
            class="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground"
          >
            <tr>
              <th class="px-4 py-3 font-medium">文件名</th>
              <th class="px-4 py-3 font-medium">类型</th>
              <th class="px-4 py-3 font-medium">大小</th>
              <th class="px-4 py-3 font-medium">状态</th>
              <th class="px-4 py-3 font-medium">Chunk 数</th>
              <th class="px-4 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            <!-- 搜索模式：扁平列表（文件名保留完整相对路径） -->
            <template v-if="displayNodes === null">
              <DocTableRow
                v-for="doc in filteredDocs"
                :key="doc.id"
                :node="{ type: 'file', name: doc.filename, path: doc.filename, doc, depth: 0 }"
                :selected-ids="selectedIds"
                :updating-id="updatingId"
                :expanded-paths="expandedPaths"
                @toggle-folder="toggleFolder"
                @toggle-select-folder="toggleSelectFolder"
                @toggle-select="toggleSelect"
                @edit="openDocEdit"
                @download="handleDownload"
                @replace="onReplaceFileChange"
                @delete="handleDelete"
                @rename-folder="handleRenameFolder"
                @delete-folder="handleDeleteFolder"
              />
            </template>

            <!-- 目录树模式：文件夹行可展开折叠，文件行按层级缩进 -->
            <template v-else>
              <DocTableRow
                v-for="node in displayNodes"
                :key="node.type === 'folder' ? 'dir:' + node.path : 'file:' + node.doc!.id"
                :node="node"
                :selected-ids="selectedIds"
                :updating-id="updatingId"
                :expanded-paths="expandedPaths"
                @toggle-folder="toggleFolder"
                @toggle-select-folder="toggleSelectFolder"
                @toggle-select="toggleSelect"
                @edit="openDocEdit"
                @download="handleDownload"
                @replace="onReplaceFileChange"
                @delete="handleDelete"
                @rename-folder="handleRenameFolder"
                @delete-folder="handleDeleteFolder"
              />
            </template>
          </tbody>
        </table>

        <!-- 空状态 -->
        <div v-if="!list.length" class="flex flex-col items-center gap-2 py-16 text-center">
          <FolderOpen class="h-10 w-10 text-muted-foreground/50" />
          <p class="text-sm text-muted-foreground">还没有文档，选择文件或目录开始上传</p>
        </div>
      </div>
    </template>
  </div>
</template>
