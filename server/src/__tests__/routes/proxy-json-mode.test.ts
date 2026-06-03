import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${getUnifiedApiKey()}` };
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  server.close();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: data, headers: res.headers };
}

describe('E2E json-mode proxy', () => {
  let app: Express;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    // Add a Cloudflare key so the candidate pool includes reasoning models
    // (Kimi K2.5/K2.6, DeepSeek-R1) the gate must skip.
    await request(app, 'POST', '/api/keys', { platform: 'cloudflare', key: 'acct:tok', label: 'cf' });
    await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'gsk_x', label: 'gq' });
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM cooldowns').run();
    db.prepare('DELETE FROM usage_counters').run();
  });

  afterEach(() => vi.restoreAllMocks());

  it('json_object request routes to a json-capable non-reasoning model', async () => {
    let upstream: any = null;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      upstream = { url: u, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: upstream.body.model ?? 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const r = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'return JSON with field ok=true' }],
      response_format: { type: 'json_object' },
    });
    expect(r.status).toBe(200);
    expect(upstream).not.toBeNull();
    // Verify the chosen route is json-capable and not a reasoning model
    const row = getDb().prepare(`SELECT supports_json_mode, is_reasoning FROM models WHERE model_id = ?`).get(upstream.body.model) as { supports_json_mode: number; is_reasoning: number };
    expect(row.supports_json_mode).toBe(1);
    expect(row.is_reasoning).toBe(0);
    // upstream body should also carry response_format passthrough
    expect(upstream.body.response_format).toEqual({ type: 'json_object' });
  });

  it('drops pin when client requests Kimi K2.5 in json mode', async () => {
    let upstreamModel: string | null = null;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      const b = JSON.parse(init.body as string);
      upstreamModel = b.model;
      return new Response(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: b.model,
        choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const r = await request(app, 'POST', '/v1/chat/completions', {
      model: '@cf/moonshotai/kimi-k2.5',
      messages: [{ role: 'user', content: 'json please' }],
      response_format: { type: 'json_object' },
    });
    expect(r.status).toBe(200);
    expect(upstreamModel).not.toBe('@cf/moonshotai/kimi-k2.5');
    expect(upstreamModel).not.toBe('@cf/moonshotai/kimi-k2.6');
  });

  it('returns 400 when no json-mode-capable model is enabled', async () => {
    const db = getDb();
    db.prepare('UPDATE models SET supports_json_mode = 0').run();
    const r = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'x' }],
      response_format: { type: 'json_object' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/No json-mode-capable/);

    // Restore some json-capable models for other tests
    db.prepare("UPDATE models SET supports_json_mode = 1 WHERE platform = 'groq' AND model_id = 'llama-3.3-70b-versatile'").run();
    db.prepare("UPDATE models SET supports_json_mode = 1 WHERE platform = 'cloudflare' AND model_id = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'").run();
  });

  it('json_schema request forwards schema to upstream', async () => {
    let upstreamBody: any = null;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      upstreamBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: upstreamBody.model ?? 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"city":"Ankara"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
    const r = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'extract city' }],
      response_format: { type: 'json_schema', json_schema: { name: 'City', schema } },
    });
    expect(r.status).toBe(200);
    // Schema must reach upstream — either as response_format (openai-compat) or as responseSchema (gemini)
    const hasOpenAi = upstreamBody?.response_format?.type === 'json_schema';
    const hasGemini = upstreamBody?.generationConfig?.responseSchema != null;
    expect(hasOpenAi || hasGemini).toBe(true);
  });

  it('plain text request does not require json-capable models', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      const b = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: b.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const r = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.status).toBe(200);
  });
});
