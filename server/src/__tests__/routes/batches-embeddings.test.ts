import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

async function jsonReq(app: Express, method: string, path: string, body?: any, key?: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (key)  headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  server.close();
  let data: any = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  return { status: res.status, body: data };
}

const VEC = Array.from({ length: 1024 }, (_, i) => i / 1024);

describe('Batches API — embedding items (Faz 2 V31)', () => {
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
      VALUES ('cloudflare','batch-embed-test',?,?,?,'healthy',1)`).run(enc.encrypted, enc.iv, enc.authTag);
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM batch_items").run();
    db.prepare("DELETE FROM batches").run();
  });

  afterEach(() => vi.restoreAllMocks());

  it('accepts embedding items via url=/v1/embeddings', async () => {
    const payload = {
      items: [
        { url: '/v1/embeddings', custom_id: 'e1', body: { input: 'hello' } },
        { url: '/v1/embeddings', custom_id: 'e2', body: { input: ['a', 'b'] } },
      ],
    };
    const { status, body } = await jsonReq(app, 'POST', '/v1/batches', payload, key);
    expect(status).toBe(201);
    expect(body.request_counts.total).toBe(2);

    // verify batch_items row endpoint column matches
    const rows = getDb().prepare(`SELECT custom_id, endpoint FROM batch_items WHERE batch_id=? ORDER BY position`).all(body.id) as Array<{ custom_id: string; endpoint: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ custom_id: 'e1', endpoint: '/v1/embeddings' });
    expect(rows[1]).toMatchObject({ custom_id: 'e2', endpoint: '/v1/embeddings' });
  });

  it('defaults to /v1/chat/completions when url omitted (back-compat)', async () => {
    const payload = {
      items: [
        { custom_id: 'c1', body: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 } },
      ],
    };
    const { status, body } = await jsonReq(app, 'POST', '/v1/batches', payload, key);
    expect(status).toBe(201);
    const rows = getDb().prepare(`SELECT endpoint FROM batch_items WHERE batch_id=?`).all(body.id) as Array<{ endpoint: string }>;
    expect(rows[0].endpoint).toBe('/v1/chat/completions');
  });

  it('rejects embedding item with malformed body', async () => {
    const payload = {
      items: [
        { url: '/v1/embeddings', custom_id: 'bad', body: { input: '' } },  // empty string forbidden
      ],
    };
    const { status, body } = await jsonReq(app, 'POST', '/v1/batches', payload, key);
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/input|invalid/i);
  });

  it('mixed chat + embedding items in same batch', async () => {
    const payload = {
      items: [
        { custom_id: 'chat1', body: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 } },
        { url: '/v1/embeddings', custom_id: 'emb1', body: { input: 'hello' } },
      ],
    };
    const { status, body } = await jsonReq(app, 'POST', '/v1/batches', payload, key);
    expect(status).toBe(201);
    expect(body.request_counts.total).toBe(2);
    const rows = getDb().prepare(`SELECT endpoint FROM batch_items WHERE batch_id=? ORDER BY position`).all(body.id) as Array<{ endpoint: string }>;
    expect(rows[0].endpoint).toBe('/v1/chat/completions');
    expect(rows[1].endpoint).toBe('/v1/embeddings');
  });
});
