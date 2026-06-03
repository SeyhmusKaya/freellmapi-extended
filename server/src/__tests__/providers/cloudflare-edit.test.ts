import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudflareProvider } from '../../providers/cloudflare.js';

const provider = new CloudflareProvider();
const KEY = 'acct_xx:tok_yy';
const SRC_PNG_B64 = Buffer.from('source-png-bytes').toString('base64');
const SRC_DATA_URL = `data:image/png;base64,${SRC_PNG_B64}`;
const OUT_PNG = Buffer.from('output-png-bytes');

describe('CloudflareProvider.editImage', () => {
  let captured: { url: string; body: any } | null = null;

  beforeEach(() => {
    captured = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      captured = { url: typeof input === 'string' ? input : input.url, body: JSON.parse(init.body as string) };
      return new Response(OUT_PNG, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('builds CF /ai/run/<model> URL with account_id', async () => {
    await provider.editImage(KEY, '@cf/runwayml/stable-diffusion-v1-5-inpainting', {
      prompt: 'add a hat', image: SRC_DATA_URL,
    });
    expect(captured!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct_xx/ai/run/@cf/runwayml/stable-diffusion-v1-5-inpainting');
  });

  it('sends prompt + image bytes (array of ints) in body', async () => {
    await provider.editImage(KEY, '@cf/runwayml/stable-diffusion-v1-5-inpainting', {
      prompt: 'add a hat', image: SRC_DATA_URL, strength: 0.8, seed: 7,
    });
    expect(captured!.body.prompt).toBe('add a hat');
    expect(Array.isArray(captured!.body.image)).toBe(true);
    expect(captured!.body.image.length).toBeGreaterThan(0);
    // Verify byte array round-trip matches the decoded source
    const srcBytes = Buffer.from(SRC_PNG_B64, 'base64');
    expect(captured!.body.image).toEqual(Array.from(srcBytes));
    expect(captured!.body.strength).toBe(0.8);
    expect(captured!.body.seed).toBe(7);
  });

  it('includes mask byte array when caller supplies one', async () => {
    const MASK_B64 = Buffer.from('mask-bytes').toString('base64');
    await provider.editImage(KEY, '@cf/runwayml/stable-diffusion-v1-5-inpainting', {
      prompt: 'fix this', image: SRC_DATA_URL, mask: `data:image/png;base64,${MASK_B64}`,
    });
    expect(captured!.body.mask).toBeDefined();
    expect(Array.isArray(captured!.body.mask)).toBe(true);
    expect(captured!.body.mask).toEqual(Array.from(Buffer.from(MASK_B64, 'base64')));
  });

  it('no mask field when mask not provided', async () => {
    await provider.editImage(KEY, '@cf/lykon/dreamshaper-8-lcm', {
      prompt: 'restyle', image: SRC_DATA_URL,
    });
    expect(captured!.body.mask).toBeUndefined();
  });

  it('returns base64-encoded output bytes', async () => {
    const r = await provider.editImage(KEY, '@cf/runwayml/stable-diffusion-v1-5-inpainting', {
      prompt: 'x', image: SRC_DATA_URL,
    });
    expect(r.b64Images).toHaveLength(1);
    expect(r.b64Images[0]).toBe(OUT_PNG.toString('base64'));
    expect(r.mimeType).toBe('image/png');
  });

  it('n>1 calls multiple times', async () => {
    const r = await provider.editImage(KEY, '@cf/runwayml/stable-diffusion-v1-5-inpainting', {
      prompt: 'x', image: SRC_DATA_URL, n: 3,
    });
    expect(r.b64Images).toHaveLength(3);
  });

  it('rejects oversized data URL', async () => {
    const huge = 'a'.repeat(8 * 1024 * 1024);
    await expect(provider.editImage(KEY, '@cf/runwayml/stable-diffusion-v1-5-inpainting', {
      prompt: 'x', image: `data:image/png;base64,${huge}`,
    })).rejects.toThrow(/too large/i);
  });

  it('rejects invalid image scheme', async () => {
    await expect(provider.editImage(KEY, '@cf/runwayml/stable-diffusion-v1-5-inpainting', {
      prompt: 'x', image: 'file:///etc/passwd',
    })).rejects.toThrow(/data:image|http/i);
  });

  it('rejects private host (SSRF guard) on http image', async () => {
    await expect(provider.editImage(KEY, '@cf/runwayml/stable-diffusion-v1-5-inpainting', {
      prompt: 'x', image: 'http://127.0.0.1/cat.png',
    })).rejects.toThrow(/private|loopback/i);
  });

  it('propagates 4xx with extracted message', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ errors: [{ message: 'image too large' }] }), { status: 413, headers: { 'content-type': 'application/json' } }),
    );
    await expect(provider.editImage(KEY, '@cf/runwayml/stable-diffusion-v1-5-inpainting', {
      prompt: 'x', image: SRC_DATA_URL,
    })).rejects.toThrow(/Cloudflare image API error 413/);
  });
});
