import { describe, expect, it, vi } from 'vitest';

import { runMemoryConsolidation, writeToNotion } from './api';

describe('api integration helpers', () => {
  it('posts memory consolidation requests to the ai service endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ projectId: 'p1', summary: { total: 0 } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runMemoryConsolidation('p1', { supermemoryApiKey: 'sm' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai/memory/consolidate',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.projectId).toBe('p1');
  });

  it('posts notion writeback requests to the ai service endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', result: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await writeToNotion({
      action: 'create_page',
      payload: { parent: { type: 'page_id', page_id: 'page-1' } },
      settings: { notionApiKey: 'secret' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai/notion/writeback',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.status).toBe('ok');
  });
});
