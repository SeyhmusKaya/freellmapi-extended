import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { routeRequest } from '../../services/router.js';
import { encrypt } from '../../lib/crypto.js';

function insertKey(platform: string) {
  const enc = encrypt('fake-key-for-test');
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, enc.encrypted, enc.iv, enc.authTag);
}

describe('routeRequest reasoning exclusion', () => {
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

  it('default auto-route picks NON-reasoning model when excludeReasoning=true', () => {
    insertKey('cloudflare');
    insertKey('groq');
    const route = routeRequest(1000, undefined, undefined, false, false, true);
    const row = getDb().prepare('SELECT is_reasoning FROM models WHERE id = ?').get(route.modelDbId) as { is_reasoning: number };
    expect(row.is_reasoning).toBe(0);
  });

  it('excludeReasoning=false allows reasoning models in chain (opt-in)', () => {
    // Disable every non-reasoning model so the chain has to pick a reasoning one
    const db = getDb();
    db.prepare("UPDATE models SET enabled = 0 WHERE is_reasoning = 0").run();
    insertKey('cloudflare');
    insertKey('mistral');
    insertKey('openrouter');

    const route = routeRequest(1000, undefined, undefined, false, false, false);
    const row = db.prepare('SELECT is_reasoning, model_id FROM models WHERE id = ?').get(route.modelDbId) as { is_reasoning: number; model_id: string };
    expect(row.is_reasoning).toBe(1);

    // Restore enabled flags
    db.prepare("UPDATE models SET enabled = 1 WHERE is_reasoning = 1").run();
    db.prepare("UPDATE models SET enabled = 1").run();
  });

  it('explicit pin to reasoning model still routes when excludeReasoning=false (caller opt-in via requestedModel)', () => {
    const db = getDb();
    const pinned = db.prepare("SELECT id FROM models WHERE platform='cloudflare' AND model_id='@cf/moonshotai/kimi-k2.6'").get() as { id: number } | undefined;
    expect(pinned).toBeDefined();
    insertKey('cloudflare');

    // Pinned reasoning + excludeReasoning=false → should route to that exact model
    const route = routeRequest(1000, undefined, pinned!.id, false, false, false);
    expect(route.modelDbId).toBe(pinned!.id);
  });

  it('vision + excludeReasoning combo: only non-reasoning vision-capable models', () => {
    insertKey('groq');
    insertKey('google');
    const route = routeRequest(1000, undefined, undefined, true, false, true);
    const row = getDb().prepare('SELECT is_reasoning, vision_capable FROM models WHERE id = ?').get(route.modelDbId) as { is_reasoning: number; vision_capable: number };
    expect(row.vision_capable).toBe(1);
    expect(row.is_reasoning).toBe(0);
  });
});
