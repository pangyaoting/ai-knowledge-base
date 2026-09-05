import MarkdownIt from 'markdown-it';
// 按需引入 highlight.js：核心 + 常用语言（全量引入会让打包体积增大 ~1MB）
// 主题样式在 index.css 里固定为 One Dark Pro 深色（token 配色，见 .markdown-body .hljs-*）
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import kotlin from 'highlight.js/lib/languages/kotlin';
import swift from 'highlight.js/lib/languages/swift';
import yaml from 'highlight.js/lib/languages/yaml';
import ini from 'highlight.js/lib/languages/ini';
import markdownLang from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';

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
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c++', cpp);
hljs.registerLanguage('java', java);
hljs.registerLanguage('go', go);
hljs.registerLanguage('golang', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('php', php);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('rb', ruby);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('kt', kotlin);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('toml', ini);
hljs.registerLanguage('markdown', markdownLang);
hljs.registerLanguage('md', markdownLang);
hljs.registerLanguage('diff', diff);

/** 自动检测的语言范围（常见语言，避免误判冷门内容） */
const AUTO_SUBSET = [
  'javascript',
  'typescript',
  'python',
  'bash',
  'json',
  'xml',
  'css',
  'sql',
  'java',
  'go',
  'rust',
  'cpp',
  'yaml',
  'markdown',
];

/**
 * Markdown 渲染（AI 回答展示用）
 * - markdown-it：标准 Markdown 语法（表格、列表、链接…）
 * - highlight.js：代码块高亮（标注语言按语言高亮；未标注的自动检测）
 * - 每个代码块自动包一层容器 + 复制按钮（点击由 Chat 页事件委托处理）
 */
const md = new MarkdownIt({
  html: false, // 禁止原始 HTML，防注入
  linkify: true,
  breaks: true, // 换行渲染为 <br>，AI 回答更友好
  highlight(code: string, lang: string): string {
    // 1. 有语言标注且已注册 → 按语言高亮（最准确）
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang }).value}</code></pre>`;
      } catch {
        /* fallthrough 到自动检测 */
      }
    }
    // 2. 未标注语言/未注册 → 自动检测（解决 AI 输出 ``` 不带语言时整块无色的痛点）
    if (code.trim()) {
      try {
        const detected = hljs.highlightAuto(code, AUTO_SUBSET).value;
        return `<pre class="hljs"><code>${detected}</code></pre>`;
      } catch {
        /* fallthrough 到纯文本 */
      }
    }
    // 3. 兜底：纯文本转义
    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`;
  },
});

// 渲染结果缓存：AI 回答每条消息内容不变就不重复跑 markdown-it + 代码高亮
// （消息组件用 computed 调用本函数，父组件任何状态更新都不会导致已渲染消息重新高亮）
const renderCache = new Map<string, string>();
const RENDER_CACHE_MAX = 200;

export function renderMarkdown(text: string): string {
  const hit = renderCache.get(text);
  if (hit !== undefined) return hit;
  if (renderCache.size >= RENDER_CACHE_MAX) renderCache.clear();
  const html = md.render(text);
  // 给每个代码块包容器 + 复制按钮
  const wrapped = html
    .replace(
      /<pre class="hljs">/g,
      '<div class="code-block"><button type="button" class="code-copy" title="复制代码">复制</button><pre class="hljs">',
    )
    .replace(/<\/pre>/g, '</pre></div>');
  renderCache.set(text, wrapped);
  return wrapped;
}

/** 点击复制按钮时获取对应代码文本（事件委托，由调用方绑定） */
export function getCopyCode(target: HTMLElement): string | null {
  const block = target.closest('.code-block');
  if (!block) return null;
  const pre = block.querySelector('pre');
  return pre ? (pre.textContent ?? null) : null;
}
