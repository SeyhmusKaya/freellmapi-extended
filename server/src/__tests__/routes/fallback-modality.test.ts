import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

function insertKey(platform: string) {
  const enc = encrypt('fake');
  getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)`).run(platform, enc.encrypted, enc.iv, enc.authTag);
}

async function get(app: Express, path: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`);
  const data = await res.json();
  server.close();
  return { status: res.status, body: data };
}

describe('GET /api/fallback/token-usage modality split', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    insertKey('cloudflare');
    insertKey('groq');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
  });

  it('returns text + images blocks separately', async () => {
    const r = await get(app, '/api/fallback/token-usage');
    expect(r.status).toBe(200);
    expect(r.body.text).toBeDefined();
    expect(r.body.images).toBeDefined();
    expect(Array.isArray(r.body.text.models)).toBe(true);
    expect(Array.isArray(r.body.images.models)).toBe(true);
  });

  it('text block contains only modality=text rows', async () => {
    const r = await get(app, '/api/fallback/token-usage');
    for (const m of r.body.text.models) {
      expect(m.modality).toBe('text');
    }
  });

  it('images block contains only modality=image_gen rows', async () => {
    const r = await get(app, '/api/fallback/token-usage');
    for (const m of r.body.images.models) {
      expect(m.modality).toBe('image_gen');
    }
  });

  it('images budgets measured in IMAGES not tokens (CF flux-1-schnell ~125/day with 1 key)', async () => {
    const r = await get(app, '/api/fallback/token-usage');
    const flux = r.body.images.models.find((m: any) => m.modelId === '@cf/black-forest-labs/flux-1-schnell');
    expect(flux).toBeDefined();
    // 10K neurons / 80 neurons-per-call × 1 key = 125 images/day
    expect(flux.dailyBudget).toBe(125);
    expect(flux.neuronsPerCall).toBe(80);
  });

  it('image usage counter = success request count, not token sum', async () => {
    const db = getDb();
    // Simulate 3 successful image-gen calls for flux-1-schnell
    for (let i = 0; i < 3; i++) {
      db.prepare(`INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, modality)
        VALUES ('cloudflare', '@cf/black-forest-labs/flux-1-schnell', 'success', 10, 80, 200, 'image_gen')`).run();
    }
    const r = await get(app, '/api/fallback/token-usage');
    const flux = r.body.images.models.find((m: any) => m.modelId === '@cf/black-forest-labs/flux-1-schnell');
    expect(flux.dailyUsed).toBe(3);
    expect(flux.monthlyUsed).toBe(3);
  });

  it('legacy top-level fields still text-only (back-compat)', async () => {
    const r = await get(app, '/api/fallback/token-usage');
    // top-level models[] is text-only — pre-modality clients keep working
    for (const m of r.body.models) {
      expect(m.modality).toBe('text');
    }
  });

  it('Pollinations rows still listed even without api_keys entry (keyless)', async () => {
    const r = await get(app, '/api/fallback/token-usage');
    const polly = r.body.images.models.filter((m: any) => m.platform === 'pollinations');
    expect(polly.length).toBeGreaterThan(0);
  });
});
