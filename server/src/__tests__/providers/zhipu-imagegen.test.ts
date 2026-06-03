import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ZhipuProvider } from '../../providers/zhipu.js';

const provider = new ZhipuProvider();
const PNG_BYTES = Buffer.from('cogview-png-bytes');

describe('ZhipuProvider.generateImage', () => {
  let postBody: any = null;
  let postUrl = '';

  beforeEach(() => {
    postBody = null;
    postUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.endsWith('/images/generations')) {
        postUrl = u;
        postBody = JSON.parse(init.body as string);
        // Simulate Zhipu URL response
        return new Response(JSON.stringify({
          created: Date.now(),
          data: [{ url: 'https://zhipu-cdn.test/img/abc.png' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u.startsWith('https://zhipu-cdn.test/')) {
        return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      throw new Error('unexpected fetch: ' + u);
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('POSTs to bigmodel.cn /v4/images/generations with correct body', async () => {
    await provider.generateImage('fake-tok', 'cogview-3-flash', 'a kawaii cat', { size: '1024x1024' });
    expect(postUrl).toBe('https://open.bigmodel.cn/api/paas/v4/images/generations');
    expect(postBody.model).toBe('cogview-3-flash');
    expect(postBody.prompt).toBe('a kawaii cat');
    expect(postBody.size).toBe('1024x1024');
  });

  it('fetches URL response and base64-encodes the bytes', async () => {
    const r = await provider.generateImage('fake-tok', 'cogview-3-flash', 'x');
    expect(r.b64Images[0]).toBe(PNG_BYTES.toString('base64'));
    expect(r.mimeType).toBe('image/png');
  });

  it('accepts b64_json shortcut without secondary fetch', async () => {
    vi.restoreAllMocks();
    let postCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      postCount++;
      const u = typeof input === 'string' ? input : input.url;
      if (u.endsWith('/images/generations')) {
        return new Response(JSON.stringify({
          created: 0,
          data: [{ b64_json: PNG_BYTES.toString('base64') }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('should not fetch image url when b64_json present');
    });
    const r = await provider.generateImage('fake-tok', 'cogview-3-flash', 'x');
    expect(postCount).toBe(1);
    expect(r.b64Images[0]).toBe(PNG_BYTES.toString('base64'));
  });

  it('n>1 issues N posts', async () => {
    const r = await provider.generateImage('fake-tok', 'cogview-3-flash', 'x', { n: 3 });
    expect(r.b64Images.length).toBe(3);
  });

  it('throws on 4xx with extracted message', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429, headers: { 'content-type': 'application/json' } }),
    );
    await expect(provider.generateImage('fake-tok', 'cogview-3-flash', 'x')).rejects.toThrow(/Zhipu image API error 429/);
  });
});
