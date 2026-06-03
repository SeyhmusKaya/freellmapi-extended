import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any, key?: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  server.close();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: data, raw: text, headers: res.headers, port: addr.port };
}

async function requestRaw(app: Express, urlPath: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${urlPath}`);
  const buf = Buffer.from(await res.arrayBuffer());
  server.close();
  return { status: res.status, buf, contentType: res.headers.get('content-type') };
}

describe('POST /v1/images/generations response_format=url + GET /v1/images/files/:id', () => {
  let app: Express;
  let key: string;
  const JPG = Buffer.from('pollinations-url-jpg');

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.MYLLM_PUBLIC_URL = 'https://myapi.example.com';
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    // Disable CF image-gen so Pollinations is selected (keyless)
    getDb().prepare("UPDATE models SET enabled = 0 WHERE platform = 'cloudflare' AND modality = 'image_gen'").run();
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns a signed url and fetching it returns the image bytes', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      return new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });

    const r = await request(app, 'POST', '/v1/images/generations',
      { prompt: 'a kawaii cat', response_format: 'url' }, key);
    expect(r.status).toBe(200);
    expect(r.body.data[0].url).toMatch(/^https:\/\/myapi\.example\.com\/v1\/images\/files\//);
    expect(r.body.data[0].b64_json).toBeUndefined();

    // Now fetch that URL but against the local test server (rewrite host)
    const u = new URL(r.body.data[0].url);
    const localPath = u.pathname + u.search;
    const fetched = await requestRaw(app, localPath);
    expect(fetched.status).toBe(200);
    expect(fetched.buf.equals(JPG)).toBe(true);
    expect(fetched.contentType).toContain('image/jpeg');
  });

  it('serves 401 for tampered signature', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      return new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
    const r = await request(app, 'POST', '/v1/images/generations',
      { prompt: 'x', response_format: 'url' }, key);
    const u = new URL(r.body.data[0].url);
    u.searchParams.set('sig', 'deadbeef'.repeat(8));
    const fetched = await requestRaw(app, u.pathname + u.search);
    expect(fetched.status).toBe(401);
  });

  it('serves 410 once exp passed', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      return new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
    const r = await request(app, 'POST', '/v1/images/generations',
      { prompt: 'x', response_format: 'url' }, key);
    const u = new URL(r.body.data[0].url);
    // Recompute a sig with past exp using internal helper would be needed; we
    // simply set exp to past — verifySignedRequest checks exp first, so 410
    // happens BEFORE sig comparison.
    u.searchParams.set('exp', String(Math.floor(Date.now() / 1000) - 10));
    const fetched = await requestRaw(app, u.pathname + u.search);
    expect(fetched.status).toBe(410);
  });

  it('default response_format still inline (b64_json)', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      return new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
    const r = await request(app, 'POST', '/v1/images/generations', { prompt: 'x' }, key);
    expect(r.status).toBe(200);
    expect(r.body.data[0].b64_json).toBe(JPG.toString('base64'));
    expect(r.body.data[0].url).toBeUndefined();
  });
});
