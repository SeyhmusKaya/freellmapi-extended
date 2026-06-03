import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

async function postRerank(app: Express, body: any, key?: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/rerank`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const txt = await res.text();
  server.close();
  let data: any = null;
  try { data = txt ? JSON.parse(txt) : null; } catch {}
  return { status: res.status, body: data };
}

describe('POST /v1/rerank (V34)', () => {
  let app: Express;
  let key: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    const { encrypt } = await import('../../lib/crypto.js');
    const enc = encrypt('cohere-test-key');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('cohere','rerank-test',?,?,?,'healthy',1)`).run(enc.encrypted, enc.iv, enc.authTag);
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM requests').run();
    getDb().prepare('DELETE FROM cooldowns').run();
  });

  afterEach(() => vi.restoreAllMocks());

  it('401 without bearer key', async () => {
    const r = await postRerank(app, { query: 'q', documents: ['a', 'b'] });
    expect(r.status).toBe(401);
  });

  it('400 when query missing', async () => {
    const r = await postRerank(app, { documents: ['a'] }, key);
    expect(r.status).toBe(400);
  });

  it('400 when documents empty array', async () => {
    const r = await postRerank(app, { query: 'q', documents: [] }, key);
    expect(r.status).toBe(400);
  });

  it('200 returns sorted results + usage + _routed_via', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      if (u.includes('cohere.com')) {
        return new Response(JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.8 },
            { index: 0, relevance_score: 0.4 },
          ],
          meta: { billed_units: { search_units: 1 } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    });
    const r = await postRerank(app, {
      query: 'best phone',
      documents: ['Apple iPhone', 'Samsung Galaxy'],
    }, key);
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(2);
    expect(r.body.results[0].index).toBe(1);
    expect(r.body.results[0].relevance_score).toBe(0.8);
    expect(r.body._routed_via.platform).toBe('cohere');
    expect(r.body.usage.search_units).toBe(1);
  });

  it('return_documents echoes source text', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      return new Response(JSON.stringify({
        results: [{ index: 0, relevance_score: 1.0 }],
        meta: { billed_units: { search_units: 1 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const r = await postRerank(app, {
      query: 'q', documents: ['hello'], return_documents: true,
    }, key);
    expect(r.status).toBe(200);
    expect(r.body.results[0].document).toBe('hello');
  });

  it('400 when no rerank models enabled', async () => {
    getDb().prepare("UPDATE models SET enabled=0 WHERE modality='rerank'").run();
    const r = await postRerank(app, { query: 'q', documents: ['a'] }, key);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/rerank/i);
    getDb().prepare("UPDATE models SET enabled=1 WHERE modality='rerank'").run();
  });
});
