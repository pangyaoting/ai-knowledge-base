import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** 联网检索结果条目 */
export interface WebSource {
  title: string;
  url: string;
  content: string;
  score?: number;
}

/**
 * 联网检索服务（Tavily API）
 *
 * 为什么选 Tavily：
 * - 专为 LLM/Agent 设计的搜索 API，返回干净的"标题+URL+内容摘要"，不需要自己解析 HTML
 * - 免费额度 1000 次/月，学生项目够用
 * - 对比：自己抓 DuckDuckGo/Bing 不稳定且可能被反爬
 *
 * 设计：key 在 .env 的 TAVILY_API_KEY 配置；
 * 未配置 key 时 search() 返回空数组，问答自动退化为"纯知识库检索"，不影响主流程
 */
@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name);
  private readonly API_URL = 'https://api.tavily.com/search';

  constructor(private configService: ConfigService) {}

  private get apiKey(): string {
    return this.configService.get<string>('TAVILY_API_KEY', '');
  }

  /** 联网搜索，失败/无 key 返回空数组（不阻断主流程） */
  async search(query: string, maxResults = 5): Promise<WebSource[]> {
    const key = this.apiKey;
    if (!key) {
      return [];
    }
    try {
      const res = await fetch(this.API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          query,
          max_results: maxResults,
          search_depth: 'basic',
        }),
      });
      if (!res.ok) {
        this.logger.warn(`联网搜索失败: HTTP ${res.status}`);
        return [];
      }
      const data = (await res.json()) as {
        results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
      };
      return (data.results ?? [])
        .filter((r) => r.title && r.url && r.content)
        .map((r) => ({
          title: r.title!,
          url: r.url!,
          content: r.content!,
          score: r.score,
        }));
    } catch (err) {
      this.logger.warn(`联网搜索异常: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * 网页正文提取（Tavily Extract API）：自主研究 Agent 精读用。
   * 拿不到正文（无 key / 免费额度限制 / 页面无法提取）时返回 null，调用方回退到搜索摘要。
   */
  async extract(url: string): Promise<string | null> {
    const key = this.apiKey;
    if (!key) return null;
    try {
      const res = await fetch('https://api.tavily.com/extract', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ urls: [url], extract_depth: 'basic' }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        this.logger.warn(`网页提取失败: HTTP ${res.status}（${url.slice(0, 60)}）`);
        return null;
      }
      const data = (await res.json()) as {
        results?: Array<{ raw_content?: string | null }>;
      };
      const raw = data.results?.[0]?.raw_content?.trim();
      return raw && raw.length > 200 ? raw : null;
    } catch (err) {
      this.logger.warn(`网页提取异常: ${(err as Error).message}`);
      return null;
    }
  }
}
