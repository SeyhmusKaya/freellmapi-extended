import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

describe('migrateModelsV12 (json mode + reasoning flags)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('adds supports_json_mode + is_reasoning columns', () => {
    const cols = getDb().prepare(`PRAGMA table_info(models)`).all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('supports_json_mode');
    expect(names).toContain('is_reasoning');
  });

  it('flags Gemini Flash as json-capable', () => {
    const row = getDb().prepare(`SELECT supports_json_mode, is_reasoning FROM models WHERE platform = ? AND model_id = ?`).get('google', 'gemini-2.5-flash') as any;
    expect(row.supports_json_mode).toBe(1);
    expect(row.is_reasoning).toBe(0);
  });

  it('flags Kimi K2.5 as reasoning', () => {
    const row = getDb().prepare(`SELECT supports_json_mode, is_reasoning FROM models WHERE platform = ? AND model_id = ?`).get('cloudflare', '@cf/moonshotai/kimi-k2.5') as any;
    expect(row.is_reasoning).toBe(1);
  });

  it('flags magistral-medium as reasoning', () => {
    const row = getDb().prepare(`SELECT is_reasoning FROM models WHERE platform = ? AND model_id = ?`).get('mistral', 'magistral-medium-latest') as any;
    expect(row.is_reasoning).toBe(1);
  });

  it('flags DeepSeek R1 distill as reasoning', () => {
    const row = getDb().prepare(`SELECT is_reasoning FROM models WHERE platform = ? AND model_id = ?`).get('cloudflare', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b') as any;
    expect(row.is_reasoning).toBe(1);
  });

  it('json-capable count > 0', () => {
    const r = getDb().prepare(`SELECT COUNT(*) AS cnt FROM models WHERE supports_json_mode = 1`).get() as { cnt: number };
    expect(r.cnt).toBeGreaterThanOrEqual(20);
  });

  it('reasoning count > 0', () => {
    const r = getDb().prepare(`SELECT COUNT(*) AS cnt FROM models WHERE is_reasoning = 1`).get() as { cnt: number };
    expect(r.cnt).toBeGreaterThanOrEqual(5);
  });
});
