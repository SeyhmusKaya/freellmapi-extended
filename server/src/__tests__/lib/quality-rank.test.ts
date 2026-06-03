import { describe, it, expect } from 'vitest';
import { qualityScore, diversify, imageGenRank, healthPenalty, latencyPenalty, MIN_HEALTH_SAMPLE, type ScoredModel } from '../../lib/qualityRank.js';

function model(over: Partial<ScoredModel>): ScoredModel {
  return {
    modelDbId: over.modelDbId ?? 1,
    platform: over.platform ?? 'groq',
    modelId: over.modelId ?? 'm',
    intelligenceRank: over.intelligenceRank ?? 10,
    speedRank: over.speedRank ?? 5,
    rpmLimit: over.rpmLimit ?? 30,
    rpdLimit: over.rpdLimit ?? null,
    isReasoning: over.isReasoning ?? 0,
    modality: over.modality ?? 'text',
    score: over.score ?? 0,
  };
}

describe('qualityScore', () => {
  it('favours intelligence over speed in the catalog component', () => {
    // smarter (iq 5) but slower (spd 10) vs dumber (iq 10) but faster (spd 5)
    const smart = qualityScore({ intelligenceRank: 5, speedRank: 10, rpmLimit: 30, rpdLimit: null, isReasoning: 0 });
    const fast = qualityScore({ intelligenceRank: 10, speedRank: 5, rpmLimit: 30, rpdLimit: null, isReasoning: 0 });
    // V57: smart = 5*1.0 + 10*0.5 = 10 ; fast = 10*1.0 + 5*0.5 = 12.5 → smart wins
    expect(smart).toBeLessThan(fast);
  });

  it('caps intelligence so the long tail of fine models stays compressed', () => {
    // rank 12 and rank 27 score identically on intelligence (both capped at 12)
    const a = qualityScore({ intelligenceRank: 12, speedRank: 5, rpmLimit: 30, rpdLimit: null, isReasoning: 0 });
    const b = qualityScore({ intelligenceRank: 27, speedRank: 5, rpmLimit: 30, rpdLimit: null, isReasoning: 0 });
    expect(a).toBe(b);
  });

  it('penalises tiny daily caps', () => {
    const big = qualityScore({ intelligenceRank: 10, speedRank: 5, rpmLimit: 30, rpdLimit: 14400, isReasoning: 0 });
    const tiny = qualityScore({ intelligenceRank: 10, speedRank: 5, rpmLimit: 30, rpdLimit: 20, isReasoning: 0 });
    expect(tiny - big).toBe(14);
  });

  it('demotes reasoning models by 4', () => {
    const base = { intelligenceRank: 5, speedRank: 5, rpmLimit: 40, rpdLimit: null };
    expect(qualityScore({ ...base, isReasoning: 1 }) - qualityScore({ ...base, isReasoning: 0 })).toBe(4);
  });

  it('NULL rpm gets a mild penalty, >=40 rpm gets none', () => {
    const base = { intelligenceRank: 5, speedRank: 5, rpdLimit: null, isReasoning: 0 };
    expect(qualityScore({ ...base, rpmLimit: null }) - qualityScore({ ...base, rpmLimit: 40 })).toBe(3);
  });
});

describe('healthPenalty (V57 measured reliability)', () => {
  it('returns 0 below the trust sample threshold', () => {
    expect(healthPenalty(0, MIN_HEALTH_SAMPLE - 1)).toBe(0);
    expect(healthPenalty(null, 1000)).toBe(0);
  });

  it('healthy models (>=90%) get no penalty', () => {
    expect(healthPenalty(95, 100)).toBe(0);
    expect(healthPenalty(90, 100)).toBe(0);
  });

  it('penalty grows as success rate falls', () => {
    expect(healthPenalty(85, 100)).toBe(10);
    expect(healthPenalty(70, 100)).toBe(28);
    expect(healthPenalty(50, 100)).toBe(50);
    expect(healthPenalty(20, 100)).toBe(75);
  });

  it('a chronic-failure penalty stays below a hard chronic-demote', () => {
    // 75 must keep a flaky-but-alive model above a known-broken (1000) one
    expect(healthPenalty(0, 100)).toBeLessThan(1000);
  });
});

