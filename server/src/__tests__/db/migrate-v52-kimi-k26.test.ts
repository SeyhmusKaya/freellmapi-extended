import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';

describe('V52 OpenRouter Kimi K2.6 free', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('OpenRouter provider is registered', () => {
    expect(getProvider('openrouter')).toBeDefined();
  });

  it('kimi-k2.6:free row exists, enabled, text + json-mode, non-reasoning', () => {
    const row = getDb().prepare(`
      SELECT enabled, modality, supports_json_mode, is_reasoning, context_window
      FROM models WHERE platform='openrouter' AND model_id='moonshotai/kimi-k2.6:free'
    `).get() as
      | { enabled: number; modality: string; supports_json_mode: number; is_reasoning: number; context_window: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(1);
    expect(row!.modality).toBe('text');
    expect(row!.supports_json_mode).toBe(1);
    expect(row!.is_reasoning).toBe(0);
    expect(row!.context_window).toBe(262144);
  });

  it('kimi-k2.6:free is wired into the fallback chain', () => {
    const fb = getDb().prepare(`
      SELECT f.id FROM fallback_config f
      JOIN models m ON m.id = f.model_db_id
      WHERE m.platform='openrouter' AND m.model_id='moonshotai/kimi-k2.6:free'
    `).get() as { id: number } | undefined;
    expect(fb).toBeDefined();
  });

  it('is idempotent — no duplicate row after a second initDb', () => {
    initDb(':memory:');
    const count = getDb().prepare(`
      SELECT COUNT(*) AS c FROM models
      WHERE platform='openrouter' AND model_id='moonshotai/kimi-k2.6:free'
    `).get() as { c: number };
    expect(count.c).toBe(1);
  });
});
