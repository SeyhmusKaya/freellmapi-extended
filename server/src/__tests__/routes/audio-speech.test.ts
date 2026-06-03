import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

const SAMPLE_MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x12, 0x34, 0x56, 0x78]);
const SAMPLE_B64 = SAMPLE_MP3.toString('base64');

async function postTts(app: Express, body: any, key?: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/audio/speech`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') ?? '';
  const buf = Buffer.from(await res.arrayBuffer());
  server.close();
  return {
    status: res.status,
    contentType: ct,
    audio: buf,
    routedVia: res.headers.get('x-routed-via'),
    parsedJson: ct.includes('json') ? JSON.parse(buf.toString('utf8')) : null,
  };
}

describe('POST /v1/audio/speech (V32)', () => {
  let app: Express;
  let key: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    const { encrypt } = await import('../../lib/crypto.js');
    const enc = encrypt('acct:tok');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('cloudflare','tts-test',?,?,?,'healthy',1)`).run(enc.encrypted, enc.iv, enc.authTag);
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM requests').run();
    getDb().prepare('DELETE FROM cooldowns').run();
  });

  afterEach(() => vi.restoreAllMocks());

  it('401 without bearer key', async () => {
    const r = await postTts(app, { input: 'hello' });
    expect(r.status).toBe(401);
  });

  it('400 when input missing', async () => {
    const r = await postTts(app, {}, key);
    expect(r.status).toBe(400);
  });

  it('200 returns binary MP3 + X-Routed-Via header', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      if (u.includes('cloudflare.com')) {
        return new Response(JSON.stringify({ result: { audio: SAMPLE_B64 } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    });

    const r = await postTts(app, { input: 'Merhaba dünya', voice: 'en' }, key);
    expect(r.status).toBe(200);
    expect(r.contentType).toBe('audio/mpeg');
    expect(r.audio.equals(SAMPLE_MP3)).toBe(true);
    expect(r.routedVia).toMatch(/cloudflare\/@cf\/myshell-ai\/melotts/);
  });

  it('400 when no TTS models enabled', async () => {
    getDb().prepare("UPDATE models SET enabled=0 WHERE modality='audio_tts'").run();
    const r = await postTts(app, { input: 'x' }, key);
    expect(r.status).toBe(400);
    expect(r.parsedJson?.error?.message).toMatch(/text-to-speech|tts/i);
    getDb().prepare("UPDATE models SET enabled=1 WHERE modality='audio_tts'").run();
  });
});
