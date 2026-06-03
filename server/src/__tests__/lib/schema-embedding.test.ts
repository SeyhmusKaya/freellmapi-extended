import { describe, it, expect } from 'vitest';
import { embeddingSchema } from '../../lib/runEmbedding.js';

describe('embeddingSchema', () => {
  it('accepts single string input', () => {
    const r = embeddingSchema.safeParse({ input: 'hello world' });
    expect(r.success).toBe(true);
  });

  it('accepts string-array batch input', () => {
    const r = embeddingSchema.safeParse({ input: ['a', 'b', 'c'] });
    expect(r.success).toBe(true);
  });

  it('rejects empty input array', () => {
    expect(embeddingSchema.safeParse({ input: [] }).success).toBe(false);
  });

  it('rejects empty string input', () => {
    expect(embeddingSchema.safeParse({ input: '' }).success).toBe(false);
  });

  it('rejects input > 8K chars per string', () => {
    expect(embeddingSchema.safeParse({ input: 'x'.repeat(8193) }).success).toBe(false);
  });

  it('rejects batch > 2048 inputs', () => {
    const big = Array(2049).fill('x');
    expect(embeddingSchema.safeParse({ input: big }).success).toBe(false);
  });

  it('accepts dimensions param in valid range', () => {
    expect(embeddingSchema.safeParse({ input: 'x', dimensions: 256 }).success).toBe(true);
    expect(embeddingSchema.safeParse({ input: 'x', dimensions: 4096 }).success).toBe(true);
  });

  it('rejects dimensions out of range', () => {
    expect(embeddingSchema.safeParse({ input: 'x', dimensions: 63 }).success).toBe(false);
    expect(embeddingSchema.safeParse({ input: 'x', dimensions: 4097 }).success).toBe(false);
  });

  it('accepts input_type for cohere', () => {
    expect(embeddingSchema.safeParse({ input: 'x', input_type: 'search_query' }).success).toBe(true);
    expect(embeddingSchema.safeParse({ input: 'x', input_type: 'invalid' as any }).success).toBe(false);
  });

  it('accepts encoding_format', () => {
    expect(embeddingSchema.safeParse({ input: 'x', encoding_format: 'float' }).success).toBe(true);
    expect(embeddingSchema.safeParse({ input: 'x', encoding_format: 'base64' }).success).toBe(true);
  });

  it('accepts optional model pin', () => {
    const r = embeddingSchema.safeParse({ input: 'x', model: '@cf/baai/bge-m3' });
    expect(r.success).toBe(true);
  });
});
