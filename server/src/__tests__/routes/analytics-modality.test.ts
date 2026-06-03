import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

async function get(app: Express, path: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`);
  const data = await res.json();
  server.close();
  return { status: res.status, body: data };
}

describe('analytics modality awareness', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM requests').run();
  });

  function seedReq(platform: string, modelId: string, modality: string, status = 'success', tokens = { in: 100, out: 50 }) {
    getDb().prepare(`INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, modality)
      VALUES (?, ?, ?, ?, ?, 200, ?)`).run(platform, modelId, status, tokens.in, tokens.out, modality);
  }

  it('summary: imagesGenerated counter separate from token totals', async () => {
    seedReq('groq', 'llama-3.3-70b-versatile', 'text', 'success', { in: 500, out: 200 });
    seedReq('cloudflare', '@cf/black-forest-labs/flux-1-schnell', 'image_gen', 'success', { in: 10, out: 80 });
    seedReq('cloudflare', '@cf/black-forest-labs/flux-1-schnell', 'image_gen', 'success', { in: 10, out: 80 });

    const r = await get(app, '/api/analytics/summary?range=7d');
    expect(r.body.totalRequests).toBe(3);
    expect(r.body.imagesGenerated).toBe(2);
    expect(r.body.imageRequests).toBe(2);
    // Text-only token counters
    expect(r.body.totalInputTokens).toBe(500);
    expect(r.body.totalOutputTokens).toBe(200);
  });

  it('summary cost savings: text uses Gemini 3.1 Flash-Lite pricing, image uses $0.04/img', async () => {
    // 1M input + 1M output (text) + 10 images
    getDb().prepare(`INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, modality)
      VALUES ('groq','llama-3.3-70b-versatile','success', 1000000, 1000000, 200, 'text')`).run();
    for (let i = 0; i < 10; i++) {
      seedReq('cloudflare', '@cf/black-forest-labs/flux-1-schnell', 'image_gen', 'success', { in: 5, out: 80 });
    }
    const r = await get(app, '/api/analytics/summary?range=7d');
    // Text: $0.25 + $1.50 = $1.75. Images: 10 × $0.04 = $0.40. Total $2.15.
    expect(r.body.estimatedCostSavings).toBeCloseTo(2.15, 2);
  });

  it('by-model: each row carries modality field', async () => {
    seedReq('groq', 'llama-3.3-70b-versatile', 'text');
    seedReq('cloudflare', '@cf/black-forest-labs/flux-1-schnell', 'image_gen');
    const r = await get(app, '/api/analytics/by-model?range=7d');
    const text = r.body.find((m: any) => m.platform === 'groq');
    const img = r.body.find((m: any) => m.platform === 'cloudflare');
    expect(text.modality).toBe('text');
    expect(img.modality).toBe('image_gen');
  });

  it('by-platform: surfaces imageRequests and imagesGenerated', async () => {
    seedReq('cloudflare', '@cf/black-forest-labs/flux-1-schnell', 'image_gen', 'success');
    seedReq('cloudflare', '@cf/black-forest-labs/flux-1-schnell', 'image_gen', 'error');
    seedReq('groq', 'llama-3.3-70b-versatile', 'text', 'success');
    const r = await get(app, '/api/analytics/by-platform?range=7d');
    const cf = r.body.find((p: any) => p.platform === 'cloudflare');
    const groq = r.body.find((p: any) => p.platform === 'groq');
    expect(cf.imageRequests).toBe(2);
    expect(cf.imagesGenerated).toBe(1);
    expect(groq.imageRequests).toBe(0);
    expect(groq.imagesGenerated).toBe(0);
  });
});
