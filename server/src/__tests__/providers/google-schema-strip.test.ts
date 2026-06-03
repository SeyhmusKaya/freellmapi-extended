import { describe, it, expect } from 'vitest';
import { stripGeminiSchema } from '../../providers/google.js';

describe('stripGeminiSchema', () => {
  it('removes keys Gemini responseSchema rejects, recursively', () => {
    const input = {
      type: 'object',
      additionalProperties: false,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        kind: { allOf: [{ type: 'string' }], const: 'x' },
        nested: {
          type: 'object',
          additionalProperties: false,
          properties: { n: { type: 'number', multipleOf: 2 } },
        },
      },
      required: ['tags'],
    };
    const out = stripGeminiSchema(input) as any;

    expect(out.additionalProperties).toBeUndefined();
    expect(out.$schema).toBeUndefined();
    expect(out.properties.tags.uniqueItems).toBeUndefined();
    expect(out.properties.kind.allOf).toBeUndefined();
    expect(out.properties.kind.const).toBeUndefined();
    expect(out.properties.nested.additionalProperties).toBeUndefined();
    expect(out.properties.nested.properties.n.multipleOf).toBeUndefined();

    // keeps the supported structure intact
    expect(out.type).toBe('object');
    expect(out.required).toEqual(['tags']);
    expect(out.properties.tags.items.type).toBe('string');
    expect(out.properties.nested.properties.n.type).toBe('number');
  });

  it('does not mutate the input object', () => {
    const input = { type: 'object', additionalProperties: false };
    stripGeminiSchema(input);
    expect((input as any).additionalProperties).toBe(false);
  });

  it('passes through primitives and arrays', () => {
    expect(stripGeminiSchema('x')).toBe('x');
    expect(stripGeminiSchema(5)).toBe(5);
    expect(stripGeminiSchema([{ const: 1, type: 'integer' }])).toEqual([{ type: 'integer' }]);
  });
});
