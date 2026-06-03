import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

describe('V19 + V20 + V21 migrations', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('V19 seeds 4 extra Pollinations models', () => {
    const rows = getDb().prepare(
      "SELECT model_id FROM models WHERE platform='pollinations' AND modality='image_gen' ORDER BY model_id"
    ).all() as Array<{ model_id: string }>;
    const ids = rows.map(r => r.model_id);
    // Original 4 from V16 + 4 from V19
    expect(ids).toContain('pollinations/flux-3d');
    expect(ids).toContain('pollinations/flux-pro');
    expect(ids).toContain('pollinations/gptimage');
    expect(ids).toContain('pollinations/midjourney');
    expect(rows.length).toBe(8);
  });

  it('V20 seeds Zhipu CogView image-gen rows', () => {
    const rows = getDb().prepare(
      "SELECT model_id, modality FROM models WHERE platform='zhipu' AND modality='image_gen' ORDER BY model_id"
    ).all() as Array<{ model_id: string; modality: string }>;
    const ids = rows.map(r => r.model_id);
    expect(ids).toContain('cogview-3-flash');
    expect(ids).toContain('cogview-3-plus');
    expect(ids).toContain('cogview-3');
    for (const r of rows) expect(r.modality).toBe('image_gen');
  });

  it('V21 seeds CF Whisper rows', () => {
    const rows = getDb().prepare(
      "SELECT model_id, modality, neurons_per_call FROM models WHERE platform='cloudflare' AND modality='audio_stt'"
    ).all() as Array<{ model_id: string; modality: string; neurons_per_call: number }>;
    expect(rows.length).toBe(2);
    const ids = rows.map(r => r.model_id);
    expect(ids).toContain('@cf/openai/whisper-large-v3-turbo');
    expect(ids).toContain('@cf/openai/whisper');
    for (const r of rows) expect(r.modality).toBe('audio_stt');
  });

  it('audio_stt rows have fallback_config entries', () => {
    const orphans = getDb().prepare(`
      SELECT m.model_id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.modality = 'audio_stt'
    `).all() as Array<{ model_id: string }>;
    expect(orphans.length).toBe(0);
  });
});
