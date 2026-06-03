import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudflareProvider } from '../../providers/cloudflare.js';

const KEY = 'acct:tok';

describe('CloudflareProvider.synthesizeSpeech (MeloTTS V32)', () => {
  const provider = new CloudflareProvider();
  let captured: { url: string; body: any } | null = null;
  const SAMPLE_MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x00]);   // tiny MP3 header
  const SAMPLE_B64 = SAMPLE_MP3.toString('base64');

  beforeEach(() => {
    captured = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      captured = { url: typeof input === 'string' ? input : input.url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ result: { audio: SAMPLE_B64 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('hits CF Workers AI run endpoint for melotts', async () => {
    await provider.synthesizeSpeech(KEY, '@cf/myshell-ai/melotts', 'Hello world');
    expect(captured!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/myshell-ai/melotts');
    expect(captured!.body).toMatchObject({ prompt: 'Hello world', lang: 'en' });
  });

  it('maps voice -> lang for recognized ISO codes', async () => {
    await provider.synthesizeSpeech(KEY, '@cf/myshell-ai/melotts', 'Hola', { voice: 'es' });
    expect(captured!.body.lang).toBe('es');
    await provider.synthesizeSpeech(KEY, '@cf/myshell-ai/melotts', 'こんにちは', { voice: 'ja' });
    expect(captured!.body.lang).toBe('ja');
  });

  it('falls back to en when voice is an OpenAI tone name', async () => {
    await provider.synthesizeSpeech(KEY, '@cf/myshell-ai/melotts', 'hi', { voice: 'alloy' });
    expect(captured!.body.lang).toBe('en');
  });

  it('returns Buffer + audio/mpeg mimetype', async () => {
    const r = await provider.synthesizeSpeech(KEY, '@cf/myshell-ai/melotts', 'hello');
    expect(Buffer.isBuffer(r.audio)).toBe(true);
    expect(r.audio.equals(SAMPLE_MP3)).toBe(true);
    expect(r.mimeType).toBe('audio/mpeg');
  });

  it('rejects non-mp3 response_format upfront', async () => {
    await expect(provider.synthesizeSpeech(KEY, '@cf/myshell-ai/melotts', 'hi', { responseFormat: 'opus' as any }))
      .rejects.toThrow(/MeloTTS only supports response_format='mp3'/);
  });

  it('throws on upstream error', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ errors: [{ message: 'AiError: bad input' }] }), { status: 400 }));
    await expect(provider.synthesizeSpeech(KEY, '@cf/myshell-ai/melotts', 'hi'))
      .rejects.toThrow(/Cloudflare TTS API error 400/);
  });
});
