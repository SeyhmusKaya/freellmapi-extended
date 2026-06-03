import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { logRequest, extractUpstreamStatus } from '../../lib/runChatCompletion.js';

describe('migrateRequestsV14Diagnostics', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('adds diagnostic columns to requests', () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info('requests')").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('error_class');
    expect(names).toContain('upstream_status');
    expect(names).toContain('attempts');
    expect(names).toContain('has_image');
    expect(names).toContain('response_format');
    expect(names).toContain('key_id');
    expect(names).toContain('request_id');
  });

  it('logRequest writes all diagnostic fields', () => {
    logRequest({
      platform: 'groq',
      modelId: 'llama-3.3-70b-versatile',
      status: 'error',
      inputTokens: 120,
      outputTokens: 0,
      latencyMs: 850,
      error: 'Groq API error 429: Too Many Requests',
      errorClass: 'rate_limit_minute',
      attempts: 3,
      hasImage: false,
      responseFormat: 'json_object',
      keyId: 42,
      requestId: 'req_test_001',
    });
    const row = getDb().prepare(`SELECT platform, model_id, status, error_class, upstream_status, attempts, has_image, response_format, key_id, request_id FROM requests WHERE request_id = 'req_test_001'`).get() as any;
    expect(row.platform).toBe('groq');
    expect(row.status).toBe('error');
    expect(row.error_class).toBe('rate_limit_minute');
    expect(row.upstream_status).toBe(429); // auto-extracted from message
    expect(row.attempts).toBe(3);
    expect(row.has_image).toBe(0);
    expect(row.response_format).toBe('json_object');
    expect(row.key_id).toBe(42);
  });

  it('extractUpstreamStatus parses 4xx/5xx from error text', () => {
    expect(extractUpstreamStatus('Groq API error 429: rate limited')).toBe(429);
    expect(extractUpstreamStatus('Cloudflare API error 502: bad gateway')).toBe(502);
    expect(extractUpstreamStatus('OpenRouter API error 404: not found')).toBe(404);
    expect(extractUpstreamStatus('timeout aborted')).toBe(null);
    expect(extractUpstreamStatus(null)).toBe(null);
  });

  it('success rows store has_image and response_format', () => {
    logRequest({
      platform: 'google',
      modelId: 'gemini-2.5-flash',
      status: 'success',
      inputTokens: 600,
      outputTokens: 30,
      latencyMs: 220,
      error: null,
      attempts: 0,
      hasImage: true,
      responseFormat: 'json_schema',
      keyId: 7,
      requestId: 'req_test_002',
    });
    const row = getDb().prepare(`SELECT has_image, response_format, error_class FROM requests WHERE request_id = 'req_test_002'`).get() as any;
    expect(row.has_image).toBe(1);
    expect(row.response_format).toBe('json_schema');
    expect(row.error_class).toBe(null);
  });
});
