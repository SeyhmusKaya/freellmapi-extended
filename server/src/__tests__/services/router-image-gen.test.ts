import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { routeRequest } from '../../services/router.js';
import { resolveImageGenModel } from '../../lib/runImageGeneration.js';
import { encrypt } from '../../lib/crypto.js';

function insertKey(platform: string) {
  const enc = encrypt('fake-key-for-test');
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, enc.encrypted, enc.iv, enc.authTag);
}

describe('routeRequest modality gate', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM cooldowns').run();
    db.prepare('DELETE FROM usage_counters').run();
  });

  it('modality=image_gen picks an image-gen model', () => {
    insertKey('cloudflare');
    const route = routeRequest(100, undefined, undefined, false, false, false, 'image_gen');
    const row = getDb().prepare('SELECT modality FROM models WHERE id = ?').get(route.modelDbId) as { modality: string };
    expect(row.modality).toBe('image_gen');
    expect(route.platform).toBe('cloudflare');
  });

  it('default text routing never picks image-gen models', () => {
    insertKey('groq');
    const route = routeRequest(1000, undefined, undefined, false, false, true);
    const row = getDb().prepare('SELECT modality FROM models WHERE id = ?').get(route.modelDbId) as { modality: string | null };
    // text or null (legacy rows) are fine; image_gen is not
    expect(row.modality === null || row.modality === 'text').toBe(true);
  });

  it('no image-gen models enabled → throws 400', () => {
    const db = getDb();
    db.prepare("UPDATE models SET enabled = 0 WHERE modality = 'image_gen'").run();
    insertKey('cloudflare');

    expect(() => routeRequest(100, undefined, undefined, false, false, false, 'image_gen'))
      .toThrowError(/No image-generation models/);

    db.prepare("UPDATE models SET enabled = 1 WHERE modality = 'image_gen'").run();
  });
});

describe('resolveImageGenModel', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('drops pin when caller named a text model', () => {
    expect(resolveImageGenModel('llama-3.3-70b-versatile')).toBeUndefined();
  });

  it('keeps pin when caller named an image-gen model (full id)', () => {
    const r = resolveImageGenModel('@cf/black-forest-labs/flux-1-schnell');
    expect(typeof r).toBe('number');
  });

  it('keeps pin via bare suffix id ("flux-1-schnell")', () => {
    const r = resolveImageGenModel('flux-1-schnell');
    expect(typeof r).toBe('number');
  });

  it('throws on unknown model', () => {
    expect(() => resolveImageGenModel('nonexistent-model-xyz')).toThrowError(/not in the catalog/);
  });
});
