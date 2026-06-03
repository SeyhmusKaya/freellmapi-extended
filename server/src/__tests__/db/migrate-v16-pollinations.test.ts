import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

describe('migrateModelsV16Pollinations', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('seeds 4 pollinations rows with modality=image_gen', () => {
    const rows = getDb().prepare(
      "SELECT model_id, modality, rpm_limit FROM models WHERE platform = 'pollinations' ORDER BY model_id"
    ).all() as Array<{ model_id: string; modality: string; rpm_limit: number }>;
    // V16 seeds 4 rows; V19 adds 4 more. Original V16 set must be present.
    const ids = rows.map(r => r.model_id);
    expect(ids).toContain('pollinations/flux');
    expect(ids).toContain('pollinations/turbo');
    expect(ids).toContain('pollinations/flux-realism');
    expect(ids).toContain('pollinations/flux-anime');
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) {
      expect(r.modality).toBe('image_gen');
      expect(r.rpm_limit).toBe(5);
    }
  });

  it('pollinations rows get fallback_config entries', () => {
    const orphans = getDb().prepare(`
      SELECT m.model_id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.platform = 'pollinations'
    `).all() as Array<{ model_id: string }>;
    expect(orphans).toHaveLength(0);
  });
});
