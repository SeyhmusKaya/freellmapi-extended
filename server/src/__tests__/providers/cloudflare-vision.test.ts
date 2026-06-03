import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudflareProvider } from '../../providers/cloudflare.js';

const provider = new CloudflareProvider();
const KEY = 'acct_id_xxx:token_yyy';

describe('Cloudflare vision (http→base64 inline)', () => {
  let body: any = null;

  beforeEach(() => {
    body = null;
  });

  afterEach(() => vi.restoreAllMocks());

  it('fetches http(s) image and inlines as data URL before forwarding', async () => {
    const imageBytes = Buffer.from('fake-png-bytes');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.startsWith('https://example.com/')) {
        return new Response(imageBytes, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      // CF chat endpoint
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await provider.chatCompletion(KEY, [
      { role: 'user', content: [
        { type: 'text', text: 'what?' },
        { type: 'image_url', image_url: { url: 'https://example.com/photo.png' } },
      ]},
    ], '@cf/meta/llama-4-scout-17b-16e-instruct');

    const sent = body.messages[0].content;
    expect(Array.isArray(sent)).toBe(true);
    const img = sent.find((p: any) => p.type === 'image_url');
    expect(img.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(img.image_url.url).toContain(imageBytes.toString('base64'));
  });

  it('passes data URL through untouched (no extra fetch)', async () => {
    let imageFetches = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (!u.includes('cloudflare')) imageFetches++;
      body = init.body ? JSON.parse(init.body as string) : null;
      return new Response(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await provider.chatCompletion(KEY, [
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ]},
    ], '@cf/meta/llama-4-scout-17b-16e-instruct');

    expect(imageFetches).toBe(0);
    expect(body.messages[0].content[0].image_url.url).toBe('data:image/png;base64,AAAA');
  });

  it('rejects private host (SSRF guard)', async () => {
    await expect(provider.chatCompletion(KEY, [
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: 'http://127.0.0.1:80/x.png' } },
      ]},
    ], '@cf/meta/llama-4-scout-17b-16e-instruct')).rejects.toThrow(/private|loopback/i);

    await expect(provider.chatCompletion(KEY, [
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: 'http://169.254.169.254/meta' } },
      ]},
    ], '@cf/meta/llama-4-scout-17b-16e-instruct')).rejects.toThrow(/private|loopback/i);
  });

  it('rejects oversized remote image (>5MB)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(Buffer.alloc(6 * 1024 * 1024), { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    await expect(provider.chatCompletion(KEY, [
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: 'https://example.com/big.png' } },
      ]},
    ], '@cf/meta/llama-4-scout-17b-16e-instruct')).rejects.toThrow(/too large/i);
  });

  it('plain string content unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: any, init: any) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await provider.chatCompletion(KEY, [{ role: 'user', content: 'hello' }], '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    expect(body.messages[0].content).toBe('hello');
  });
});
