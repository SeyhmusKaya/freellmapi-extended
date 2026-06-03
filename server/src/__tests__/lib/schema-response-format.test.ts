import { describe, it, expect, beforeAll } from 'vitest';
import { chatCompletionSchema, requiresJsonMode } from '../../lib/runChatCompletion.js';
import { initDb } from '../../db/index.js';

describe('response_format schema', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('accepts response_format text', () => {
    const r = chatCompletionSchema.safeParse({
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'text' },
    });
    expect(r.success).toBe(true);
  });

  it('accepts response_format json_object', () => {
    const r = chatCompletionSchema.safeParse({
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });
    expect(r.success).toBe(true);
  });

  it('accepts response_format json_schema with schema', () => {
    const r = chatCompletionSchema.safeParse({
      messages: [{ role: 'user', content: 'hi' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'City',
          schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          strict: true,
        },
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown response_format type', () => {
    const r = chatCompletionSchema.safeParse({
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'csv' } as any,
    });
    expect(r.success).toBe(false);
  });

  it('rejects json_schema without schema', () => {
    const r = chatCompletionSchema.safeParse({
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_schema', json_schema: { name: 'x' } } as any,
    });
    expect(r.success).toBe(false);
  });
});

describe('requiresJsonMode helper', () => {
  it('returns true for json_object', () => {
    expect(requiresJsonMode({ type: 'json_object' })).toBe(true);
  });
  it('returns true for json_schema', () => {
    expect(requiresJsonMode({ type: 'json_schema', json_schema: { schema: {} } })).toBe(true);
  });
  it('returns false for text', () => {
    expect(requiresJsonMode({ type: 'text' })).toBe(false);
  });
  it('returns false for undefined', () => {
    expect(requiresJsonMode(undefined)).toBe(false);
  });
});
