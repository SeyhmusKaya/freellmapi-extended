import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { routeRequest } from '../../services/router.js';
import { resolvePreferredModel } from '../../lib/runChatCompletion.js';
import { encrypt } from '../../lib/crypto.js';

describe('router json-mode gate', () => {
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

  function insertFakeKey(platform: string) {
    const enc = encrypt('fake-key-for-test');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
    `).run(platform, enc.encrypted, enc.iv, enc.authTag);
  }

  it('json-mode request routes only to supports_json_mode=1 AND is_reasoning=0', () => {
    insertFakeKey('groq');
    const route = routeRequest(1000, undefined, undefined, false, true);
    const row = getDb().prepare('SELECT supports_json_mode, is_reasoning FROM models WHERE id = ?').get(route.modelDbId) as { supports_json_mode: number; is_reasoning: number };
    expect(row.supports_json_mode).toBe(1);
    expect(row.is_reasoning).toBe(0);
  });

  it('excludes reasoning models even if supports_json_mode were set', () => {
    const db = getDb();
    // Force-flag a reasoning model as supports_json_mode for the test
    db.prepare("UPDATE models SET supports_json_mode = 1 WHERE platform = 'cloudflare' AND model_id = '@cf/moonshotai/kimi-k2.5'").run();

    // Only enable a CF key; reasoning row should still be excluded by the
    // is_reasoning filter so router falls to other CF non-reasoning models.
    insertFakeKey('cloudflare');
    const route = routeRequest(1000, undefined, undefined, false, true);
    expect(route.modelId).not.toBe('@cf/moonshotai/kimi-k2.5');
    expect(route.modelId).not.toBe('@cf/moonshotai/kimi-k2.6');
    expect(route.modelId).not.toBe('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b');

    db.prepare("UPDATE models SET supports_json_mode = 0 WHERE platform = 'cloudflare' AND model_id = '@cf/moonshotai/kimi-k2.5'").run();
  });

  it('throws 400 when no json-mode-capable model is enabled', () => {
    const db = getDb();
    db.prepare('UPDATE models SET supports_json_mode = 0').run();
    insertFakeKey('groq');
    expect(() => routeRequest(1000, undefined, undefined, false, true)).toThrowError(/No json-mode-capable/);
    // Restore for next tests
    db.prepare("UPDATE models SET supports_json_mode = 1 WHERE platform = 'groq' AND model_id = 'llama-3.3-70b-versatile'").run();
  });

  it('non-json-mode request still routes to any enabled model', () => {
    insertFakeKey('groq');
    const route = routeRequest(1000, undefined, undefined, false, false);
    expect(route.platform).toBe('groq');
  });
});

describe('resolvePreferredModel json-mode behaviour', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('drops pin when pinned model is reasoning + json mode requested', () => {
    const db = getDb();
    db.prepare("UPDATE models SET supports_json_mode = 1 WHERE platform = 'cloudflare' AND model_id = '@cf/moonshotai/kimi-k2.5'").run();
    // Even though supports_json_mode=1 if it were forcibly set, is_reasoning=1
    // should still drop the pin.
    const result = resolvePreferredModel('@cf/moonshotai/kimi-k2.5', [], false, true);
    expect(result).toBeUndefined();
    db.prepare("UPDATE models SET supports_json_mode = 0 WHERE platform = 'cloudflare' AND model_id = '@cf/moonshotai/kimi-k2.5'").run();
  });

  it('drops pin when pinned model lacks supports_json_mode', () => {
    // Disable supports_json_mode on a known non-reasoning model and pin it
    const db = getDb();
    db.prepare("UPDATE models SET supports_json_mode = 0 WHERE platform = 'cloudflare' AND model_id = '@cf/ibm-granite/granite-4.0-h-micro'").run();
    const result = resolvePreferredModel('@cf/ibm-granite/granite-4.0-h-micro', [], false, true);
    expect(result).toBeUndefined();
  });

  it('keeps pin when pinned model supports json mode and is not reasoning', () => {
    const result = resolvePreferredModel('llama-3.3-70b-versatile', [], false, true);
    expect(typeof result).toBe('number');
  });

  it('keeps pin for non-json-mode requests regardless of capability', () => {
    const result = resolvePreferredModel('command-r-plus-08-2024', [], false, false);
    expect(typeof result).toBe('number');
  });
});
