import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CohereProvider } from '../../providers/cohere.js';

describe('CohereProvider.rerank (V34)', () => {
  const provider = new CohereProvider();
  let captured: { url: string; body: any; auth: string | null } | null = null;

  beforeEach(() => {
    captured = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      captured = {
        url: u,
        body: JSON.parse(init.body as string),
        auth: init.headers?.Authorization ?? null,
      };
      return new Response(JSON.stringify({
        id: 'mock',
        results: [
          { index: 2, relevance_score: 0.92 },
          { index: 0, relevance_score: 0.55 },
          { index: 1, relevance_score: 0.21 },
        ],
        meta: { billed_units: { search_units: 1 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('POSTs to /v2/rerank with model + query + documents', async () => {
    await provider.rerank('key', 'rerank-v3.5', 'best phone', ['Apple iPhone', 'Banana bread', 'Samsung Galaxy']);
    expect(captured!.url).toBe('https://api.cohere.com/v2/rerank');
    expect(captured!.body).toMatchObject({
      model: 'rerank-v3.5',
      query: 'best phone',
      documents: ['Apple iPhone', 'Banana bread', 'Samsung Galaxy'],
    });
    expect(captured!.auth).toBe('Bearer key');
  });

  it('passes top_n + max_chunks_per_doc when provided', async () => {
    await provider.rerank('key', 'rerank-v3.5', 'q', ['a', 'b'], { topN: 1, maxChunksPerDoc: 5 });
    expect(captured!.body.top_n).toBe(1);
    expect(captured!.body.max_chunks_per_doc).toBe(5);
  });

  it('maps Cohere response into RerankResult shape', async () => {
    const r = await provider.rerank('key', 'rerank-v3.5', 'q', ['a', 'b', 'c']);
    expect(r.results).toHaveLength(3);
    // Cohere returns sorted DESC; we preserve that order
    expect(r.results[0]).toEqual({ index: 2, relevanceScore: 0.92 });
    expect(r.results[1]).toEqual({ index: 0, relevanceScore: 0.55 });
    expect(r.searchUnits).toBe(1);
  });

  it('throws on upstream error', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ message: 'invalid api key' }), { status: 401 }));
    await expect(provider.rerank('k', 'rerank-v3.5', 'q', ['a'])).rejects.toThrow(/Cohere rerank API error 401/);
  });
});
