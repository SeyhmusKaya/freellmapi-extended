import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Fallback API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('GET /api/fallback returns fallback chain', async () => {
    const { status, body } = await request(app, 'GET', '/api/fallback');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    // Should be sorted by priority
    for (let i = 1; i < body.length; i++) {
      expect(body[i].priority).toBeGreaterThanOrEqual(body[i - 1].priority);
    }
  });

  it('GET /api/fallback entries have expected fields', async () => {
    const { body } = await request(app, 'GET', '/api/fallback');
    const first = body[0];
    expect(first).toHaveProperty('modelDbId');
    expect(first).toHaveProperty('priority');
    expect(first).toHaveProperty('enabled');
    expect(first).toHaveProperty('platform');
    expect(first).toHaveProperty('displayName');
    expect(first).toHaveProperty('intelligenceRank');
  });

  it('PUT /api/fallback updates order', async () => {
    const { body: original } = await request(app, 'GET', '/api/fallback');

    // Reverse the order
    const reversed = original.map((e: any, i: number) => ({
      modelDbId: e.modelDbId,
      priority: original.length - i,
      enabled: e.enabled,
    }));

    const { status } = await request(app, 'PUT', '/api/fallback', reversed);
    expect(status).toBe(200);

    // Verify order changed
    const { body: after } = await request(app, 'GET', '/api/fallback');
    expect(after[0].modelDbId).toBe(original[original.length - 1].modelDbId);

    // Restore original order
    const restore = original.map((e: any, i: number) => ({
      modelDbId: e.modelDbId,
      priority: i + 1,
      enabled: e.enabled,
    }));
    await request(app, 'PUT', '/api/fallback', restore);
  });

  it('POST /api/fallback/sort/intelligence sorts by intelligence', async () => {
    const { status } = await request(app, 'POST', '/api/fallback/sort/intelligence');
    expect(status).toBe(200);

    const { body } = await request(app, 'GET', '/api/fallback');
    // Should be sorted ascending by intelligence rank
    for (let i = 1; i < body.length; i++) {
      expect(body[i].intelligenceRank).toBeGreaterThanOrEqual(body[i - 1].intelligenceRank);
    }
  });

  it('POST /api/fallback/sort/speed sorts by speed', async () => {
    const { status } = await request(app, 'POST', '/api/fallback/sort/speed');
    expect(status).toBe(200);

    const { body } = await request(app, 'GET', '/api/fallback');
    // Should be sorted ascending by speed rank
    for (let i = 1; i < body.length; i++) {
      expect(body[i].speedRank).toBeGreaterThanOrEqual(body[i - 1].speedRank);
    }
  });

  it('POST /api/fallback/sort/invalid returns 400', async () => {
    const { status } = await request(app, 'POST', '/api/fallback/sort/invalid');
    expect(status).toBe(400);
  });

  it('GET /api/fallback/token-usage returns per-model used + excludes disabled', async () => {
    // Seed an api key so token-usage has something to render
    const { initDb, getDb } = await import('../../db/index.js');
    void initDb; // already initialized in beforeAll
    const db = getDb();
    const { encrypt } = await import('../../lib/crypto.js');
    const enc = encrypt('fake');
    db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','test',?,?,?,'healthy',1)`).run(enc.encrypted, enc.iv, enc.authTag);

    // Insert a success record to populate per-model used
    db.prepare(`INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms) VALUES ('groq','llama-3.3-70b-versatile','success',1000,500,200)`).run();

    const { status, body } = await request(app, 'GET', '/api/fallback/token-usage');
    expect(status).toBe(200);
    expect(body.totalBudget).toBeGreaterThan(0);
    expect(Array.isArray(body.models)).toBe(true);

    const llama = body.models.find((m: any) => m.modelId === 'llama-3.3-70b-versatile');
    expect(llama).toBeDefined();
    expect(llama.monthlyUsed).toBe(1500);
    expect(llama.dailyUsed).toBe(1500);
    expect(llama.budget).toBeGreaterThan(0);
    expect(llama.dailyBudget).toBeGreaterThan(0);
  });

  it('GET /api/fallback/token-usage excludes disabled models', async () => {
    const { getDb } = await import('../../db/index.js');
    const db = getDb();
    // Disable Llama 3.3 70B (Groq) for this assertion
    db.prepare(`UPDATE models SET enabled=0 WHERE platform='groq' AND model_id='llama-3.3-70b-versatile'`).run();

    const { body } = await request(app, 'GET', '/api/fallback/token-usage');
    const llama = body.models.find((m: any) => m.modelId === 'llama-3.3-70b-versatile');
    expect(llama).toBeUndefined();

    // Restore
    db.prepare(`UPDATE models SET enabled=1 WHERE platform='groq' AND model_id='llama-3.3-70b-versatile'`).run();
  });
});
