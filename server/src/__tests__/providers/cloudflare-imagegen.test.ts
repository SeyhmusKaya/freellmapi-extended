import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudflareProvider } from '../../providers/cloudflare.js';

const provider = new CloudflareProvider();
const KEY = 'acct_id_xxx:token_yyy';

describe('CloudflareProvider.generateImage', () => {
  let captured: { url: string; body: any } | null = null;
  const PNG_BYTES = Buffer.from('fake-png-bytes');

  beforeEach(() => {
    captured = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      captured = { url: typeof input === 'string' ? input : input.url, body: JSON.parse(init.body as string) };
      return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('builds correct CF AI endpoint URL with account_id', async () => {
    await provider.generateImage(KEY, '@cf/black-forest-labs/flux-1-schnell', 'a cat');
    expect(captured!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct_id_xxx/ai/run/@cf/black-forest-labs/flux-1-schnell');
  });

  it('sends prompt + size + num_steps + seed in body', async () => {
    await provider.generateImage(KEY, '@cf/black-forest-labs/flux-1-schnell', 'a kawaii dog', {
      size: '1024x768',
      seed: 42,
      negative_prompt: 'blurry',
    });
    expect(captured!.body.prompt).toBe('a kawaii dog');
    expect(captured!.body.width).toBe(1024);
    expect(captured!.body.height).toBe(768);
    expect(captured!.body.num_steps).toBe(4);  // flux-1-schnell uses 4 steps
    expect(captured!.body.seed).toBe(42);
    expect(captured!.body.negative_prompt).toBe('blurry');
  });

  it('uses model-specific step counts', async () => {
    await provider.generateImage(KEY, '@cf/stabilityai/stable-diffusion-xl-base-1.0', 'x');
    expect(captured!.body.num_steps).toBe(30);

    await provider.generateImage(KEY, '@cf/bytedance/stable-diffusion-xl-lightning', 'x');
    expect(captured!.body.num_steps).toBe(8);

    await provider.generateImage(KEY, '@cf/lykon/dreamshaper-8-lcm', 'x');
    expect(captured!.body.num_steps).toBe(4);
  });

  it('encodes binary response to base64', async () => {
    const result = await provider.generateImage(KEY, '@cf/black-forest-labs/flux-1-schnell', 'x');
    expect(result.b64Images).toHaveLength(1);
    expect(result.b64Images[0]).toBe(PNG_BYTES.toString('base64'));
    expect(result.mimeType).toBe('image/png');
  });

  it('n>1 calls multiple times', async () => {
    const result = await provider.generateImage(KEY, '@cf/black-forest-labs/flux-1-schnell', 'x', { n: 3 });
    expect(result.b64Images).toHaveLength(3);
  });

  it('clamps n to [1, 4]', async () => {
    const r5 = await provider.generateImage(KEY, '@cf/black-forest-labs/flux-1-schnell', 'x', { n: 5 });
    expect(r5.b64Images).toHaveLength(4);
    const r0 = await provider.generateImage(KEY, '@cf/black-forest-labs/flux-1-schnell', 'x', { n: 0 as any });
    expect(r0.b64Images).toHaveLength(1);
  });

  it('throws on non-2xx with extracted message', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ errors: [{ message: 'quota exceeded' }] }), { status: 429, headers: { 'content-type': 'application/json' } }),
    );
    await expect(provider.generateImage(KEY, '@cf/black-forest-labs/flux-1-schnell', 'x'))
      .rejects.toThrow(/Cloudflare image API error 429/);
  });

  it('throws on bad key format', async () => {
    await expect(provider.generateImage('badkey-no-colon', '@cf/black-forest-labs/flux-1-schnell', 'x'))
      .rejects.toThrow(/Cloudflare key must be in format/);
  });
});
