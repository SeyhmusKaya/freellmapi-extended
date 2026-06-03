import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey, authenticateApiKey } from '../../db/index.js';

async function req(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  server.close();
  return { status: res.status, body: data };
}

describe('Client Keys CRUD', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM client_keys WHERE id != 1').run();
  });

  it('V46 seeds the unified key as id=1 "Genel"', async () => {
    const r = await req(app, 'GET', '/api/client-keys');
    expect(r.status).toBe(200);
    const general = r.body.find((k: any) => k.id === 1);
    expect(general).toBeDefined();
    expect(general.name).toBe('Default');
    expect(general.enabled).toBe(1);
  });

  it('legacy unified key still authenticates', () => {
    const unified = getUnifiedApiKey();
    const auth = authenticateApiKey(unified);
    expect(auth).toEqual({ id: 1, name: 'Default' });
  });

  it('POST creates a key and returns plain value ONCE', async () => {
    const r = await req(app, 'POST', '/api/client-keys', { name: 'Cline' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('Cline');
    expect(r.body.key).toMatch(/^myllm-[0-9a-f]{48}$/);
    expect(r.body.key_prefix.length).toBeGreaterThan(0);

    // Subsequent list MUST NOT contain the plain key value.
    const list = await req(app, 'GET', '/api/client-keys');
    const row = list.body.find((k: any) => k.id === r.body.id);
    expect(row.key).toBeUndefined();
  });

  it('newly created key authenticates', async () => {
    const r = await req(app, 'POST', '/api/client-keys', { name: 'EmlakCopilot' });
    const auth = authenticateApiKey(r.body.key);
    expect(auth).toEqual({ id: r.body.id, name: 'EmlakCopilot' });
  });

  it('disabled key fails to authenticate', async () => {
    const created = await req(app, 'POST', '/api/client-keys', { name: 'X' });
    await req(app, 'PATCH', `/api/client-keys/${created.body.id}`, { enabled: false });
    const auth = authenticateApiKey(created.body.key);
    expect(auth).toBeNull();
  });

  it('PATCH renames a key', async () => {
    const created = await req(app, 'POST', '/api/client-keys', { name: 'Old' });
    const r = await req(app, 'PATCH', `/api/client-keys/${created.body.id}`, { name: 'New' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('New');
  });

  it('DELETE removes a non-protected key', async () => {
    const created = await req(app, 'POST', '/api/client-keys', { name: 'Temp' });
    const r = await req(app, 'DELETE', `/api/client-keys/${created.body.id}`);
    expect(r.status).toBe(204);
    expect(authenticateApiKey(created.body.key)).toBeNull();
  });

  it('DELETE id=1 ("Genel") is rejected', async () => {
    const r = await req(app, 'DELETE', '/api/client-keys/1');
    expect(r.status).toBe(400);
    expect(getDb().prepare('SELECT id FROM client_keys WHERE id = 1').get()).toBeDefined();
  });

  it('PATCH cannot disable id=1', async () => {
    const r = await req(app, 'PATCH', '/api/client-keys/1', { enabled: false });
    expect(r.status).toBe(400);
  });

  it('GET /:id/reveal returns the plain key for a freshly-created row (V49)', async () => {
    const created = await req(app, 'POST', '/api/client-keys', { name: 'Revealable' });
    const reveal = await req(app, 'GET', `/api/client-keys/${created.body.id}/reveal`);
    expect(reveal.status).toBe(200);
    expect(reveal.body.key).toBe(created.body.key);
  });

  it('GET /:id/reveal on the seeded Default key (V49 back-fill) works', async () => {
    const reveal = await req(app, 'GET', '/api/client-keys/1/reveal');
    expect(reveal.status).toBe(200);
    expect(reveal.body.key).toMatch(/^myllm-/);
    // Sanity: revealed value authenticates as id=1.
    expect(authenticateApiKey(reveal.body.key)).toEqual({ id: 1, name: 'Default' });
  });

  it('GET /:id/reveal returns 404 for a missing row', async () => {
    const reveal = await req(app, 'GET', '/api/client-keys/99999/reveal');
    expect(reveal.status).toBe(404);
  });
});
