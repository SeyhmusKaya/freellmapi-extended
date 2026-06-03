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

const TINY = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('E2E vision proxy', () => {
  let app: Express;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();

    // Add a Groq key so a vision-capable model has an enabled key.
    await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'gsk_test_vision', label: 'vision-e2e' });
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM cooldowns').run();
    db.prepare('DELETE FROM usage_counters').run();
  });

  afterEach(() => vi.restoreAllMocks());

  it('routes vision payload to a vision_capable model and forwards array content', async () => {
    let upstream: any = null;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      upstream = { url: u, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({
        id: 'chatcmpl-x', object: 'chat.completion', created: 0, model: upstream.body.model ?? 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'a cat' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const r = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY}` } },
        ],
      }],
    });
    expect(r.status).toBe(200);

    // Verify request actually went to a vision-capable model on a supported platform
    expect(upstream.url).toContain('api.groq.com');
    expect(upstream.body.model).toBe('meta-llama/llama-4-scout-17b-16e-instruct');
    expect(Array.isArray(upstream.body.messages[0].content)).toBe(true);
    expect(upstream.body.messages[0].content[1].image_url.url.startsWith('data:image/png')).toBe(true);

    // Header set
    expect(r.headers.get('x-routed-via')).toContain('groq');
  });

  it('refuses pinned non-vision model when image included → cascade to vision', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      const b = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: b.model ?? 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const r = await request(app, 'POST', '/v1/chat/completions', {
      model: 'command-r-plus-08-2024',  // not vision-capable
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${TINY}` } }],
      }],
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-routed-via')).not.toContain('command-r-plus');
  });

  it('returns 400 when no vision-capable model has an enabled key', async () => {
    // Drop the groq key so vision needs google/sambanova/cloudflare/openrouter
    // but none have keys (only groq was added in beforeAll). Disable Cohere's key
    // we may have implicitly... easier: disable vision_capable flag on every model.
    const db = getDb();
    db.prepare('UPDATE models SET vision_capable = 0').run();

    const r = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${TINY}` } }],
      }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/No vision-capable/);

    // Restore for other tests
    db.prepare("UPDATE models SET vision_capable = 1 WHERE platform = 'groq' AND model_id = 'meta-llama/llama-4-scout-17b-16e-instruct'").run();
  });

  it('returns 400 for invalid image_url scheme', async () => {
    const r = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }],
      }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message.toLowerCase()).toContain('data:image');
  });

  it('plain text request still routes to non-vision models normally', async () => {
    let model: string | null = null;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(input, init);
      const b = JSON.parse(init.body as string);
      model = b.model;
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
    expect(model).toBeTruthy();
  });
});
