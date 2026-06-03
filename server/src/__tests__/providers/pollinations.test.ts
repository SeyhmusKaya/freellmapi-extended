import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PollinationsProvider } from '../../providers/pollinations.js';

const provider = new PollinationsProvider();
const JPG = Buffer.from('fake-jpg-bytes');

describe('PollinationsProvider', () => {
  let captured: { url: string; method: string } | null = null;

  beforeEach(() => {
    captured = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      captured = { url: typeof input === 'string' ? input : input.url, method: init?.method ?? 'GET' };
      return new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('requiresApiKey is false', () => {
    expect(provider.requiresApiKey).toBe(false);
  });

  it('uses GET with prompt URL-encoded into path', async () => {
    await provider.generateImage('', 'pollinations/flux', 'a kawaii cat', { size: '1024x1024' });
    expect(captured!.method).toBe('GET');
    expect(captured!.url.startsWith('https://image.pollinations.ai/prompt/')).toBe(true);
    expect(captured!.url).toContain(encodeURIComponent('a kawaii cat'));
  });

  it('includes width/height/model/nologo/private in query string', async () => {
    await provider.generateImage('', 'pollinations/flux', 'x', { size: '768x1024' });
    expect(captured!.url).toContain('width=768');
    expect(captured!.url).toContain('height=1024');
    expect(captured!.url).toContain('model=flux');
    expect(captured!.url).toContain('nologo=true');
    expect(captured!.url).toContain('private=true');
  });

  it('strips pollinations/ prefix from model id when sending to upstream', async () => {
    await provider.generateImage('', 'pollinations/flux-realism', 'x');
    expect(captured!.url).toContain('model=flux-realism');
    expect(captured!.url).not.toContain('model=pollinations');
  });

  it('encodes seed and negative_prompt', async () => {
    await provider.generateImage('', 'pollinations/flux', 'x', { seed: 7, negative_prompt: 'blurry' });
    expect(captured!.url).toContain('seed=7');
    expect(captured!.url).toContain('negative_prompt=blurry');
  });

  it('n>1 calls multiple times with offset seeds', async () => {
    const urls: string[] = [];
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      urls.push(typeof input === 'string' ? input : input.url);
      return new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
    const r = await provider.generateImage('', 'pollinations/turbo', 'x', { seed: 100, n: 3 });
    expect(r.b64Images).toHaveLength(3);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('seed=100');
    expect(urls[1]).toContain('seed=101');
    expect(urls[2]).toContain('seed=102');
  });

  it('returns base64 of binary response', async () => {
    const r = await provider.generateImage('', 'pollinations/flux', 'x');
    expect(r.b64Images[0]).toBe(JPG.toString('base64'));
    expect(r.mimeType).toBe('image/jpeg');
  });

  it('throws on non-2xx response', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('bad request', { status: 400, statusText: 'Bad Request' }),
    );
    await expect(provider.generateImage('', 'pollinations/flux', 'x')).rejects.toThrow(/Pollinations.ai error 400/);
  });

  it('chatCompletion throws explicit error', async () => {
    await expect(provider.chatCompletion()).rejects.toThrow(/does not support chat/);
  });

  it('validateKey returns true (no key)', async () => {
    expect(await provider.validateKey('')).toBe(true);
  });
});
