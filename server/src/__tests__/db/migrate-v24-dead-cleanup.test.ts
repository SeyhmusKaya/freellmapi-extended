import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

describe('V24 dead model cleanup', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('disables cerebras/qwen3-235b (404 in prod)', () => {
    const r = getDb().prepare("SELECT enabled FROM models WHERE platform='cerebras' AND model_id='qwen3-235b'").get() as { enabled: number } | undefined;
    if (r) expect(r.enabled).toBe(0);
  });

  it('disables sambanova/DeepSeek-V3.1-cb (410 GONE)', () => {
    const r = getDb().prepare("SELECT enabled FROM models WHERE platform='sambanova' AND model_id='DeepSeek-V3.1-cb'").get() as { enabled: number } | undefined;
    if (r) expect(r.enabled).toBe(0);
  });

  it('disables openrouter retired-free models', () => {
    const rows = getDb().prepare(`SELECT model_id, enabled FROM models WHERE platform='openrouter' AND model_id IN (
      'inclusionai/ling-2.6-1t:free',
      'nvidia/nemotron-nano-9b-v2:free',
      'tencent/hy3-preview:free'
    )`).all() as Array<{ model_id: string; enabled: number }>;
    for (const r of rows) expect(r.enabled).toBe(0);
  });
});
