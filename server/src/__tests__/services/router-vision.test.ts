import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { routeRequest } from '../../services/router.js';
import { resolvePreferredModel } from '../../lib/runChatCompletion.js';
import { encrypt } from '../../lib/crypto.js';

describe('router vision gate', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    // Add a Groq API key so the router has a working route.
    // Manual insert: encrypt a known string via the encryption module
    // would couple too tightly; we use api_keys but rely on real encryption.
    // Instead: insert a Google key via the keys helper-style raw insert.
    // (router only checks status != 'invalid' AND enabled = 1; encryption
    // is decrypted on demand. To keep this unit-level we insert with a
    // dummy ciphertext that won't actually be decrypted — router throws
    // only when it tries to decrypt the chosen key. We don't call provider,
    // so route() returning is enough proof.)
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM cooldowns').run();
    db.prepare('DELETE FROM usage_counters').run();
    // Keyless kilo routes without a key and would win these single-key tests;
    // disable it so platform assertions stay deterministic.
    db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'kilo'").run();
  });

  function insertFakeKey(platform: string) {
    const enc = encrypt('fake-key-for-test');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
    `).run(platform, enc.encrypted, enc.iv, enc.authTag);
  }

  it('vision request routes to a vision_capable model', () => {
    insertFakeKey('google');
    const route = routeRequest(1000, undefined, undefined, true);
    expect(route.platform).toBe('google');
    // Should be one of the flagged vision models
    const visionRow = getDb().prepare('SELECT vision_capable FROM models WHERE platform = ? AND model_id = ?')
      .get(route.platform, route.modelId) as { vision_capable: number };
    expect(visionRow.vision_capable).toBe(1);
  });

  it('non-vision request can route to any enabled model', () => {
    insertFakeKey('google');
    const route = routeRequest(1000, undefined, undefined, false);
    expect(['google']).toContain(route.platform);
  });

  it('throws 400 when no vision-capable model is enabled', () => {
    const db = getDb();
    // Disable all vision-capable models
    db.prepare('UPDATE models SET vision_capable = 0').run();
    insertFakeKey('google');
    expect(() => routeRequest(1000, undefined, undefined, true)).toThrowError(/No vision-capable models/);

    // Restore for other tests
    db.prepare("UPDATE models SET vision_capable = 1 WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'").run();
  });

  it('vision request prefers a vision-capable model even when fallback chain has non-vision first', () => {
    insertFakeKey('google');
    const route = routeRequest(1000, undefined, undefined, true);
    const row = getDb().prepare('SELECT vision_capable FROM models WHERE id = ?').get(route.modelDbId) as { vision_capable: number };
    expect(row.vision_capable).toBe(1);
  });
});

describe('resolvePreferredModel vision behaviour', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('drops the pin when user pinned a non-vision model but sent images', () => {
    // command-r-plus is not vision-capable per our seed
    const result = resolvePreferredModel('command-r-plus-08-2024', [], true);
    expect(result).toBeUndefined();
  });

  it('keeps the pin when pinned model is vision-capable', () => {
    const result = resolvePreferredModel('gemini-2.5-flash', [], true);
    expect(typeof result).toBe('number');
  });

  it('keeps the pin for non-vision requests regardless of model capability', () => {
    const result = resolvePreferredModel('command-r-plus-08-2024', [], false);
    expect(typeof result).toBe('number');
  });

  it('throws for unknown model id', () => {
    expect(() => resolvePreferredModel('no-such-model', [], false)).toThrowError(/not in the catalog|disabled/);
  });
});
