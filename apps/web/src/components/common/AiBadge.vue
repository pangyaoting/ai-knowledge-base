<script setup lang="ts">
import { Sparkles } from 'lucide-vue-next';

/**
 * AI 生成内容「显式标识」。
 *
 * 依据《人工智能生成合成内容标识办法》（2025-09-01 施行）：服务提供者应当在生成合成内容的
 * 展示区域添加**显著标识**，提示用户该内容由 AI 生成。所以对话回答、研究报告、自主研究报告
 * 三处生成内容统一挂这个组件，文案可覆写（例如"AI 生成 · 请自行核实"）。
 */
withDefaults(defineProps<{ label?: string; hint?: string }>(), {
  label: 'AI 生成',
  hint: '内容由 AI 生成，仅供参考，请自行核实（不构成专业意见）',
});
</script>

<template>
  <span
    class="inline-flex select-none items-center gap-1 rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground"
    :title="hint"
  >
    <Sparkles class="h-2.5 w-2.5" />{{ label }}
  </span>
</template>
