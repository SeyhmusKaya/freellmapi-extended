import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

describe('migrateModelsV15ImageGen', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('adds modality + neurons_per_call columns to models', () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info('models')").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('modality');
    expect(names).toContain('neurons_per_call');
  });

  it('adds modality column to requests', () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info('requests')").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('modality');
  });

  // V15 originally seeded 5 CF image-gen rows. V28 (May 2026) added
  // @cf/black-forest-labs/flux-2-klein-9b so the expected count is 6.
  it('seeds CF image-gen models with modality=image_gen (V15 + V28)', () => {
    const db = getDb();
    const rows = db.prepare("SELECT model_id, modality, neurons_per_call FROM models WHERE platform = 'cloudflare' AND modality = 'image_gen' ORDER BY model_id").all() as Array<{ model_id: string; modality: string; neurons_per_call: number }>;
    expect(rows.length).toBe(6);
    const ids = rows.map(r => r.model_id);
    expect(ids).toContain('@cf/black-forest-labs/flux-1-schnell');
    expect(ids).toContain('@cf/bytedance/stable-diffusion-xl-lightning');
    expect(ids).toContain('@cf/lykon/dreamshaper-8-lcm');
    expect(ids).toContain('@cf/stabilityai/stable-diffusion-xl-base-1.0');
    expect(ids).toContain('@cf/runwayml/stable-diffusion-v1-5-inpainting');
    expect(ids).toContain('@cf/black-forest-labs/flux-2-klein-9b');
    // neurons_per_call sanity
    const flux = rows.find(r => r.model_id === '@cf/black-forest-labs/flux-1-schnell')!;
    expect(flux.neurons_per_call).toBe(80);
    const sdxlBase = rows.find(r => r.model_id === '@cf/stabilityai/stable-diffusion-xl-base-1.0')!;
    expect(sdxlBase.neurons_per_call).toBe(600);
  });

  it('text models default modality=text', () => {
    const db = getDb();
    const row = db.prepare("SELECT modality FROM models WHERE platform='groq' AND model_id='llama-3.3-70b-versatile'").get() as { modality: string };
    expect(row.modality).toBe('text');
  });

  it('image-gen rows get fallback_config entries', () => {
    const db = getDb();
    const orphans = db.prepare(`
      SELECT m.model_id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.modality = 'image_gen'
    `).all() as Array<{ model_id: string }>;
    expect(orphans.length).toBe(0);
  });
});
