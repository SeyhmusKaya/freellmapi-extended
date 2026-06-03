import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../lib/redact.js';

describe('redactSecrets', () => {
  it('returns null/empty unchanged', () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeNull();
    expect(redactSecrets('')).toBe('');
  });

  it('keeps a normal provider error readable', () => {
    expect(redactSecrets('Groq API error 429: Too Many Requests')).toBe('Groq API error 429: Too Many Requests');
    expect(redactSecrets('model not found')).toBe('model not found');
  });

  it('redacts Bearer tokens', () => {
    // fake key-shaped fixture (never a real credential)
    const out = redactSecrets('401 Unauthorized: Bearer myllm-0000000000000000000000000000000000000000000000');
    expect(out).not.toContain('0000000000000000');
    expect(out).toContain('[redacted');
  });

  it('redacts key=... query params', () => {
    const out = redactSecrets('Google API error: GET https://x/v1?key=AIzaSyEXAMPLEEXAMPLEEXAMPLEEXAMPLE12345');
    expect(out).not.toContain('AIzaSyEXAMPLEEXAMPLEEXAMPLEEXAMPLE12345');
  });

  it('redacts our own unified key prefix', () => {
    const out = redactSecrets('auth failed for myllm-1111111111111111111111111111111111111111111111');
    expect(out).not.toContain('11111111111111');
    expect(out).toContain('[redacted');
  });

  it('redacts Cloudflare account:token pairs', () => {
    const out = redactSecrets('CF error 403: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6:tok_ABCDEFGHIJKLMNOPQRSTUV');
    expect(out).not.toContain(':tok_ABCDEFGHIJKLMNOPQRSTUV');
  });

  it('redacts email addresses', () => {
    expect(redactSecrets('account user@example.com over quota')).toContain('[redacted-email]');
  });

  it('caps very long messages', () => {
    const out = redactSecrets('x'.repeat(2000))!;
    expect(out.length).toBeLessThanOrEqual(501);
  });
});
