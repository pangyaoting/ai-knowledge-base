import { cleanText, sanitizeControlChars } from './document-parser';

describe('sanitizeControlChars 控制字符清洗', () => {
  it('删除 NUL（\\u0000）——PG text 禁止存储的字符', () => {
    expect(sanitizeControlChars('a\u0000b')).toBe('ab');
    expect(sanitizeControlChars('\u0000')).toBe('');
  });

  it('删除其他 C0 控制字符，保留 \\t \\n', () => {
    const input = 'a\u0001b\u0007c\td\ne\u001f';
    expect(sanitizeControlChars(input)).toBe('abc\td\ne');
  });

  it('普通文本原样返回', () => {
    const text = 'const a = 1; // 正常代码\n第二行';
    expect(sanitizeControlChars(text)).toBe(text);
  });
});

describe('cleanText 文本清洗', () => {
  it('统一换行并删除控制字符', () => {
    expect(cleanText('a\r\nb\u0000c')).toBe('a\nbc');
  });

  it('连续空格/空行折叠后 trim', () => {
    expect(cleanText('  a   b\n\n\nc  ')).toBe('a b\n\nc');
  });
});
