import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

const AUDIO_B64 = Buffer.from('fake-wav').toString('base64');
const AUDIO_DATA_URL = `data:audio/wav;base64,${AUDIO_B64}`;

async function request(app: Express, body: any, key?: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}/v1/audio/transcriptions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  server.close();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, body: data, raw: text, headers: res.headers };
}

describe('POST /v1/audio/transcriptions', () => {
  let app: Express;
  let key: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    // Add CF key so audio_stt has a route
    await request(app, { audio: AUDIO_DATA_URL }, undefined); // 401 priming
    const reqInit = await fetch(`http://127.0.0.1:0`).catch(() => null); void reqInit;
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM cooldowns').run();
    db.prepare('DELETE FROM usage_counters').run();
  });

  afterEach(() => vi.restoreAllMocks());

  it('401 without bearer', async () => {
    const r = await request(app, { audio: AUDIO_DATA_URL });
    expect(r.status).toBe(401);
  });

  it('400 invalid audio scheme', async () => {
    const r = await request(app, { audio: 'file:///etc/passwd' }, key);
    expect(r.status).toBe(400);
  });

  it('400 when no audio model enabled', async () => {
    const db = getDb();
    db.prepare("UPDATE models SET enabled = 0 WHERE modality = 'audio_stt'").run();
    const r = await request(app, { audio: AUDIO_DATA_URL }, key);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/No audio-transcription/);
    db.prepare("UPDATE models SET enabled = 1 WHERE modality = 'audio_stt'").run();
  });

  it('200 returns text from CF Whisper', async () => {
    // seed CF key
    const { encrypt } = await import('../../lib/crypto.js');
    const enc = encrypt('acct:tok');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('cloudflare','aud-test',?,?,?,'healthy',1)`).run(enc.encrypted, enc.iv, enc.authTag);

    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      return new Response(JSON.stringify({ result: { text: 'hello world', language: 'en', duration: 0.8 }, success: true }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const r = await request(app, { audio: AUDIO_DATA_URL, language: 'en' }, key);
    expect(r.status).toBe(200);
    expect(r.body.text).toBe('hello world');
    expect(r.body._routed_via.platform).toBe('cloudflare');
  });

  it('response_format=text returns plain text', async () => {
    const { encrypt } = await import('../../lib/crypto.js');
    const enc = encrypt('acct:tok');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('cloudflare','aud-test',?,?,?,'healthy',1)`).run(enc.encrypted, enc.iv, enc.authTag);

    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      return new Response(JSON.stringify({ result: { text: 'plain text result' }, success: true }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const r = await request(app, { audio: AUDIO_DATA_URL, response_format: 'text' }, key);
    expect(r.status).toBe(200);
    expect(r.raw).toBe('plain text result');
    expect(r.headers.get('content-type')).toContain('text/plain');
  });

  it('response_format=verbose_json includes segments + language', async () => {
    const { encrypt } = await import('../../lib/crypto.js');
    const enc = encrypt('acct:tok');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('cloudflare','aud-test',?,?,?,'healthy',1)`).run(enc.encrypted, enc.iv, enc.authTag);

    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      return new Response(JSON.stringify({
        result: {
          text: 'a b',
          language: 'tr',
          duration: 0.5,
          words: [{ word: 'a', start: 0, end: 0.1 }, { word: 'b', start: 0.1, end: 0.2 }],
        },
        success: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const r = await request(app, { audio: AUDIO_DATA_URL, response_format: 'verbose_json' }, key);
    expect(r.status).toBe(200);
    expect(r.body.text).toBe('a b');
    expect(r.body.language).toBe('tr');
    expect(r.body.duration).toBe(0.5);
    expect(r.body.segments).toHaveLength(2);
  });
});
