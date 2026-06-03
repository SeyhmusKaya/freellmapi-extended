import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

async function request(app: Express, body?: any, key?: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}/v1/images/generations`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  server.close();
  let data: any = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, body: data, headers: res.headers };
}

describe('POST /v1/images/generations → Pollinations', () => {
  let app: Express;
  let key: string;
  const JPG = Buffer.from('pollinations-jpg-bytes');

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    // No Cloudflare key. No Pollinations key (it's keyless).
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM cooldowns').run();
    db.prepare('DELETE FROM usage_counters').run();
    // Disable CF image-gen so Pollinations is the only candidate
    db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'cloudflare' AND modality = 'image_gen'").run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const db = getDb();
    db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'cloudflare' AND modality = 'image_gen'").run();
  });

  it('routes to Pollinations when CF unavailable', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      // Pollinations upstream
      return new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });

    const r = await request(app, { prompt: 'a cat' }, key);
    expect(r.status).toBe(200);
    expect(r.body._routed_via.platform).toBe('pollinations');
    expect(r.body.data[0].b64_json).toBe(JPG.toString('base64'));
  });

  it('pinned pollinations model id resolves and routes', async () => {
    const realFetch = globalThis.fetch;
    let lastUpstreamUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      lastUpstreamUrl = u;
      return new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });

    // pollinations/flux is the single kept Pollinations row after the V41
    // catalog cleanup (the variant rows were disabled — see migration V41).
    const r = await request(app, { prompt: 'a kawaii cat', model: 'pollinations/flux' }, key);
    expect(r.status).toBe(200);
    expect(r.body._routed_via.model).toBe('pollinations/flux');
    expect(lastUpstreamUrl).toContain('model=flux');
  });

  it('bare model id "flux" resolves to pollinations/flux', async () => {
    const realFetch = globalThis.fetch;
    let lastUpstreamUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      lastUpstreamUrl = u;
      return new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });

    const r = await request(app, { prompt: 'x', model: 'flux' }, key);
    expect(r.status).toBe(200);
    expect(r.body._routed_via.model).toBe('pollinations/flux');
    expect(lastUpstreamUrl).toContain('model=flux');
  });
});
