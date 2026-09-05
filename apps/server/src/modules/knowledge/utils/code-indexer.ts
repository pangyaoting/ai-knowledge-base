/**
 * 代码符号索引器（C：符号级结构化索引，用 TypeScript Compiler API 解析 AST）
 *
 * 为什么需要它：通用 RAG 对代码只做"文本片段相似度"，不知道文件里有哪些函数/类，
 * 问"Settings.vue 的 onAvatarChange 实现"只能碰运气。这里把每个代码文件解析成
 * 符号表（函数/类/接口/类型/组件 + 行号范围），检索时问题命中符号名 → 直接返回
 * 该符号的实现源码（不是语义相近的碎片）。
 *
 * 支持：.ts / .tsx / .js / .jsx / .vue（vue 先抽 <script> 块再喂 TS parser）
 * 无第三方依赖：typescript 包自带 Compiler API（AST 级，行业标准做法）。
 */

import * as ts from 'typescript';

export type SymbolKind =
  'function' | 'const' | 'class' | 'interface' | 'type' | 'enum' | 'component';

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** 一行签名（函数含参数；类/接口/类型含声明文本） */
  signature: string;
  /** 1-based 起始行（含） */
  startLine: number;
  /** 1-based 结束行（含）——命中后按此范围切出实现源码 */
  endLine: number;
}

const VUE_SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const DEFINE_OPTIONS_NAME_RE = /defineOptions\s*\(\s*\{[\s\S]*?name\s*:\s*['"]([^'"]+)['"]/i;

/** 从代码文件提取符号表（纯函数，可单测） */
export function extractSymbols(fileName: string, source: string): CodeSymbol[] {
  const lower = fileName.toLowerCase();
  const isVue = lower.endsWith('.vue');
  const isTsx = lower.endsWith('.tsx') || lower.endsWith('.jsx') || isVue;

  let code = source;
  let lineOffset = 0; // vue：<script> 之前的行数（script 内行号 → 文件行号）
  let vueComponentName: string | null = null;

  if (isVue) {
    const m = VUE_SCRIPT_RE.exec(source);
    if (m) {
      code = m[1];
      lineOffset = source.slice(0, m.index).split('\n').length - 1;
      const dom = DEFINE_OPTIONS_NAME_RE.exec(code);
      if (dom) vueComponentName = dom[1];
    }
  }

  const symbols: CodeSymbol[] = [];
  const sf = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const lineOf = (pos: number): number =>
    sf.getLineAndCharacterOfPosition(pos).line + 1 + lineOffset;

  for (const stmt of sf.statements) {
    const sym = symbolFromStatement(sf, stmt, lineOf, isVue);
    if (sym) symbols.push(sym);
  }

  if (vueComponentName && symbols.length === 0) {
    // 组件只有 defineOptions name、无顶层函数/变量时，也给出组件符号
    symbols.push({
      name: vueComponentName,
      kind: 'component',
      signature: vueComponentName,
      startLine: 1 + lineOffset,
      endLine: code.split('\n').length + lineOffset,
    });
  }

  return dedupe(symbols);
}

/** 单个顶层语句 → 符号（无声明语义的语句返回 null） */
function symbolFromStatement(
  sf: ts.SourceFile,
  stmt: ts.Statement,
  lineOf: (pos: number) => number,
  isVue: boolean,
): CodeSymbol | null {
  if (ts.isFunctionDeclaration(stmt)) {
    const name = stmt.name?.text;
    if (!name) return null;
    return {
      name,
      kind: 'function',
      signature: oneLine(stmt.getText(sf), 120),
      startLine: lineOf(stmt.getStart(sf)),
      endLine: lineOf(stmt.end),
    };
  }
  if (ts.isClassDeclaration(stmt)) {
    const name = stmt.name?.text;
    if (!name) return null;
    return {
      name,
      kind: 'class',
      signature: oneLine(stmt.getText(sf), 120),
      startLine: lineOf(stmt.getStart(sf)),
      endLine: lineOf(stmt.end),
    };
  }
  if (ts.isInterfaceDeclaration(stmt)) {
    return {
      name: stmt.name.text,
      kind: 'interface',
      signature: oneLine(stmt.getText(sf), 200),
      startLine: lineOf(stmt.getStart(sf)),
      endLine: lineOf(stmt.end),
    };
  }
  if (ts.isTypeAliasDeclaration(stmt)) {
    return {
      name: stmt.name.text,
      kind: 'type',
      signature: oneLine(stmt.getText(sf), 200),
      startLine: lineOf(stmt.getStart(sf)),
      endLine: lineOf(stmt.end),
    };
  }
  if (ts.isEnumDeclaration(stmt)) {
    return {
      name: stmt.name.text,
      kind: 'enum',
      signature: oneLine(stmt.getText(sf), 200),
      startLine: lineOf(stmt.getStart(sf)),
      endLine: lineOf(stmt.end),
    };
  }
  if (ts.isVariableStatement(stmt)) {
    // const x = ... / const fn = () => ...（顶层变量/箭头函数声明）
    const decl = stmt.declarationList.declarations[0];
    if (!decl) return null;
    const name = ts.isIdentifier(decl.name) ? decl.name.text : undefined;
    if (!name) return null;
    const isFn =
      decl.initializer &&
      (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
    return {
      name,
      kind: isFn ? 'function' : 'const',
      signature: oneLine(stmt.getText(sf), 120),
      startLine: lineOf(stmt.getStart(sf)),
      endLine: lineOf(stmt.end),
    };
  }
  if (ts.isModuleDeclaration(stmt) && isVue) {
    // vue 文件末尾的 declare module 包装（SFC 类型声明），忽略
    return null;
  }
  return null;
}

/** 长文本截成单行签名 */
function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 去重（同名同 kind 只留第一个，如 vue 里 script 块 + 类型声明可能重复） */
function dedupe(symbols: CodeSymbol[]): CodeSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((s) => {
    const key = `${s.kind}:${s.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
