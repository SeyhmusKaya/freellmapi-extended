import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudflareProvider } from '../../providers/cloudflare.js';

const provider = new CloudflareProvider();
const KEY = 'acct:tok';
const AUDIO = Buffer.from('fake-audio-bytes');

describe('CloudflareProvider.transcribeAudio', () => {
  let captured: { url: string; body: any } | null = null;

  beforeEach(() => {
    captured = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      captured = { url: typeof input === 'string' ? input : input.url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({
        result: {
          text: 'merhaba dünya',
          language: 'tr',
          duration: 1.2,
          words: [
            { word: 'merhaba', start: 0.0, end: 0.5 },
            { word: 'dünya',   start: 0.5, end: 1.0 },
          ],
        },
        success: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('builds CF /ai/run/<model> URL with account_id', async () => {
    await provider.transcribeAudio(KEY, '@cf/openai/whisper-large-v3-turbo', AUDIO);
    expect(captured!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/openai/whisper-large-v3-turbo');
  });

  it('sends audio as base64 string in body (CF 2026 API)', async () => {
    await provider.transcribeAudio(KEY, '@cf/openai/whisper-large-v3-turbo', AUDIO, { language: 'tr' });
    expect(typeof captured!.body.audio).toBe('string');
    expect(captured!.body.audio).toBe(AUDIO.toString('base64'));
    expect(captured!.body.language).toBe('tr');
  });

  it('extracts text + language + segments from response', async () => {
    const r = await provider.transcribeAudio(KEY, '@cf/openai/whisper-large-v3-turbo', AUDIO);
    expect(r.text).toBe('merhaba dünya');
    expect(r.language).toBe('tr');
    expect(r.duration).toBe(1.2);
    expect(r.segments).toHaveLength(2);
    expect(r.segments![0].text).toBe('merhaba');
  });

  it('rejects audio > 25MB', async () => {
    const huge = Buffer.alloc(26 * 1024 * 1024);
    await expect(provider.transcribeAudio(KEY, '@cf/openai/whisper-large-v3-turbo', huge))
      .rejects.toThrow(/too large/);
  });

  it('throws on non-2xx with extracted message', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: 'invalid audio format' }] }), { status: 415, headers: { 'content-type': 'application/json' } }),
    );
    await expect(provider.transcribeAudio(KEY, '@cf/openai/whisper-large-v3-turbo', AUDIO))
      .rejects.toThrow(/Cloudflare audio API error 415/);
  });
});
