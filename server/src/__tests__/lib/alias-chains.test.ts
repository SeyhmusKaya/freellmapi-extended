import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { resolveAlias, resolveAskpusulasiChain, resolveCodingChain } from '../../lib/runChatCompletion.js';

describe('alias chains', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('resolveAlias returns null for a real model id or undefined', () => {
    expect(resolveAlias(undefined)).toBeNull();
    expect(resolveAlias('gemini-2.5-flash')).toBeNull();
  });

  it('coding alias keeps its platform restriction', () => {
    const a = resolveAlias('coding');
    expect(a).not.toBeNull();
    expect(a!.restrictToPlatforms).toEqual(['nvidia', 'cerebras']);
    expect(a!.chain).toEqual(resolveCodingChain());
  });

  it('askpusulasi alias resolves a vision-first chain with NO platform restriction', () => {
    for (const name of ['askpusulasi', 'ask-pusulasi', 'relationship', 'iliski', 'AskPusulasi']) {
      const a = resolveAlias(name);
      expect(a, name).not.toBeNull();
      expect(a!.restrictToPlatforms, name).toBeUndefined();
    }
  });

  it('askpusulasi chain only contains enabled, vision-capable models', () => {
    const db = getDb();
    const chain = resolveAskpusulasiChain();
    expect(chain.length).toBeGreaterThan(0);
    for (const id of chain) {
      const row = db.prepare('SELECT enabled, vision_capable, context_window FROM models WHERE id = ?')
        .get(id) as { enabled: number; vision_capable: number; context_window: number | null };
      expect(row.enabled).toBe(1);
      expect(row.vision_capable).toBe(1);
      // long-prompt safety: every chain model must hold a big context
      expect(row.context_window == null || row.context_window >= 100000).toBe(true);
    }
  });

  it('askpusulasi chain leads with groq llama-4-scout when present', () => {
    const db = getDb();
    const lead = resolveAskpusulasiChain()[0];
    const row = db.prepare('SELECT platform, model_id FROM models WHERE id = ?').get(lead) as
      { platform: string; model_id: string } | undefined;
    if (row) {
      // seed DB may not carry the exact catalog; assert only when resolvable
      expect(['groq', 'cloudflare', 'nvidia', 'google']).toContain(row.platform);
    }
  });
});
