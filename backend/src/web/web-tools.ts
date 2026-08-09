import type { BaseTool } from '../agent/base-agent.service';
import type { WebService } from './web.service';

/** Agent-facing web tools (DIRECTION items 1 + 4). */
export function buildWebTools(web: WebService): BaseTool[] {
  return [
    {
      name: 'fetch_url',
      description:
        'Fetch an http(s) URL and return its rendered page text (CDP-first, ' +
        'http fallback, ~8k chars). Use for reading a web page, API endpoint, ' +
        'or documentation while answering. args: { url: string }.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description:
              'Absolute http(s) URL to fetch, e.g. https://example.com/doc.',
          },
        },
        required: ['url'],
      },
      run: async (args: Record<string, unknown>) => {
        const url = typeof args.url === 'string' ? args.url.trim() : '';
        if (!url) throw new Error('url must be a non-empty string');
        return web.fetchUrl(url);
      },
    },
    {
      name: 'web_search',
      description:
        'Search the web for a query and return the rendered result page text ' +
        '(DuckDuckGo HTML first; when it bot-blocks, Bing RSS; CDP-first, ' +
        'http fallback, ~8k chars). Use for lookups before or instead of ' +
        'guessing. args: { query: string }.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Free-text search query, e.g. "nestjs schedule docs".',
          },
        },
        required: ['query'],
      },
      run: async (args: Record<string, unknown>) => {
        const query = typeof args.query === 'string' ? args.query : '';
        return web.webSearch(query);
      },
    },
  ];
}
