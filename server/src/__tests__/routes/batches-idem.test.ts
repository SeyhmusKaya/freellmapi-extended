import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any, extra?: Record<string, string>) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${getUnifiedApiKey()}`, ...(extra ?? {}) };
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  server.close();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: data };
}

describe('Idempotency-Key', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  const bodyA = {
    items: [{ custom_id: 'r1', body: { messages: [{ role: 'user', content: 'a' }], max_tokens: 5 } }],
    metadata: { source: 'idem-test' },
  };

  it('same key + same body returns same batch id', async () => {
    const first = await request(app, 'POST', '/v1/batches', bodyA, { 'Idempotency-Key': 'k-1' });
    expect(first.status).toBe(201);
    const second = await request(app, 'POST', '/v1/batches', bodyA, { 'Idempotency-Key': 'k-1' });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it('same key + different body returns 409', async () => {
    await request(app, 'POST', '/v1/batches', bodyA, { 'Idempotency-Key': 'k-2' });
    const different = await request(app, 'POST', '/v1/batches', {
      ...bodyA,
      items: [{ custom_id: 'different', body: bodyA.items[0].body }],
    }, { 'Idempotency-Key': 'k-2' });
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe('idempotency_key_conflict');
  });

  it('no idempotency-key creates distinct batches', async () => {
    const a = await request(app, 'POST', '/v1/batches', bodyA);
    const b = await request(app, 'POST', '/v1/batches', bodyA);
    expect(a.body.id).not.toBe(b.body.id);
  });

  it('serialized batch strips __idem_hash from metadata', async () => {
    const r = await request(app, 'POST', '/v1/batches', bodyA, { 'Idempotency-Key': 'k-3' });
    expect(r.body.metadata).toEqual({ source: 'idem-test' });
    expect(r.body.metadata.__idem_hash).toBeUndefined();
  });
});
