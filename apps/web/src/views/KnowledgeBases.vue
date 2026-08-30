<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import {
  BookOpen,
  FileText,
  Plus,
  Trash2,
  Loader2,
  RefreshCw,
  Pencil,
  Sparkles,
  Search,
} from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { toast } from '@/composables/useToast';
import {
  getKnowledgeBases,
  createKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
  seedDemoData,
} from '@/api/knowledge';
import type { KnowledgeBase } from '@/types/knowledge';

const router = useRouter();

const list = ref<KnowledgeBase[]>([]);
const loading = ref(false);
const creating = ref(false);
const seeding = ref(false);
const kbSearch = ref(''); // 知识库搜索（本地过滤）

/** 按名称/描述过滤知识库（即时响应，无需请求后端） */
const filteredList = computed(() => {
  const q = kbSearch.value.trim().toLowerCase();
  if (!q) return list.value;
  return list.value.filter((kb) => `${kb.name} ${kb.description ?? ''}`.toLowerCase().includes(q));
});

const name = ref('');
const description = ref('');

async function load() {
  loading.value = true;
  try {
    list.value = await getKnowledgeBases();
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

// 进入页面立即加载列表（之前漏了这行，导致要新建或点刷新才显示）
onMounted(load);

/** 一键导入示例数据 */
async function handleSeed() {
  seeding.value = true;
  try {
    await seedDemoData();
    await load();
    toast.success('示例数据导入完成，正在后台向量化');
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    seeding.value = false;
  }
}

async function handleCreate() {
  const trimmed = name.value.trim();
  if (!trimmed) return;
  creating.value = true;
  try {
    const created = await createKnowledgeBase({
      name: trimmed,
      description: description.value.trim() || undefined,
    });
    name.value = '';
    description.value = '';
    toast.success(`知识库「${created.name}」已创建`);
    // 乐观插入：立即显示新知识库，不依赖第二次请求（避免后端偶发抖动时"创建了但看不到"）
    list.value.unshift(created);
    // 后台刷新拿完整数据（文档数统计等）；失败不影响已显示的新条目
    load().catch(() => undefined);
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    creating.value = false;
  }
}

async function handleDelete(id: string, name: string) {
  // eslint-disable-next-line no-alert
  if (!window.confirm(`删除知识库「${name}」将同时删除其中所有文档和向量数据，确定要删除吗？`))
    return;
  try {
    await deleteKnowledgeBase(id);
    await load();
    toast.success(`知识库「${name}」已删除`);
  } catch (e) {
    toast.error((e as Error).message);
  }
}

// ==================== 编辑（改名/改描述） ====================
const editing = ref<KnowledgeBase | null>(null);
const editName = ref('');
const editDesc = ref('');
const saving = ref(false);

function openEdit(kb: KnowledgeBase) {
  editing.value = kb;
  editName.value = kb.name;
  editDesc.value = kb.description ?? '';
}

async function saveEdit() {
  const kb = editing.value;
  if (!kb) return;
  const trimmed = editName.value.trim();
  if (!trimmed) return;
  saving.value = true;
  try {
    await updateKnowledgeBase(kb.id, {
      name: trimmed,
      description: editDesc.value.trim() || undefined,
    });
    editing.value = null;
    await load();
    toast.success('知识库信息已更新');
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="container py-10">
    <!-- 页头 -->
    <div class="mb-8 flex items-start justify-between">
      <div>
        <h1 class="text-2xl font-bold tracking-tight">知识库</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          上传你的文档，系统会自动解析、分块并向量化，之后就能进行语义问答
        </p>
      </div>
      <div class="flex items-center gap-2">
        <div class="relative w-44 sm:w-52">
          <Search
            class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input v-model="kbSearch" type="text" placeholder="搜索知识库" class="h-8 pl-8 text-xs" />
        </div>
        <Button variant="outline" size="sm" :disabled="loading" @click="load">
          <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />
          刷新
        </Button>
      </div>
    </div>

    <!-- 创建表单 -->
    <div class="mb-8 rounded-lg border bg-card p-5">
      <div class="grid gap-3 sm:grid-cols-[1fr_1.5fr_auto]">
        <Input v-model="name" placeholder="知识库名称（必填）" :disabled="creating" />
        <Input v-model="description" placeholder="描述（可选）" :disabled="creating" />
        <Button :disabled="creating || !name.trim()" @click="handleCreate">
          <Plus v-if="!creating" class="h-4 w-4" />
          <Loader2 v-else class="h-4 w-4 animate-spin" />
          {{ creating ? '创建中...' : '创建知识库' }}
        </Button>
      </div>
    </div>

    <!-- 列表 -->
    <div v-if="loading">
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div v-for="i in 6" :key="i" class="rounded-lg border bg-card p-5">
          <Skeleton class="h-4 w-2/3" />
          <Skeleton class="mt-3 h-3 w-full" />
          <Skeleton class="mt-1.5 h-3 w-3/4" />
          <div class="mt-5 flex items-center justify-between">
            <Skeleton class="h-3 w-20" />
            <Skeleton class="h-7 w-20" />
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="list.length === 0" class="rounded-lg border border-dashed py-16 text-center">
      <BookOpen class="mx-auto h-10 w-10 text-muted-foreground/50" />
      <p class="mt-3 text-sm text-muted-foreground">还没有知识库，先创建一个吧</p>
      <!-- 三步引导 -->
      <div class="mx-auto mt-6 flex max-w-lg flex-col gap-3 text-left sm:flex-row">
        <div class="flex-1 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
          <p class="font-medium text-foreground">① 创建知识库</p>
          <p class="mt-1">在上方输入名称创建</p>
        </div>
        <div class="flex-1 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
          <p class="font-medium text-foreground">② 上传文档</p>
          <p class="mt-1">文档/代码/项目目录均可，自动解析向量化</p>
        </div>
        <div class="flex-1 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
          <p class="font-medium text-foreground">③ 对话提问</p>
          <p class="mt-1">回答附带引用来源</p>
        </div>
      </div>
      <!-- 一键示例数据 -->
      <Button class="mt-6" :disabled="seeding" @click="handleSeed">
        <Loader2 v-if="seeding" class="h-4 w-4 animate-spin" />
        <Sparkles v-else class="h-4 w-4" />
        {{ seeding ? '导入中，正在向量化示例文档...' : '一键导入示例数据' }}
      </Button>
      <p class="mt-2 text-xs text-muted-foreground">
        导入包含 RAG 概念、AI 基础与使用指南的示例知识库，快速体验完整流程
      </p>
    </div>

    <div
      v-else-if="filteredList.length === 0"
      class="rounded-lg border border-dashed py-16 text-center"
    >
      <Search class="mx-auto h-10 w-10 text-muted-foreground/50" />
      <p class="mt-3 text-sm text-muted-foreground">没有匹配的知识库，换个关键词试试</p>
    </div>

    <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div
        v-for="kb in filteredList"
        :key="kb.id"
        class="flex flex-col rounded-lg border bg-card p-5 transition-shadow hover:shadow-md"
      >
        <div class="flex items-start justify-between gap-2">
          <h3 class="font-semibold line-clamp-1">{{ kb.name }}</h3>
          <div class="flex shrink-0 items-center gap-0.5">
            <button
              class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              :title="'编辑 ' + kb.name"
              @click="openEdit(kb)"
            >
              <Pencil class="h-4 w-4" />
            </button>
            <button
              class="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              :title="'删除 ' + kb.name"
              @click="handleDelete(kb.id, kb.name)"
            >
              <Trash2 class="h-4 w-4" />
            </button>
          </div>
        </div>
        <p class="mt-1 flex-1 text-sm text-muted-foreground line-clamp-2">
          {{ kb.description || '暂无描述' }}
        </p>
        <div class="mt-4 flex items-center justify-between">
          <span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileText class="h-3.5 w-3.5" />
            {{ kb._count?.documents ?? 0 }} 个文档
          </span>
          <Button variant="outline" size="sm" @click="router.push(`/knowledge/${kb.id}`)">
            管理文档
          </Button>
        </div>
      </div>
    </div>

    <!-- 编辑知识库弹窗 -->
    <div
      v-if="editing"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="editing = null"
    >
      <div class="w-full max-w-md rounded-lg border bg-card p-5 shadow-xl">
        <h3 class="text-base font-semibold">编辑知识库</h3>
        <div class="mt-4 space-y-3">
          <div class="space-y-1.5">
            <Label>名称</Label>
            <Input v-model="editName" placeholder="知识库名称" />
          </div>
          <div class="space-y-1.5">
            <Label>描述</Label>
            <Input v-model="editDesc" placeholder="描述（可选）" />
          </div>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="editing = null">取消</Button>
          <Button size="sm" :disabled="saving || !editName.trim()" @click="saveEdit">
            <Loader2 v-if="saving" class="h-4 w-4 animate-spin" />
            {{ saving ? '保存中...' : '保存' }}
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
