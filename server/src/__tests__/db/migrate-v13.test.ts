import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

describe('migrateModelsV13DeadModels', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('disables OR Ling-2.6-1T:free and Hy3 preview:free', () => {
    const db = getDb();
    const ling = db.prepare("SELECT enabled FROM models WHERE platform='openrouter' AND model_id='inclusionai/ling-2.6-1t:free'").get() as { enabled: number } | undefined;
    const hy3  = db.prepare("SELECT enabled FROM models WHERE platform='openrouter' AND model_id='tencent/hy3-preview:free'").get() as { enabled: number } | undefined;
    expect(ling?.enabled).toBe(0);
    expect(hy3?.enabled).toBe(0);
  });

  it('unflags MiniMax M2.5 vision (OR has no image endpoint)', () => {
    const db = getDb();
    const row = db.prepare("SELECT vision_capable FROM models WHERE platform='openrouter' AND model_id='minimax/minimax-m2.5:free'").get() as { vision_capable: number } | undefined;
    expect(row?.vision_capable).toBe(0);
  });

  it('keeps other vision-capable rows untouched (sanity)', () => {
    const db = getDb();
    const gemini = db.prepare("SELECT vision_capable FROM models WHERE platform='google' AND model_id='gemini-2.5-flash'").get() as { vision_capable: number };
    expect(gemini.vision_capable).toBe(1);
    const scout = db.prepare("SELECT vision_capable FROM models WHERE platform='groq' AND model_id='meta-llama/llama-4-scout-17b-16e-instruct'").get() as { vision_capable: number };
    expect(scout.vision_capable).toBe(1);
  });
});
