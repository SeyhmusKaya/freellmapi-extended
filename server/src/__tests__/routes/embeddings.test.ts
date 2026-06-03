import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

async function postEmbed(app: Express, body: any, key?: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/embeddings`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const txt = await res.text();
  server.close();
  let data: any = null;
  try { data = txt ? JSON.parse(txt) : null; } catch {}
  return { status: res.status, body: data, headers: res.headers };
}

const VEC_1024 = Array.from({ length: 1024 }, (_, i) => i / 1024);

describe('POST /v1/embeddings', () => {
  let app: Express;
  let key: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    // Seed a CF key so cascade has at least one route
    const { encrypt } = await import('../../lib/crypto.js');
    const enc = encrypt('acct:tok');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('cloudflare','embed-test',?,?,?,'healthy',1)`).run(enc.encrypted, enc.iv, enc.authTag);
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM cooldowns').run();
    db.prepare('DELETE FROM usage_counters').run();
  });

  afterEach(() => vi.restoreAllMocks());

  it('401 without bearer key', async () => {
    const r = await postEmbed(app, { input: 'hello' });
    expect(r.status).toBe(401);
  });

  it('400 when input missing', async () => {
    const r = await postEmbed(app, {} as any, key);
    expect(r.status).toBe(400);
  });

  it('200 returns OpenAI-compatible response shape for single input', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      if (u.includes('cloudflare.com')) {
        return new Response(JSON.stringify({ result: { data: [VEC_1024], shape: [1, 1024] }, success: true }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    });

    const r = await postEmbed(app, { input: 'hello world' }, key);
    expect(r.status).toBe(200);
    expect(r.body.object).toBe('list');
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].object).toBe('embedding');
    expect(r.body.data[0].index).toBe(0);
    expect(r.body.data[0].embedding).toHaveLength(1024);
    expect(r.body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(r.body._routed_via.platform).toBe('cloudflare');
  });

  it('200 batch input returns one vector per input, order preserved', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      const body = JSON.parse(init.body as string);
      const n = body.text.length;
      const vecs = Array.from({ length: n }, () => VEC_1024);
      return new Response(JSON.stringify({ result: { data: vecs, shape: [n, 1024] }, success: true }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const r = await postEmbed(app, { input: ['a', 'b', 'c'] }, key);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(3);
    expect(r.body.data.map((d: any) => d.index)).toEqual([0, 1, 2]);
  });

  it('400 when no embedding models enabled', async () => {
    const db = getDb();
    db.prepare("UPDATE models SET enabled=0 WHERE modality='embedding'").run();
    const r = await postEmbed(app, { input: 'x' }, key);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/embedding/i);
    db.prepare("UPDATE models SET enabled=1 WHERE modality='embedding'").run();
  });

  it('model pin to specific catalog id', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      return new Response(JSON.stringify({ result: { data: [VEC_1024] } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const r = await postEmbed(app, { model: '@cf/baai/bge-m3', input: 'x' }, key);
    expect(r.status).toBe(200);
    expect(r.body._routed_via.model).toBe('@cf/baai/bge-m3');
  });
});
