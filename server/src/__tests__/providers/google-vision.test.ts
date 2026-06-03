import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleProvider } from '../../providers/google.js';

const provider = new GoogleProvider();

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function captureRequest(): { url: string | null; body: any } {
  return { url: null, body: null };
}

describe('GoogleProvider vision', () => {
  let captured: { url: string | null; body: any };

  beforeEach(() => {
    captured = captureRequest();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      captured.url = typeof input === 'string' ? input : input.url;
      captured.body = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'a cat' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('translates data URL image to inline_data part', async () => {
    await provider.chatCompletion('fake-key', [
      { role: 'user', content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG_BASE64}` } },
      ]},
    ], 'gemini-2.5-flash');

    expect(captured.body.contents).toHaveLength(1);
    const parts = captured.body.contents[0].parts;
    expect(parts[0]).toEqual({ text: 'what is this?' });
    expect(parts[1].inline_data).toEqual({ mime_type: 'image/png', data: TINY_PNG_BASE64 });
  });

  it('fetches http image and base64-encodes into inline_data', async () => {
    const imageBytes = Buffer.from('fake-jpg-bytes');
    let pictureFetchCount = 0;
    let geminiBody: any = null;

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.startsWith('https://example.com/')) {
        pictureFetchCount++;
        return new Response(imageBytes, {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      geminiBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await provider.chatCompletion('fake-key', [
      { role: 'user', content: [
        { type: 'text', text: 'caption this' },
        { type: 'image_url', image_url: { url: 'https://example.com/x.jpg' } },
      ]},
    ], 'gemini-2.5-flash');

    expect(pictureFetchCount).toBe(1);
    const parts = geminiBody.contents[0].parts;
    expect(parts[1].inline_data.mime_type).toBe('image/jpeg');
    expect(parts[1].inline_data.data).toBe(imageBytes.toString('base64'));
  });

  it('throws on private/loopback URL (SSRF guard)', async () => {
    await expect(provider.chatCompletion('fake-key', [
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: 'http://127.0.0.1:8080/secret.jpg' } },
      ]},
    ], 'gemini-2.5-flash')).rejects.toThrow(/private|loopback/i);

    await expect(provider.chatCompletion('fake-key', [
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: 'http://169.254.169.254/latest/meta-data/' } },
      ]},
    ], 'gemini-2.5-flash')).rejects.toThrow(/private|loopback/i);

    await expect(provider.chatCompletion('fake-key', [
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: 'http://192.168.1.1/' } },
      ]},
    ], 'gemini-2.5-flash')).rejects.toThrow(/private|loopback/i);
  });

  it('rejects unsupported image MIME', async () => {
    await expect(provider.chatCompletion('fake-key', [
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/tiff;base64,AAAA' } },
      ]},
    ], 'gemini-2.5-flash')).rejects.toThrow(/MIME not allowed/);
  });

  it('rejects data URL exceeding 5MB', async () => {
    const huge = 'a'.repeat(8 * 1024 * 1024); // ~6MB after base64 decode
    await expect(provider.chatCompletion('fake-key', [
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${huge}` } },
      ]},
    ], 'gemini-2.5-flash')).rejects.toThrow(/too large/i);
  });

  it('preserves part ordering: text, image, text', async () => {
    await provider.chatCompletion('fake-key', [
      { role: 'user', content: [
        { type: 'text', text: 'first' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${TINY_PNG_BASE64}` } },
        { type: 'text', text: 'second' },
      ]},
    ], 'gemini-2.5-flash');

    const parts = captured.body.contents[0].parts;
    expect(parts[0]).toEqual({ text: 'first' });
    expect(parts[1].inline_data).toBeDefined();
    expect(parts[2]).toEqual({ text: 'second' });
  });

  it('still works with plain string content (no array)', async () => {
    await provider.chatCompletion('fake-key', [
      { role: 'user', content: 'hello' },
    ], 'gemini-2.5-flash');

    const parts = captured.body.contents[0].parts;
    expect(parts[0]).toEqual({ text: 'hello' });
  });
});
