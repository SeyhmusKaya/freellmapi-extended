import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey, getDb } from '../../db/index.js';
import { batchId as makeBatchId } from '../../lib/ulid.js';

async function request(app: Express, method: string, path: string, body?: any, key?: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (key)  headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  server.close();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: data, raw: text };
}

describe('Admin /api/batches', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    // create a batch directly
    const id = makeBatchId();
    getDb().prepare(`INSERT INTO batches (id, status, total, priority) VALUES (?, 'queued', 2, 2)`).run(id);
    getDb().prepare(`INSERT INTO batch_items (batch_id, position, custom_id, request_body) VALUES (?, 0, 'a', '{}')`).run(id);
    getDb().prepare(`INSERT INTO batch_items (batch_id, position, custom_id, request_body) VALUES (?, 1, 'b', '{}')`).run(id);
  });

  it('GET /api/batches works without Bearer', async () => {
    const r = await request(app, 'GET', '/api/batches');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
    expect(r.body.data.length).toBeGreaterThan(0);
  });

  it('GET /v1/batches still requires Bearer (admin route does not leak to /v1)', async () => {
    const noKey = await request(app, 'GET', '/v1/batches');
    expect(noKey.status).toBe(401);
    const withKey = await request(app, 'GET', '/v1/batches', undefined, getUnifiedApiKey());
    expect(withKey.status).toBe(200);
  });

  it('DELETE /api/batches/:id cancels via admin route', async () => {
    const list = await request(app, 'GET', '/api/batches');
    const target = list.body.data[0].id;
    const del = await request(app, 'DELETE', `/api/batches/${target}`);
    expect(del.status).toBe(200);
    expect(del.body.status).toBe('cancelled');
  });
});
