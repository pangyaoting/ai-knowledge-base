import MarkdownIt from 'markdown-it';
// 按需引入 highlight.js：核心 + 常用语言（全量引入会让打包体积增大 ~1MB）
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import 'highlight.js/styles/github.css';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('vue', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('sql', sql);

/**
 * Markdown 渲染（AI 回答展示用）
 * - markdown-it：标准 Markdown 语法（表格、列表、链接…）
 * - highlight.js：代码块高亮
 * - 每个代码块自动包一层容器 + 复制按钮（点击由 Chat 页事件委托处理）
 */
const md = new MarkdownIt({
  html: false, // 禁止原始 HTML，防注入
  linkify: true,
  breaks: true, // 换行渲染为 <br>，AI 回答更友好
  highlight(code: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang }).value}</code></pre>`;
      } catch {
        /* fallthrough */
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`;
  },
});

export function renderMarkdown(text: string): string {
  const html = md.render(text);
  // 给每个代码块包容器 + 复制按钮
  return html
    .replace(/<pre class="hljs">/g, '<div class="code-block"><button type="button" class="code-copy" title="复制代码">复制</button><pre class="hljs">')
    .replace(/<\/pre>/g, '</pre></div>');
}

/** 点击复制按钮时获取对应代码文本（事件委托，由调用方绑定） */
export function getCopyCode(target: HTMLElement): string | null {
  const block = target.closest('.code-block');
  if (!block) return null;
  const pre = block.querySelector('pre');
  return pre ? pre.textContent ?? null : null;
}
