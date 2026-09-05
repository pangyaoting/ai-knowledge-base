import { describe, it, expect } from 'vitest';
import { renderMarkdown, getCopyCode } from './markdown';

describe('renderMarkdown AI 回答渲染', () => {
  it('渲染标题/加粗/列表', () => {
    const html = renderMarkdown('# 标题\n\n**加粗**\n\n- 项一\n- 项二');
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('<li>项一</li>');
  });

  it('代码块自动包 code-block 容器 + 复制按钮', () => {
    const html = renderMarkdown('```ts\nconst a = 1;\n```');
    expect(html).toContain('code-block');
    expect(html).toContain('code-copy');
    expect(html).toContain('hljs');
    // 复制按钮插在 <pre> 前
    expect(html.indexOf('code-copy')).toBeLessThan(html.indexOf('<pre'));
  });

  it('语言未知时转义 HTML，防注入', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```');
    // 绝不能出现可执行的 script 标签（自动检测高亮后同样必须转义）
    expect(html).not.toMatch(/<script[\s>]/);
    // 标签符号已转义为 &lt;（hljs 高亮会在 &lt; 后插入 span，不能断言连续字符串）
    expect(html).toContain('&lt;');
  });

  it('禁用原始 HTML（html: false 防注入）', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('换行渲染为 <br>（AI 回答友好）', () => {
    const html = renderMarkdown('第一行\n第二行');
    expect(html).toContain('<br>');
  });
});

describe('getCopyCode 复制按钮取码', () => {
  it('从 code-block 内取出代码文本', () => {
    const container = document.createElement('div');
    container.innerHTML = '<div class="code-block"><pre><code>const x = 1;</code></pre></div>';
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    container.querySelector('.code-block')!.appendChild(btn);
    expect(getCopyCode(btn)).toBe('const x = 1;');
  });

  it('不在 code-block 内返回 null', () => {
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    expect(getCopyCode(btn)).toBeNull();
  });
});
