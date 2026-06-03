import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudflareProvider } from '../../providers/cloudflare.js';
import { CohereProvider } from '../../providers/cohere.js';
import { GoogleProvider } from '../../providers/google.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';

/**
 * Per-provider embed() unit tests. Each mocks globalThis.fetch and checks:
 *  - request URL + body shape match the provider's spec
 *  - response is mapped into our common EmbedResult shape
 *  - dimensions reported correctly
 */

const SAMPLE_VECTOR_A = Array.from({ length: 1024 }, (_, i) => i / 1024);
const SAMPLE_VECTOR_B = Array.from({ length: 1024 }, (_, i) => 1 - i / 1024);

describe('CloudflareProvider.embed', () => {
  const provider = new CloudflareProvider();
  let captured: { url: string; body: any } | null = null;

  beforeEach(() => {
    captured = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      captured = { url: typeof input === 'string' ? input : input.url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ result: { data: [SAMPLE_VECTOR_A, SAMPLE_VECTOR_B], shape: [2, 1024] }, success: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('hits CF Workers AI run endpoint for BGE-M3', async () => {
    await provider.embed('acct:tok', '@cf/baai/bge-m3', ['hello', 'world']);
    expect(captured!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/baai/bge-m3');
    expect(captured!.body).toEqual({ text: ['hello', 'world'] });
  });

  it('maps response into vectors + dimensions', async () => {
    const r = await provider.embed('acct:tok', '@cf/baai/bge-m3', ['a', 'b']);
    expect(r.vectors).toHaveLength(2);
    expect(r.dimensions).toBe(1024);
    expect(r.vectors[0]).toEqual(SAMPLE_VECTOR_A);
  });

  it('throws on upstream error', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ errors: [{ message: 'AiError: bad model' }] }), { status: 400 }));
    await expect(provider.embed('acct:tok', '@cf/baai/bge-m3', ['a']))
      .rejects.toThrow(/Cloudflare embed API error 400/);
  });
});

describe('OpenAICompatProvider.embed (Mistral / Zhipu / GitHub shape)', () => {
  const provider = new OpenAICompatProvider({
    platform: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
  });
  let captured: { url: string; body: any } | null = null;

  beforeEach(() => {
    captured = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      captured = { url: typeof input === 'string' ? input : input.url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({
        object: 'list',
        data: [
          { object: 'embedding', index: 0, embedding: SAMPLE_VECTOR_A },
          { object: 'embedding', index: 1, embedding: SAMPLE_VECTOR_B },
        ],
        model: 'mistral-embed',
        usage: { prompt_tokens: 7, total_tokens: 7 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('POSTs to {baseUrl}/embeddings with model + input array', async () => {
    await provider.embed('key', 'mistral-embed', ['a', 'b']);
    expect(captured!.url).toBe('https://api.mistral.ai/v1/embeddings');
    expect(captured!.body).toMatchObject({ model: 'mistral-embed', input: ['a', 'b'] });
  });

  it('passes optional dimensions field through', async () => {
    await provider.embed('key', 'mistral-embed', ['x'], { dimensions: 512 });
    expect(captured!.body.dimensions).toBe(512);
  });

  it('preserves input order even if upstream reorders by index', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({
        data: [
          { embedding: SAMPLE_VECTOR_B, index: 1 },
          { embedding: SAMPLE_VECTOR_A, index: 0 },
        ],
        usage: { prompt_tokens: 4 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await provider.embed('key', 'mistral-embed', ['a', 'b']);
    expect(r.vectors[0]).toEqual(SAMPLE_VECTOR_A);   // index 0 first
    expect(r.vectors[1]).toEqual(SAMPLE_VECTOR_B);
  });

  it('uses upstream prompt_tokens when available', async () => {
    const r = await provider.embed('key', 'mistral-embed', ['a', 'b']);
    expect(r.promptTokens).toBe(7);
  });

  it('throws on upstream error', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 }));
    await expect(provider.embed('key', 'mistral-embed', ['a'])).rejects.toThrow(/Mistral embed API error 401/);
  });
});

describe('CohereProvider.embed', () => {
  const provider = new CohereProvider();
  let captured: { url: string; body: any } | null = null;

  beforeEach(() => {
    captured = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      captured = { url: typeof input === 'string' ? input : input.url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({
        embeddings: { float: [SAMPLE_VECTOR_A, SAMPLE_VECTOR_B] },
        meta: { billed_units: { input_tokens: 12 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('POSTs to native /v2/embed with texts + input_type + float embedding_type', async () => {
    await provider.embed('key', 'embed-multilingual-v3.0', ['a', 'b']);
    expect(captured!.url).toBe('https://api.cohere.com/v2/embed');
    expect(captured!.body).toMatchObject({
      model: 'embed-multilingual-v3.0',
      texts: ['a', 'b'],
      input_type: 'search_document',  // default
      embedding_types: ['float'],
    });
  });

  it('honors caller-provided input_type', async () => {
    await provider.embed('key', 'embed-v4.0', ['q'], { inputType: 'search_query' });
    expect(captured!.body.input_type).toBe('search_query');
  });

  it('uses meta.billed_units.input_tokens for usage', async () => {
    const r = await provider.embed('key', 'embed-v4.0', ['a']);
    expect(r.promptTokens).toBe(12);
  });
});

describe('GoogleProvider.embed', () => {
  const provider = new GoogleProvider();
  let captured: { url: string; body: any } | null = null;

  beforeEach(() => {
    captured = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      captured = { url: typeof input === 'string' ? input : input.url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({
        embeddings: [
          { values: SAMPLE_VECTOR_A },
          { values: SAMPLE_VECTOR_B },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('hits :batchEmbedContents with API key in query', async () => {
    await provider.embed('aiz-test-key', 'gemini-embedding-001', ['a', 'b']);
    expect(captured!.url).toContain('models/gemini-embedding-001:batchEmbedContents');
    expect(captured!.url).toContain('key=aiz-test-key');
    expect(captured!.body.requests).toHaveLength(2);
    expect(captured!.body.requests[0]).toMatchObject({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text: 'a' }] },
    });
  });

  it('passes outputDimensionality when dimensions specified', async () => {
    await provider.embed('k', 'gemini-embedding-001', ['x'], { dimensions: 512 });
    expect(captured!.body.requests[0].outputDimensionality).toBe(512);
  });
});
