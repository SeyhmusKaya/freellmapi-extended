import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';

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
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, body: data, raw: text };
}

describe('Batches API', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  const sampleBody = {
    items: [
      { custom_id: 'r1', body: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 } },
      { custom_id: 'r2', body: { messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 } },
    ],
    metadata: { tag: 'test' },
  };

  it('POST /v1/batches without key returns 401', async () => {
    const { status } = await request(app, 'POST', '/v1/batches', sampleBody);
    expect(status).toBe(401);
  });

  it('POST /v1/batches creates batch and returns ULID id', async () => {
    const { status, body } = await request(app, 'POST', '/v1/batches', sampleBody, key);
    expect(status).toBe(201);
    expect(body.id).toMatch(/^batch_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.object).toBe('batch');
    expect(body.status).toBe('queued');
    expect(body.request_counts).toEqual({ total: 2, completed: 0, failed: 0 });
    expect(body.metadata).toEqual({ tag: 'test' });
  });

  it('POST /v1/batches rejects duplicate custom_id', async () => {
    const dup = {
      items: [
        { custom_id: 'x', body: { messages: [{ role: 'user', content: 'a' }] } },
        { custom_id: 'x', body: { messages: [{ role: 'user', content: 'b' }] } },
      ],
    };
    const { status, body } = await request(app, 'POST', '/v1/batches', dup, key);
    expect(status).toBe(400);
    expect(body.error.code).toBe('duplicate_custom_id');
  });

  it('POST /v1/batches rejects empty items', async () => {
    const { status } = await request(app, 'POST', '/v1/batches', { items: [] }, key);
    expect(status).toBe(400);
  });

  it('GET /v1/batches lists created batches', async () => {
    const { status, body } = await request(app, 'GET', '/v1/batches', undefined, key);
    expect(status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('GET /v1/batches/:id returns single batch', async () => {
    const created = await request(app, 'POST', '/v1/batches', sampleBody, key);
    const { status, body } = await request(app, 'GET', `/v1/batches/${created.body.id}`, undefined, key);
    expect(status).toBe(200);
    expect(body.id).toBe(created.body.id);
    expect(body.request_counts.total).toBe(2);
  });

  it('GET /v1/batches/:id returns 404 for missing', async () => {
    const { status } = await request(app, 'GET', '/v1/batches/batch_DOES_NOT_EXIST', undefined, key);
    expect(status).toBe(404);
  });

  it('DELETE /v1/batches/:id cancels pending items', async () => {
    const created = await request(app, 'POST', '/v1/batches', sampleBody, key);
    const { status, body } = await request(app, 'DELETE', `/v1/batches/${created.body.id}`, undefined, key);
    expect(status).toBe(200);
    expect(body.status).toBe('cancelled');
    expect(body.cancelled_pending).toBe(2);

    const second = await request(app, 'DELETE', `/v1/batches/${created.body.id}`, undefined, key);
    expect(second.status).toBe(409);
  });

  it('GET /v1/batches/:id/results returns NDJSON for cancelled items', async () => {
    const created = await request(app, 'POST', '/v1/batches', sampleBody, key);
    await request(app, 'DELETE', `/v1/batches/${created.body.id}`, undefined, key);
    const server = app.listen(0);
    const addr = server.address() as any;
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/batches/${created.body.id}/results`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const text = await res.text();
    server.close();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('ndjson');
    const lines = text.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.status).toBe('cancelled');
    expect(first.custom_id).toBe('r1');
  });
});
