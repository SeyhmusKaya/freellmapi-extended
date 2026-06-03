import { describe, it, expect, beforeAll } from 'vitest';
import { classifyError, setCooldown, isOnCooldown, getCooldownDetail } from '../../services/ratelimit.js';
import { initDb } from '../../db/index.js';

describe('classifyError', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('classifies per-day quota errors as rate_limit_day', () => {
    expect(classifyError('Quota exceeded for free_tier_requests per day, limit 20')).toBe('rate_limit_day');
    expect(classifyError('429 Tokens per day exceeded')).toBe('rate_limit_day');
    expect(classifyError('resource_exhausted')).toBe('rate_limit_day');
    expect(classifyError('RPD limit reached')).toBe('rate_limit_day');
  });

  it('classifies minute bursts as rate_limit_minute', () => {
    expect(classifyError('429 Too many requests per minute')).toBe('rate_limit_minute');
    expect(classifyError('Rate limit hit: RPM')).toBe('rate_limit_minute');
  });

  it('classifies invalid key errors', () => {
    expect(classifyError('401 Unauthorized')).toBe('invalid_key');
    expect(classifyError('Invalid API key')).toBe('invalid_key');
    expect(classifyError('403 Forbidden')).toBe('invalid_key');
  });

  it('falls back to rate_limit_unknown for vague errors', () => {
    expect(classifyError('something weird happened')).toBe('rate_limit_unknown');
    expect(classifyError('')).toBe('rate_limit_unknown');
  });

  it('classifies dead routes as model_gone (V57)', () => {
    expect(classifyError('OpenRouter API error 404: No endpoints found for minimax/minimax-m2.5:free.')).toBe('model_gone');
    expect(classifyError('Cerebras API error 404: Not Found')).toBe('model_gone');
    expect(classifyError('This model has been decommissioned')).toBe('model_gone');
    expect(classifyError('model_not_found')).toBe('model_gone');
  });

  it('does not mistake a daily-quota 404-free message for model_gone', () => {
    // "per day" wins → day bucket, even though phrasing is unusual
    expect(classifyError('Quota exceeded: requests per day')).toBe('rate_limit_day');
    // invalid key still wins over a stray 404 in an auth message
    expect(classifyError('401 Unauthorized: not found in account')).toBe('invalid_key');
  });
});

describe('adaptive cooldown', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('day-limit cooldown lasts until next UTC midnight', () => {
    setCooldown('groq', 'm-day', 9001, 'rate_limit_day');
    expect(isOnCooldown('groq', 'm-day', 9001)).toBe(true);
    const detail = getCooldownDetail('groq', 'm-day', 9001);
    expect(detail).not.toBeNull();
    expect(detail!.reason).toBe('rate_limit_day');
    const expiryMs = new Date(detail!.expiresAt.replace(' ', 'T') + 'Z').getTime();
    const diffHours = (expiryMs - Date.now()) / 3600_000;
    // Always between 0 (just before midnight) and 24h (just after midnight)
    expect(diffHours).toBeGreaterThan(-0.01);
    expect(diffHours).toBeLessThan(24.01);
  });

  it('invalid_key cooldown is ~1 hour', () => {
    setCooldown('groq', 'm-invalid', 9002, 'invalid_key');
    const detail = getCooldownDetail('groq', 'm-invalid', 9002);
    const expiryMs = new Date(detail!.expiresAt.replace(' ', 'T') + 'Z').getTime();
    const diffMin = (expiryMs - Date.now()) / 60_000;
    expect(diffMin).toBeGreaterThan(55);
    expect(diffMin).toBeLessThan(65);
  });

  // V26 (May 2026): minute cooldown bumped 60s -> 180s to absorb continuous
  // OpenRouter 429 windows that span the older 60s slot.
  it('minute cooldown is ~3min (V26)', () => {
    setCooldown('groq', 'm-min', 9003, 'rate_limit_minute');
    const detail = getCooldownDetail('groq', 'm-min', 9003);
    const expiryMs = new Date(detail!.expiresAt.replace(' ', 'T') + 'Z').getTime();
    const diffSec = (expiryMs - Date.now()) / 1000;
    expect(diffSec).toBeGreaterThan(170);
    expect(diffSec).toBeLessThan(190);
  });

  it('model_gone cooldown is ~6 hours (V57)', () => {
    setCooldown('openrouter', 'minimax/minimax-m2.5:free', 9004, 'model_gone');
    const detail = getCooldownDetail('openrouter', 'minimax/minimax-m2.5:free', 9004);
    const expiryMs = new Date(detail!.expiresAt.replace(' ', 'T') + 'Z').getTime();
    const diffHours = (expiryMs - Date.now()) / 3600_000;
    expect(diffHours).toBeGreaterThan(5.9);
    expect(diffHours).toBeLessThan(6.1);
  });

  it('cooldown persists in DB and survives a re-read', () => {
    setCooldown('cerebras', 'qwen3-235b', 7777, 'rate_limit_day');
    expect(isOnCooldown('cerebras', 'qwen3-235b', 7777)).toBe(true);
  });

  it('daily counter persists across recordRequest', async () => {
    const { recordRequest, canMakeRequest } = await import('../../services/ratelimit.js');
    const limits = { rpm: null, rpd: 2, tpm: null, tpd: null };
    const keyId = 9100 + Math.floor(Math.random() * 1000);
    recordRequest('zhipu', 'glm', keyId);
    recordRequest('zhipu', 'glm', keyId);
    expect(canMakeRequest('zhipu', 'glm', keyId, limits)).toBe(false);
  });
});
