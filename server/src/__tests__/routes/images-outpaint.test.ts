import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import sharp from 'sharp';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { imageOutpaintSchema } from '../../lib/runImageOutpaint.js';

const OUT_PNG = Buffer.from('outpaint-result-bytes');

async function request(app: Express, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/images/outpaint`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: data, headers: res.headers };
}

describe('POST /v1/images/outpaint', () => {
  let app: Express;
  let key: string;
  let srcDataUrl: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    const { encrypt } = await import('../../lib/crypto.js');
    const enc = encrypt('acct:tok');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('cloudflare','outpaint-test',?,?,?,'healthy',1)`).run(enc.encrypted, enc.iv, enc.authTag);

    // Build a real 512x512 PNG so sharp can decode metadata
    const srcBuf = await sharp({
      create: { width: 512, height: 512, channels: 3, background: { r: 200, g: 100, b: 50 } },
    }).png().toBuffer();
    srcDataUrl = `data:image/png;base64,${srcBuf.toString('base64')}`;
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM cooldowns').run();
    db.prepare('DELETE FROM usage_counters').run();
  });

  afterEach(() => vi.restoreAllMocks());

  it('schema rejects missing prompt or image', () => {
    expect(imageOutpaintSchema.safeParse({ prompt: 'x' }).success).toBe(false);
    expect(imageOutpaintSchema.safeParse({ image: srcDataUrl }).success).toBe(false);
  });

  it('schema rejects pixels out of range', () => {
    expect(imageOutpaintSchema.safeParse({ prompt: 'x', image: srcDataUrl, pixels: 8 }).success).toBe(false);
    expect(imageOutpaintSchema.safeParse({ prompt: 'x', image: srcDataUrl, pixels: 600 }).success).toBe(false);
  });

  it('routes through CF inpainting model with composited canvas + mask', async () => {
    const realFetch = globalThis.fetch;
    let upstream: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      upstream = JSON.parse(init.body as string);
      return new Response(OUT_PNG, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    });

    const r = await request(app, {
      prompt: 'extend the scene to the right',
      image: srcDataUrl,
      direction: 'right',
      pixels: 128,
    }, key);

    expect(r.status).toBe(200);
    expect(r.body.data[0].b64_json).toBe(OUT_PNG.toString('base64'));
    // Pipeline must route to inpainting model
    expect(r.body._routed_via.model).toBe('@cf/runwayml/stable-diffusion-v1-5-inpainting');
    expect(Array.isArray(upstream.image)).toBe(true);
    expect(Array.isArray(upstream.mask)).toBe(true);
  });

  it('all-direction outpaint produces both new canvas + mask', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      return new Response(OUT_PNG, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    });

    const r = await request(app, {
      prompt: 'widen the scene',
      image: srcDataUrl,
      direction: 'all',
      pixels: 64,
    }, key);
    expect(r.status).toBe(200);
    expect(r.body._routed_via.model).toBe('@cf/runwayml/stable-diffusion-v1-5-inpainting');
  });
});
