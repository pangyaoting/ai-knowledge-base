import { extractSymbols } from './code-indexer';

describe('extractSymbols 代码符号索引（C：AST 级）', () => {
  it('提取 TS 文件中的函数/类/接口/const', () => {
    const code = `import { Injectable } from '@nestjs/common';

const LIMIT = 5;

export function parseUrl(raw: string): string {
  return raw.trim();
}

export class Parser {
  run() {}
}

export interface Options {
  size: number;
}

type Alias = string;
`;
    const symbols = extractSymbols('parser.ts', code);
    const names = symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('function:parseUrl');
    expect(names).toContain('class:Parser');
    expect(names).toContain('interface:Options');
    expect(names).toContain('type:Alias');
    expect(names).toContain('const:LIMIT');

    const fn = symbols.find((s) => s.name === 'parseUrl')!;
    expect(fn.signature).toContain('parseUrl(raw');
    // 行号范围：实现源码可按此切出
    expect(fn.startLine).toBeGreaterThanOrEqual(3);
    expect(fn.endLine).toBeGreaterThan(fn.startLine);
  });

  it('const 箭头函数识别为 function', () => {
    const code = `export const handler = (a: number) => a * 2;
export const config = { dark: true };
`;
    const symbols = extractSymbols('x.ts', code);
    expect(symbols.some((s) => s.kind === 'function' && s.name === 'handler')).toBe(true);
    expect(symbols.some((s) => s.kind === 'const' && s.name === 'config')).toBe(true);
  });

  it('Vue SFC：抽取 script 块，识别 setup 顶层函数与组件名（行号对齐文件）', () => {
    const vue = `<template>
  <div>{{ msg }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

defineOptions({ name: 'MyCard' });

const msg = ref('hi');

function handleClick() {
  msg.value = 'clicked';
}
</script>
`;
    const symbols = extractSymbols('MyCard.vue', vue);
    expect(symbols.some((s) => s.kind === 'function' && s.name === 'handleClick')).toBe(true);
    expect(symbols.some((s) => s.kind === 'const' && s.name === 'msg')).toBe(true);
    // 行号相对整个 vue 文件（handleClick 在 script 内第 9 行左右，文件里对应第 12 行附近）
    const fn = symbols.find((s) => s.name === 'handleClick')!;
    expect(fn.startLine).toBeGreaterThanOrEqual(9);
  });

  it('空/无脚本内容返回空数组', () => {
    expect(extractSymbols('a.ts', '// 只有注释')).toEqual([]);
    expect(extractSymbols('a.vue', '<template><div/></template>')).toEqual([]);
  });
});
