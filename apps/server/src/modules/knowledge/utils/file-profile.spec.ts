import { buildFileProfile } from './file-profile';

describe('buildFileProfile 文件档案生成（A 语义层）', () => {
  it('md 文档：档案含文件名与章节标题地图', () => {
    const profile = buildFileProfile({
      filename: 'docs/41-学习计划.md',
      fileType: 'md',
      source: `# 学习计划\n\n## W1 语言重修\n\n周一学闭包。\n\n## W2 异步\n`,
    });
    expect(profile).toContain('docs/41-学习计划.md');
    expect(profile).toContain('W1 语言重修');
    expect(profile).toContain('W2 异步');
  });

  it('代码文件：档案含符号清单（中文种类 + 符号名）', () => {
    const profile = buildFileProfile({
      filename: 'Settings.vue',
      fileType: 'code',
      source: '<script>// vue</script>',
      symbols: [
        { kind: 'function', name: 'onAvatarChange', signature: 'onAvatarChange(e: Event)' },
        { kind: 'function', name: 'compressAvatar' },
        { kind: 'const', name: 'avatarUploading' },
        { kind: 'component', name: 'MyCard' },
      ],
    });
    expect(profile).toContain('函数 onAvatarChange');
    expect(profile).toContain('变量/常量 avatarUploading');
    expect(profile).toContain('Vue 组件 MyCard');
  });

  it('无结构内容：回退开头摘要', () => {
    const profile = buildFileProfile({
      filename: 'notes.txt',
      fileType: 'text',
      source: '这是一段很长的普通文本，'.repeat(50),
    });
    expect(profile).toContain('notes.txt');
    expect(profile).toContain('内容摘要');
  });
});
