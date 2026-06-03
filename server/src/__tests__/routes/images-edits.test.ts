import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

const SRC_DATA_URL = 'data:image/png;base64,' + Buffer.from('src-bytes').toString('base64');
const MASK_DATA_URL = 'data:image/png;base64,' + Buffer.from('mask-bytes').toString('base64');
const OUT_PNG = Buffer.from('edited-output-bytes');

async function request(app: Express, path: string, body: any, key?: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  server.close();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: data, headers: res.headers };
}

describe('POST /v1/images/edits + /v1/images/variations', () => {
  let app: Express;
  let key: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    await request(app, '/api/keys', { platform: 'cloudflare', key: 'acct:tok', label: 'edits-e2e' }, key);
    // V28 added CF flux-2-klein-9b as a higher-priority img2img model. The
    // existing assertions here verify the Pollinations fallback path; pin the
    // test fixture to Pollinations by disabling flux-2.
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
    const r = await request(app, '/v1/images/edits', { prompt: 'x', image: SRC_DATA_URL });
    expect(r.status).toBe(401);
  });

  it('400 on missing image', async () => {
    const r = await request(app, '/v1/images/edits', { prompt: 'x' }, key);
    expect(r.status).toBe(400);
  });

  // V27 (May 2026): img2img (no mask) routes to Pollinations.ai flux.
  it('200 edits without mask -> Pollinations img2img', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      if (u.includes('image.pollinations.ai')) {
        return new Response(OUT_PNG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response('{}', { status: 200 });
    });
    const r = await request(app, '/v1/images/edits',
      { prompt: 'add a hat', image: SRC_DATA_URL, strength: 0.6 }, key);
    expect(r.status).toBe(200);
    expect(r.body._routed_via.platform).toBe('pollinations');
    expect(r.body.data[0].b64_json).toBe(OUT_PNG.toString('base64'));
  });

  it('200 edits with mask routes to supports_inpainting=1', async () => {
    const realFetch = globalThis.fetch;
    let upstreamBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      upstreamBody = JSON.parse(init.body as string);
      return new Response(OUT_PNG, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    });

    const r = await request(app, '/v1/images/edits',
      { prompt: 'replace face', image: SRC_DATA_URL, mask: MASK_DATA_URL }, key);
    expect(r.status).toBe(200);
    expect(Array.isArray(upstreamBody.mask)).toBe(true);
    const row = getDb().prepare(
      "SELECT supports_inpainting FROM models WHERE platform = ? AND model_id = ?"
    ).get('cloudflare', r.body._routed_via.model) as { supports_inpainting: number };
    expect(row.supports_inpainting).toBe(1);
  });

  // V27: variations route to Pollinations img2img (synthetic prompt)
  it('200 variations -> Pollinations img2img with synthetic prompt', async () => {
    const realFetch = globalThis.fetch;
    let captured: URL | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      if (u.includes('image.pollinations.ai')) {
        captured = new URL(u);
        return new Response(OUT_PNG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response('{}', { status: 200 });
    });
    const r = await request(app, '/v1/images/variations', { image: SRC_DATA_URL }, key);
    expect(r.status).toBe(200);
    expect(r.body._routed_via.platform).toBe('pollinations');
    // Pollinations got an `image=` param + a non-empty prompt path segment
    expect(captured!.searchParams.get('image')).toMatch(/^https?:\/\//);
    expect(captured!.pathname).toMatch(/\/prompt\/.+/);
  });

  it('response_format=url returns signed URL for edits (with mask)', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      return new Response(OUT_PNG, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    });

    const r = await request(app, '/v1/images/edits',
      { prompt: 'x', image: SRC_DATA_URL, mask: MASK_DATA_URL, response_format: 'url' }, key);
    expect(r.status).toBe(200);
    expect(r.body.data[0].url).toMatch(/\/v1\/images\/files\//);
    expect(r.body.data[0].b64_json).toBeUndefined();
  });

  it('400 when no inpainting model enabled', async () => {
    const db = getDb();
    db.prepare("UPDATE models SET enabled = 0 WHERE supports_inpainting = 1").run();
    const r = await request(app, '/v1/images/edits',
      { prompt: 'x', image: SRC_DATA_URL, mask: MASK_DATA_URL }, key);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/inpainting/i);
    db.prepare("UPDATE models SET enabled = 1 WHERE platform='cloudflare' AND model_id='@cf/runwayml/stable-diffusion-v1-5-inpainting'").run();
  });
});
