import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

const OUT_PNG = Buffer.from('edited-output-bytes');

async function postMultipart(app: Express, path: string, key: string, fields: Record<string, string | Buffer>) {
  const boundary = '----TestBoundary' + Math.random().toString(36).slice(2);
  const parts: Buffer[] = [];
  for (const [name, val] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    if (Buffer.isBuffer(val)) {
      parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"; filename="${name}.png"\r\nContent-Type: image/png\r\n\r\n`));
      parts.push(val);
      parts.push(Buffer.from('\r\n'));
    } else {
      parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });
  const text = await res.text();
  server.close();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: data, headers: res.headers };
}

describe('POST /v1/images/edits multipart/form-data', () => {
  let app: Express;
  let key: string;
  const SRC = Buffer.from('source-png-bytes');

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    // Seed CF key
    const { encrypt } = await import('../../lib/crypto.js');
    const enc = encrypt('acct:tok');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('cloudflare','mp-test',?,?,?,'healthy',1)`).run(enc.encrypted, enc.iv, enc.authTag);
    // V28: disable flux-2-klein-9b so the Pollinations img2img path stays
    // the route under test. Default routing prefers flux-2 over Pollinations.
    getDb().prepare("UPDATE models SET enabled=0 WHERE model_id='@cf/black-forest-labs/flux-2-klein-9b'").run();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM cooldowns').run();
    db.prepare('DELETE FROM usage_counters').run();
  });

  afterEach(() => vi.restoreAllMocks());

  // V27: multipart img2img routes to Pollinations
  it('accepts multipart image + prompt + strength -> Pollinations img2img', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      if (u.includes('image.pollinations.ai')) {
        return new Response(OUT_PNG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response('{}', { status: 200 });
    });
    const r = await postMultipart(app, '/v1/images/edits', key, {
      prompt: 'add a hat',
      image: SRC,
      strength: '0.7',
    });
    expect(r.status).toBe(200);
    expect(r.body._routed_via.platform).toBe('pollinations');
  });

  it('mask multipart field forwards as inpainting (supports_inpainting model)', async () => {
    const realFetch = globalThis.fetch;
    let upstream: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      upstream = JSON.parse(init.body as string);
      return new Response(OUT_PNG, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    });

    const r = await postMultipart(app, '/v1/images/edits', key, {
      prompt: 'replace face',
      image: SRC,
      mask: Buffer.from('mask-bytes'),
    });
    expect(r.status).toBe(200);
    expect(Array.isArray(upstream.mask)).toBe(true);
    const row = getDb().prepare("SELECT supports_inpainting FROM models WHERE platform = ? AND model_id = ?")
      .get('cloudflare', r.body._routed_via.model) as { supports_inpainting: number };
    expect(row.supports_inpainting).toBe(1);
  });

  // V27: JSON path img2img routes to Pollinations (parity with multipart)
  it('JSON path img2img -> Pollinations 200 (parity with multipart)', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      if (u.includes('image.pollinations.ai')) {
        return new Response(OUT_PNG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response('{}', { status: 200 });
    });
    const server = app.listen(0);
    const addr = server.address() as any;
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/images/edits`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', image: 'data:image/png;base64,' + SRC.toString('base64') }),
    });
    server.close();
    expect(res.status).toBe(200);
  });
});
