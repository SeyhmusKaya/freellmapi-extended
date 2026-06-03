import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';

describe('V22 new providers (DeepSeek, AI21, Reka)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('DeepSeek provider registered + 2 model rows', () => {
    expect(getProvider('deepseek')).toBeDefined();
    const rows = getDb().prepare("SELECT model_id, is_reasoning FROM models WHERE platform='deepseek' ORDER BY model_id").all() as Array<{ model_id: string; is_reasoning: number }>;
    expect(rows).toHaveLength(2);
    const chat = rows.find(r => r.model_id === 'deepseek-chat')!;
    const reasoner = rows.find(r => r.model_id === 'deepseek-reasoner')!;
    expect(chat.is_reasoning).toBe(0);
    expect(reasoner.is_reasoning).toBe(1);
  });

  // V23 replaced jamba-1.6 series with jamba-mini-2 + jamba-large-1.7
  it('AI21 provider registered + 2 enabled Jamba models (V23 corrected IDs)', () => {
    expect(getProvider('ai21')).toBeDefined();
    const rows = getDb().prepare("SELECT model_id, supports_json_mode FROM models WHERE platform='ai21' AND enabled=1").all() as Array<{ model_id: string; supports_json_mode: number }>;
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.model_id)).toEqual(expect.arrayContaining(['jamba-large-1.7-2025-07', 'jamba-mini-2-2026-01']));
    for (const r of rows) expect(r.supports_json_mode).toBe(1);
  });

  // V23 removed reka-core (nonexistent), added reka-edge-2603 (vision)
  it('Reka provider registered + 2 enabled models (V23 corrected)', () => {
    expect(getProvider('reka')).toBeDefined();
    const rows = getDb().prepare("SELECT model_id FROM models WHERE platform='reka' AND enabled=1").all() as Array<{ model_id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.model_id)).toEqual(expect.arrayContaining(['reka-flash-3', 'reka-edge-2603']));
  });

  it('reka-edge-2603 is vision_capable', () => {
    const row = getDb().prepare("SELECT vision_capable FROM models WHERE platform='reka' AND model_id='reka-edge-2603'").get() as { vision_capable: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.vision_capable).toBe(1);
  });

  it('all enabled new rows get fallback_config entries', () => {
    const orphans = getDb().prepare(`
      SELECT m.platform, m.model_id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.platform IN ('deepseek','ai21','reka') AND m.enabled = 1
    `).all() as Array<{ platform: string; model_id: string }>;
    expect(orphans).toHaveLength(0);
  });

  it('all new platforms text modality (not image_gen)', () => {
    const rows = getDb().prepare(`
      SELECT modality FROM models WHERE platform IN ('deepseek','ai21','reka')
    `).all() as Array<{ modality: string }>;
    for (const r of rows) expect(r.modality).toBe('text');
  });
});
