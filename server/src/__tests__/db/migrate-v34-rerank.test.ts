import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

describe('V34 rerank catalog (Cohere)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('seeds 3 Cohere rerank rows with modality=rerank', () => {
    const rows = getDb().prepare("SELECT model_id FROM models WHERE platform='cohere' AND modality='rerank' ORDER BY model_id").all() as Array<{ model_id: string }>;
    const ids = rows.map(r => r.model_id);
    expect(ids).toContain('rerank-v3.5');
    expect(ids).toContain('rerank-v4.0-fast');
    expect(ids).toContain('rerank-v4.0-pro');
  });

  it('all rerank rows wired into fallback_config', () => {
    const orphans = getDb().prepare(`
      SELECT m.model_id FROM models m
      LEFT JOIN fallback_config f ON m.id=f.model_db_id
      WHERE f.id IS NULL AND m.enabled=1 AND m.modality='rerank'
    `).all();
    expect(orphans).toHaveLength(0);
  });
});
