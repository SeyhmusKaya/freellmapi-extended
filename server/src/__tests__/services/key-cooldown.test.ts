import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { setCooldown, setKeyCooldown, isOnCooldown, classifyError } from '../../services/ratelimit.js';

describe('classifyError — wider patterns', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('insufficient balance -> rate_limit_day (day-bucket lockout)', () => {
    expect(classifyError('DeepSeek API error 402: Insufficient Balance')).toBe('rate_limit_day');
  });

  it('out of credits -> rate_limit_day', () => {
    expect(classifyError('Out of credits! Subscribe now or fund your wallet')).toBe('rate_limit_day');
  });

  it('exceeded current quota (Google) -> rate_limit_day', () => {
    expect(classifyError('Google API error 429: You exceeded your current quota, please check your plan and billing details.')).toBe('rate_limit_day');
  });

  it('provider returned error (OpenRouter) -> rate_limit_minute', () => {
    expect(classifyError('OpenRouter API error 429: Provider returned error')).toBe('rate_limit_minute');
  });

  it('401 still maps to invalid_key (NOT rate_limit_day)', () => {
    expect(classifyError('401 Unauthorized')).toBe('invalid_key');
  });
});

describe('setKeyCooldown — wildcard model lock', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM cooldowns').run();
  });

  it('locks ALL models on a key when key-wide cooldown set', () => {
    setKeyCooldown('deepseek', 42, 'rate_limit_day');
    expect(isOnCooldown('deepseek', 'deepseek-chat',     42)).toBe(true);
    expect(isOnCooldown('deepseek', 'deepseek-reasoner', 42)).toBe(true);
    expect(isOnCooldown('deepseek', 'any-future-model',  42)).toBe(true);
  });

  it('does NOT affect other keys on the same platform', () => {
    setKeyCooldown('deepseek', 42, 'rate_limit_day');
    expect(isOnCooldown('deepseek', 'deepseek-chat', 99)).toBe(false);
  });

  it('does NOT affect the same key on a different platform', () => {
    setKeyCooldown('deepseek', 42, 'rate_limit_day');
    expect(isOnCooldown('groq', 'llama-3.3-70b', 42)).toBe(false);
  });

  it('model-specific cooldown does NOT spread to other models', () => {
    setCooldown('groq', 'llama-3.3-70b-versatile', 7, 'rate_limit_minute');
    expect(isOnCooldown('groq', 'llama-3.3-70b-versatile', 7)).toBe(true);
    expect(isOnCooldown('groq', 'openai/gpt-oss-120b',     7)).toBe(false);
  });

  it('key-wide cooldown + model-specific cooldown both honored', () => {
    setCooldown('groq', 'llama-3.3-70b-versatile', 7, 'rate_limit_minute');
    setKeyCooldown('groq', 7, 'invalid_key');
    // model-specific row exists AND key-wide row exists — still on cooldown
    expect(isOnCooldown('groq', 'llama-3.3-70b-versatile', 7)).toBe(true);
    expect(isOnCooldown('groq', 'openai/gpt-oss-120b',     7)).toBe(true);
  });
});
