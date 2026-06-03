import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any, key?: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (key !== undefined) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  server.close();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: data, headers: res.headers };
}

describe('POST /v1/images/generations', () => {
  let app: Express;
  let key: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    // Seed a Cloudflare key so image-gen has a route
    await request(app, 'POST', '/api/keys', { platform: 'cloudflare', key: 'acct:token', label: 'imagegen-e2e' });
    // V28: disable flux-2-klein-9b for these tests - they assert against the
    // legacy JSON-body SD image-gen path; flux-2 uses multipart instead.
    // Coverage for flux-2 lives in providers/cloudflare-imagegen.test.ts.
    getDb().prepare("UPDATE models SET enabled=0 WHERE model_id='@cf/black-forest-labs/flux-2-klein-9b'").run();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM cooldowns').run();
    db.prepare('DELETE FROM usage_counters').run();
  });

  afterEach(() => vi.restoreAllMocks());

  it('401 without bearer key', async () => {
    const r = await request(app, 'POST', '/v1/images/generations', { prompt: 'a cat' });
    expect(r.status).toBe(401);
  });

  it('400 on empty prompt', async () => {
    const r = await request(app, 'POST', '/v1/images/generations', { prompt: '' }, key);
    expect(r.status).toBe(400);
  });

  it('response_format=url returns a signed URL (Faz 3)', async () => {
    const PNG = Buffer.from('phase3-png-bytes');
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      return new Response(PNG, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    });
    const r = await request(app, 'POST', '/v1/images/generations',
      { prompt: 'a cat', response_format: 'url' }, key);
    expect(r.status).toBe(200);
    expect(r.body.data[0].url).toMatch(/\/v1\/images\/files\//);
    expect(r.body.data[0].b64_json).toBeUndefined();
  });

  it('200 with b64_json on success — routes to CF image-gen model', async () => {
    const PNG = Buffer.from('fake-png-bytes');
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      // CF AI endpoint
      return new Response(PNG, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    });

    const r = await request(app, 'POST', '/v1/images/generations', { prompt: 'a kawaii cat' }, key);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].b64_json).toBe(PNG.toString('base64'));
    expect(r.body._routed_via.platform).toBe('cloudflare');
    expect(r.body._routed_via.model.startsWith('@cf/')).toBe(true);
    expect(r.headers.get('x-routed-via')).toContain('cloudflare');
  });

  it('cascades to next image-gen model on 429', async () => {
    const PNG = Buffer.from('cascade-png');
    let firstHit = true;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      if (firstHit) {
        firstHit = false;
        return new Response(JSON.stringify({ errors: [{ message: '429 rate limited per day' }] }), { status: 429, headers: { 'content-type': 'application/json' } });
      }
      return new Response(PNG, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    });

    const r = await request(app, 'POST', '/v1/images/generations', { prompt: 'a cat' }, key);
    expect(r.status).toBe(200);
    expect(r.body.data[0].b64_json).toBe(PNG.toString('base64'));
  });

  it('400 when no image-gen model enabled', async () => {
    const db = getDb();
    db.prepare("UPDATE models SET enabled = 0 WHERE modality = 'image_gen'").run();
    const r = await request(app, 'POST', '/v1/images/generations', { prompt: 'a cat' }, key);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/No image-generation/);
    db.prepare("UPDATE models SET enabled = 1 WHERE modality = 'image_gen'").run();
  });
});
