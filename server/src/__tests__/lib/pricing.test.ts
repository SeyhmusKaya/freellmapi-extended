import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { computeCostMicro, invalidatePriceCache } from '../../lib/pricing.js';

describe('computeCostMicro', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => {
    invalidatePriceCache();
  });

  it('uses default pricing for unknown model', () => {
    // defaults (Gemini 3.1 Flash-Lite): input=0.25 USD/1M, output=1.50 USD/1M
    // 1000 input tokens + 500 output tokens
    // cost = 1000*0.25 + 500*1.50 = 250 + 750 = 1000 micro
    const cost = computeCostMicro({
      platform: 'unknown_platform',
      modelId: 'unknown_model',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(cost).toBe(1000);
  });

  it('uses default pricing for text modality', () => {
    const cost = computeCostMicro({
      platform: 'groq',
      modelId: 'llama-3.3-70b-versatile',
      inputTokens: 2000,
      outputTokens: 1000,
      modality: 'text',
    });
    // 2000*0.25 + 1000*1.50 = 500 + 1500 = 2000 micro
    expect(cost).toBe(2000);
  });

  it('uses model-level override when set', () => {
    const db = getDb();
    // Set a custom price for groq/llama-3.3-70b-versatile
    db.prepare(
      "UPDATE models SET price_input_per_1m = 1, price_output_per_1m = 5 WHERE platform = 'groq' AND model_id = 'llama-3.3-70b-versatile'"
    ).run();
    invalidatePriceCache();

    const cost = computeCostMicro({
      platform: 'groq',
      modelId: 'llama-3.3-70b-versatile',
      inputTokens: 1000,
      outputTokens: 1000,
    });
    // 1000*1 + 1000*5 = 6000 micro
    expect(cost).toBe(6000);

    // Reset
    db.prepare(
      "UPDATE models SET price_input_per_1m = NULL, price_output_per_1m = NULL WHERE platform = 'groq' AND model_id = 'llama-3.3-70b-versatile'"
    ).run();
  });

  it('uses per-call pricing for image_gen modality', () => {
    // default per_call = 0.04 USD → 40000 micro
    const cost = computeCostMicro({
      platform: 'cloudflare',
      modelId: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
      inputTokens: 0,
      outputTokens: 0,
      modality: 'image_gen',
    });
    expect(cost).toBe(40000);
  });

  it('uses per-call pricing for audio_tts modality', () => {
    const cost = computeCostMicro({
      platform: 'openai',
      modelId: 'tts-1',
      inputTokens: 100,
      outputTokens: 0,
      modality: 'audio_tts',
    });
    expect(cost).toBe(40000);
  });

  it('uses per-call pricing for audio_stt modality', () => {
    const cost = computeCostMicro({
      platform: 'openai',
      modelId: 'whisper-1',
      inputTokens: 0,
      outputTokens: 0,
      modality: 'audio_stt',
    });
    expect(cost).toBe(40000);
  });

  it('returns 0 tokens → 0 cost for text', () => {
    const cost = computeCostMicro({
      platform: 'google',
      modelId: 'gemini-2.5-flash',
      inputTokens: 0,
      outputTokens: 0,
      modality: 'text',
    });
    expect(cost).toBe(0);
  });

  it('respects custom default_price_per_call setting', () => {
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('default_price_per_call', '0.02')").run();
    invalidatePriceCache();

    const cost = computeCostMicro({
      platform: 'any',
      modelId: 'any',
      inputTokens: 0,
      outputTokens: 0,
      modality: 'image_edit',
    });
    // 0.02 * 1_000_000 = 20000
    expect(cost).toBe(20000);

    // Restore
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('default_price_per_call', '0.04')").run();
  });
});
