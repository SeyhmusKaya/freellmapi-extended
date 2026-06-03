import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

describe('V32 Codestral + CF MeloTTS seed', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('seeds Mistral codestral-latest as text modality', () => {
    const r = getDb().prepare("SELECT modality FROM models WHERE platform='mistral' AND model_id='codestral-latest'").get() as { modality: string } | undefined;
    expect(r).toBeDefined();
    expect(r!.modality).toBe('text');
  });

  it('seeds CF @cf/myshell-ai/melotts as audio_tts modality', () => {
    const r = getDb().prepare("SELECT modality, neurons_per_call FROM models WHERE platform='cloudflare' AND model_id='@cf/myshell-ai/melotts'").get() as { modality: string; neurons_per_call: number } | undefined;
    expect(r).toBeDefined();
    expect(r!.modality).toBe('audio_tts');
    expect(r!.neurons_per_call).toBe(30);
  });

  it('both new rows wired into fallback_config', () => {
    const orphans = getDb().prepare(`
      SELECT m.platform, m.model_id FROM models m
      LEFT JOIN fallback_config f ON m.id=f.model_db_id
      WHERE f.id IS NULL AND m.enabled=1
        AND ((m.platform='mistral' AND m.model_id='codestral-latest')
          OR (m.platform='cloudflare' AND m.model_id='@cf/myshell-ai/melotts'))
    `).all();
    expect(orphans).toHaveLength(0);
  });
});
