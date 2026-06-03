import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

describe('V30 embedding catalog seed', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('seeds CF BGE family with modality=embedding', () => {
    const rows = getDb().prepare("SELECT model_id FROM models WHERE platform='cloudflare' AND modality='embedding' ORDER BY model_id").all() as Array<{ model_id: string }>;
    const ids = rows.map(r => r.model_id);
    expect(ids).toContain('@cf/baai/bge-m3');
    expect(ids).toContain('@cf/baai/bge-large-en-v1.5');
    expect(ids).toContain('@cf/baai/bge-base-en-v1.5');
    expect(ids).toContain('@cf/baai/bge-small-en-v1.5');
  });

  it('seeds Google gemini-embedding-001', () => {
    const r = getDb().prepare("SELECT modality FROM models WHERE platform='google' AND model_id='gemini-embedding-001'").get() as { modality: string };
    expect(r?.modality).toBe('embedding');
  });

  it('seeds Cohere v3 + v4', () => {
    const rows = getDb().prepare("SELECT model_id FROM models WHERE platform='cohere' AND modality='embedding'").all() as Array<{ model_id: string }>;
    const ids = rows.map(r => r.model_id);
    expect(ids).toContain('embed-multilingual-v3.0');
    expect(ids).toContain('embed-english-v3.0');
    expect(ids).toContain('embed-v4.0');
  });

  it('seeds Mistral mistral-embed', () => {
    const r = getDb().prepare("SELECT modality FROM models WHERE platform='mistral' AND model_id='mistral-embed'").get() as { modality: string };
    expect(r?.modality).toBe('embedding');
  });

  it('seeds Zhipu embedding-3 and embedding-2', () => {
    const rows = getDb().prepare("SELECT model_id FROM models WHERE platform='zhipu' AND modality='embedding'").all() as Array<{ model_id: string }>;
    const ids = rows.map(r => r.model_id);
    expect(ids).toContain('embedding-3');
    expect(ids).toContain('embedding-2');
  });

  it('seeds GitHub openai/text-embedding-3-large', () => {
    const r = getDb().prepare("SELECT modality FROM models WHERE platform='github' AND model_id='openai/text-embedding-3-large'").get() as { modality: string };
    expect(r?.modality).toBe('embedding');
  });

  it('all embedding rows wired into fallback_config', () => {
    const orphans = getDb().prepare(`
      SELECT m.platform, m.model_id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.modality='embedding' AND m.enabled=1
    `).all() as Array<{ platform: string; model_id: string }>;
    expect(orphans).toHaveLength(0);
  });
});
