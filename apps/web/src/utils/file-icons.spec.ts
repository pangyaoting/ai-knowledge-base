import { describe, it, expect } from 'vitest';
import { fileExtOf, fileColorOf, fileIconOf, fileBadgeOf } from './file-icons';
import { FileText, FileCode, FileImage, FileArchive, File as FileIcon } from 'lucide-vue-next';

describe('fileExtOf 扩展名提取', () => {
  it('提取小写扩展名', () => {
    expect(fileExtOf('src/Button.ts')).toBe('ts');
    expect(fileExtOf('README.MD')).toBe('md');
  });

  it('无扩展名返回空串', () => {
    expect(fileExtOf('Makefile')).toBe('makefile'); // split('.') 取最后一段
  });
});

describe('fileColorOf 扩展名配色', () => {
  it('已知类型有专属色，未知回退灰色', () => {
    expect(fileColorOf('a.ts')).toBe('#3178c6');
    expect(fileColorOf('a.vue')).toBe('#42b883');
    expect(fileColorOf('a.xyz')).toBe('#8a94a6');
  });
});

describe('fileIconOf 图标类别', () => {
  it('代码文件 → FileCode', () => {
    expect(fileIconOf('a.ts')).toBe(FileCode);
    expect(fileIconOf('a.py')).toBe(FileCode);
  });
  it('图片/PDF → FileImage', () => {
    expect(fileIconOf('a.png')).toBe(FileImage);
    expect(fileIconOf('a.pdf')).toBe(FileImage);
  });
  it('压缩包 → FileArchive', () => {
    expect(fileIconOf('a.zip')).toBe(FileArchive);
  });
  it('文档 → FileText', () => {
    expect(fileIconOf('a.md')).toBe(FileText);
  });
  it('未知 → 通用 FileIcon', () => {
    expect(fileIconOf('a.bin')).toBe(FileIcon);
  });
});

describe('fileBadgeOf Material 风格徽标', () => {
  it('知名扩展名返回品牌缩写 + 品牌色', () => {
    const ts = fileBadgeOf('a.ts')!;
    expect(ts.text).toBe('TS');
    expect(ts.color).toBe('#3178c6');
    expect(ts.darkText).toBe(false); // 蓝底白字
  });

  it('浅色底（JS 黄）自动用深色文字', () => {
    const js = fileBadgeOf('a.js')!;
    expect(js.text).toBe('JS');
    expect(js.darkText).toBe(true);
  });

  it('JSON 用花括号符号', () => {
    expect(fileBadgeOf('a.json')!.text).toBe('{}');
  });

  it('未知扩展名返回 null（回退图标）', () => {
    expect(fileBadgeOf('a.weird')).toBeNull();
  });
});