describe('latencyPenalty (V57 measured speed)', () => {
  it('null (no traffic) is neutral', () => {
    expect(latencyPenalty(null)).toBe(0);
  });

  it('sub-1.5s is free, multi-second sinks the model', () => {
    expect(latencyPenalty(400)).toBe(0);
    expect(latencyPenalty(2500)).toBe(6);
    expect(latencyPenalty(6000)).toBe(16);
    expect(latencyPenalty(12000)).toBe(28);
    expect(latencyPenalty(33000)).toBe(40);
  });

  it('a fast 70B beats a slow frontier once health+latency are folded in', () => {
    // groq llama-3.3-70b: ir 17, 0.1s, 95% prod  vs  480b coder: ir 3, 33s, 51% prod
    const fast = qualityScore({ intelligenceRank: 17, speedRank: 2, rpmLimit: 30, rpdLimit: null, isReasoning: 0 })
      + healthPenalty(95, 400) + latencyPenalty(100);
    const slowFrontier = qualityScore({ intelligenceRank: 3, speedRank: 4, rpmLimit: 40, rpdLimit: null, isReasoning: 0 })
      + healthPenalty(51, 2900) + latencyPenalty(33000);
    expect(fast).toBeLessThan(slowFrontier);
  });
});

describe('diversify', () => {
  it('never lets one platform fill 3 consecutive slots', () => {
    const sorted: ScoredModel[] = [
      model({ modelDbId: 1, platform: 'nvidia' }),
      model({ modelDbId: 2, platform: 'nvidia' }),
      model({ modelDbId: 3, platform: 'nvidia' }),
      model({ modelDbId: 4, platform: 'nvidia' }),
      model({ modelDbId: 5, platform: 'cerebras' }),
      model({ modelDbId: 6, platform: 'groq' }),
    ];
    const out = diversify(sorted);
    for (let i = 2; i < out.length; i++) {
      const triple = out[i].platform === out[i - 1].platform && out[i - 1].platform === out[i - 2].platform;
      expect(triple).toBe(false);
    }
    expect(out.length).toBe(6);
  });

  it('keeps best-scored eligible model first when no diversity conflict', () => {
    const sorted: ScoredModel[] = [
      model({ modelDbId: 1, platform: 'nvidia' }),
      model({ modelDbId: 2, platform: 'cerebras' }),
      model({ modelDbId: 3, platform: 'groq' }),
    ];
    const out = diversify(sorted);
    expect(out.map(m => m.modelDbId)).toEqual([1, 2, 3]);
  });

  it('falls back to score order when only one platform remains', () => {
    const sorted: ScoredModel[] = [
      model({ modelDbId: 1, platform: 'nvidia' }),
      model({ modelDbId: 2, platform: 'nvidia' }),
      model({ modelDbId: 3, platform: 'nvidia' }),
    ];
    const out = diversify(sorted);
    expect(out.map(m => m.modelDbId)).toEqual([1, 2, 3]);
  });
});

describe('imageGenRank', () => {
  it('ranks FLUX families above CogView and Stable Diffusion', () => {
    expect(imageGenRank('@cf/black-forest-labs/flux-2-klein-9b'))
      .toBeLessThan(imageGenRank('pollinations/turbo'));
    expect(imageGenRank('pollinations/flux-pro'))
      .toBeLessThan(imageGenRank('cogview-3-plus'));
    expect(imageGenRank('cogview-3-plus'))
      .toBeLessThan(imageGenRank('@cf/stabilityai/stable-diffusion-xl-base-1.0'));
  });

  it('flux-2 is the single best tier', () => {
    expect(imageGenRank('@cf/black-forest-labs/flux-2-klein-9b')).toBe(1);
  });

  it('unknown models land mid-pack', () => {
    expect(imageGenRank('some/unknown-model')).toBe(50);
  });
});
