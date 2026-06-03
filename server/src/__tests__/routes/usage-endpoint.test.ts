import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { setEndUserLimits } from '../../lib/endUserLimits.js';

async function req(
  app: Express,
  method: string,
  path: string,
  body?: any,
  token?: string,
) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}

describe('/v1/usage + /v1/usage/limits', () => {
  let app: Express;
  let token: string;
  let clientKeyId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = getUnifiedApiKey();
    clientKeyId = 1; // Default key
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM end_user_limits').run();
  });

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------
  it('GET /v1/usage → 401 without token', async () => {
    const r = await req(app, 'GET', '/v1/usage?user=alice');
    expect(r.status).toBe(401);
  });

  it('GET /v1/usage/limits → 401 without token', async () => {
    const r = await req(app, 'GET', '/v1/usage/limits?user=alice');
    expect(r.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // Missing user
  // ---------------------------------------------------------------------------
  it('GET /v1/usage → 400 when user missing', async () => {
    const r = await req(app, 'GET', '/v1/usage', undefined, token);
    expect(r.status).toBe(400);
  });

  it('POST /v1/usage → 400 when user missing', async () => {
    const r = await req(app, 'POST', '/v1/usage', {}, token);
    expect(r.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Zero spend happy path
  // ---------------------------------------------------------------------------
  it('GET /v1/usage returns zero spend for new user', async () => {
    const r = await req(app, 'GET', '/v1/usage?user=bob', undefined, token);
    expect(r.status).toBe(200);
    expect(r.body.user).toBe('bob');
    expect(r.body.currency).toBe('USD');
    expect(r.body.daily_usd).toBe(0);
    expect(r.body.total_usd).toBe(0);
  });

  it('POST /v1/usage returns zero spend for new user', async () => {
    const r = await req(app, 'POST', '/v1/usage', { user: 'carol' }, token);
    expect(r.status).toBe(200);
    expect(r.body.user).toBe('carol');
    expect(r.body.total_usd).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Actual spend
  // ---------------------------------------------------------------------------
  it('reflects actual cost_micro in spend', async () => {
    const db = getDb();
    // 1000 micro = 0.001000 USD
    db.prepare(`
      INSERT INTO requests
        (platform, model_id, status, input_tokens, output_tokens, latency_ms,
         error, client_key_id, end_user_id, cost_micro, created_at)
      VALUES ('groq','llama-3.3-70b-versatile','success',0,0,0,NULL,1,'dave',1000,datetime('now'))
    `).run();
    const r = await req(app, 'GET', '/v1/usage?user=dave', undefined, token);
    expect(r.status).toBe(200);
    expect(r.body.daily_usd).toBe(0.001);
    expect(r.body.total_usd).toBe(0.001);
  });

  // ---------------------------------------------------------------------------
  // period filter
  // ---------------------------------------------------------------------------
  it('period=day returns only daily_usd', async () => {
    const r = await req(app, 'GET', '/v1/usage?user=eve&period=day', undefined, token);
    expect(r.status).toBe(200);
    expect(r.body.daily_usd).toBeDefined();
    expect(r.body.weekly_usd).toBeUndefined();
    expect(r.body.monthly_usd).toBeUndefined();
  });

  it('invalid period returns 400', async () => {
    const r = await req(app, 'GET', '/v1/usage?user=eve&period=year', undefined, token);
    expect(r.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // /v1/usage/limits
  // ---------------------------------------------------------------------------
  it('GET /v1/usage/limits → nulls when no limit set', async () => {
    const r = await req(app, 'GET', '/v1/usage/limits?user=frank', undefined, token);
    expect(r.status).toBe(200);
    expect(r.body.daily_usd).toBeNull();
    expect(r.body.weekly_usd).toBeNull();
    expect(r.body.monthly_usd).toBeNull();
  });

  it('PUT /v1/usage/limits sets limits and returns them', async () => {
    const r = await req(app, 'PUT', '/v1/usage/limits',
      { user: 'grace', daily_usd: 1.0, monthly_usd: 10.0 },
      token,
    );
    expect(r.status).toBe(200);
    expect(r.body.user).toBe('grace');
    expect(r.body.daily_usd).toBeCloseTo(1.0, 4);
    expect(r.body.monthly_usd).toBeCloseTo(10.0, 4);
    expect(r.body.weekly_usd).toBeNull();
  });

  it('GET /v1/usage/limits reflects saved limits', async () => {
    setEndUserLimits(clientKeyId, 'henry', { daily_micro: 2_000_000, weekly_micro: null, monthly_micro: null });
    const r = await req(app, 'GET', '/v1/usage/limits?user=henry', undefined, token);
    expect(r.status).toBe(200);
    expect(r.body.daily_usd).toBeCloseTo(2.0, 4);
  });

  it('PUT /v1/usage/limits null clears a limit', async () => {
    setEndUserLimits(clientKeyId, 'ivan', { daily_micro: 5_000_000, weekly_micro: null, monthly_micro: null });
    await req(app, 'PUT', '/v1/usage/limits', { user: 'ivan', daily_usd: null, monthly_usd: null }, token);
    const r = await req(app, 'GET', '/v1/usage/limits?user=ivan', undefined, token);
    expect(r.body.daily_usd).toBeNull();
  });

  it('PUT /v1/usage/limits → 400 when user missing', async () => {
    const r = await req(app, 'PUT', '/v1/usage/limits', { daily_usd: 1 }, token);
    expect(r.status).toBe(400);
  });
});
