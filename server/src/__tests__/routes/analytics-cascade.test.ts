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

function row(reqId: string | null, status: string, latency = 100) {
  getDb().prepare(`INSERT INTO requests
    (platform, model_id, status, input_tokens, output_tokens, latency_ms, modality, client_key_id, request_id, cost_micro)
    VALUES ('groq','m', ?, 100, 50, ?, 'text', 1, ?, 10)`).run(status, latency, reqId);
}

describe('analytics: real failures vs cascade retries (request-level)', () => {
  let app: Express;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });
  beforeEach(() => {
    getDb().prepare('DELETE FROM requests').run();
  });

  it('a recovered cascade counts as 1 success + N cascade retries, 0 errors', async () => {
    // one logical request: 2 failed attempts then success
    row('reqA', 'error');
    row('reqA', 'error');
    row('reqA', 'success');

    const byKey = await get(app, '/api/analytics/by-key?range=7d');
    const def = byKey.body.find((k: any) => k.clientKeyId === 1);
    expect(def.totalRequests).toBe(1);
    expect(def.successCount).toBe(1);
    expect(def.errorCount).toBe(0);     // user got an answer → NOT an error
    expect(def.cascadeCount).toBe(2);   // 2 recovered retries

    const sum = await get(app, '/api/analytics/summary?range=7d');
    expect(sum.body.totalRequests).toBe(1);
    expect(sum.body.successRate).toBe(100);
    expect(sum.body.cascadeRetries).toBe(2);
  });

  it('an all-failed request counts as 1 error, 0 cascade', async () => {
    row('reqB', 'error');
    row('reqB', 'error');

    const byKey = await get(app, '/api/analytics/by-key?range=7d');
    const def = byKey.body.find((k: any) => k.clientKeyId === 1);
    expect(def.totalRequests).toBe(1);
    expect(def.successCount).toBe(0);
    expect(def.errorCount).toBe(1);     // real user-facing failure
    expect(def.cascadeCount).toBe(0);   // failed attempts are NOT cascade

    const sum = await get(app, '/api/analytics/summary?range=7d');
    expect(sum.body.successRate).toBe(0);
  });

  it('legacy rows with NULL request_id are each their own request', async () => {
    row(null, 'success');
    row(null, 'error');

    const sum = await get(app, '/api/analytics/summary?range=7d');
    expect(sum.body.totalRequests).toBe(2);
    expect(sum.body.successRate).toBe(50);
    expect(sum.body.cascadeRetries).toBe(0);
  });

  it('mixed: 1 clean success + 1 recovered + 1 failed → 2/3 success, 1 cascade', async () => {
    row('r1', 'success');             // clean
    row('r2', 'error'); row('r2', 'success'); // recovered
    row('r3', 'error');               // failed

    const sum = await get(app, '/api/analytics/summary?range=7d');
    expect(sum.body.totalRequests).toBe(3);
    expect(sum.body.successRate).toBeCloseTo(66.7, 1);
    expect(sum.body.cascadeRetries).toBe(1);
  });
});
