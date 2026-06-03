import { describe, it, expect, beforeAll } from 'vitest';
import { chatCompletionSchema, isMultimodal, countImageParts, normalizeMessages, estimateMessageTokens } from '../../lib/runChatCompletion.js';
import { initDb } from '../../db/index.js';

describe('vision schema', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('accepts string content for user', () => {
    const r = chatCompletionSchema.safeParse({
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts array content with text+image_url data URL', () => {
    const r = chatCompletionSchema.safeParse({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAA' } },
        ],
      }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts http(s) image_url', () => {
    const r = chatCompletionSchema.safeParse({
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.jpg' } }],
      }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty content array', () => {
    const r = chatCompletionSchema.safeParse({
      messages: [{ role: 'user', content: [] }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects unsupported image_url scheme', () => {
    const r = chatCompletionSchema.safeParse({
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }],
      }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects array content on system role', () => {
    const r = chatCompletionSchema.safeParse({
      messages: [{ role: 'system', content: [{ type: 'text', text: 'x' }] as any }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects array content on assistant role', () => {
    const r = chatCompletionSchema.safeParse({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] as any }],
    });
    expect(r.success).toBe(false);
  });

  it('accepts detail field on image_url', () => {
    const r = chatCompletionSchema.safeParse({
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'https://example.com/x.jpg', detail: 'high' } },
        ],
      }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown detail value', () => {
    const r = chatCompletionSchema.safeParse({
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.jpg', detail: 'ultra' } as any }],
      }],
    });
    expect(r.success).toBe(false);
  });
});

describe('isMultimodal / countImageParts', () => {
  it('detects image_url in array content', () => {
    const msgs = normalizeMessages([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
    ]);
    expect(isMultimodal(msgs)).toBe(true);
    expect(countImageParts(msgs)).toBe(1);
  });

  it('string content not multimodal', () => {
    const msgs = normalizeMessages([{ role: 'user', content: 'hi' }]);
    expect(isMultimodal(msgs)).toBe(false);
    expect(countImageParts(msgs)).toBe(0);
  });

  it('counts multiple images across messages', () => {
    const msgs = normalizeMessages([
      { role: 'user', content: [
        { type: 'text', text: 'a' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,X' } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,Y' } },
      ]},
    ]);
    expect(countImageParts(msgs)).toBe(2);
    expect(isMultimodal(msgs)).toBe(true);
  });
});

describe('estimateMessageTokens', () => {
  it('estimates text + image with detail levels', () => {
    const msgs = normalizeMessages([
      { role: 'user', content: [
        { type: 'text', text: 'a'.repeat(40) },                                  // ~10 tokens
        { type: 'image_url', image_url: { url: 'data:image/png;base64,X', detail: 'low' } },  // 100
        { type: 'image_url', image_url: { url: 'data:image/png;base64,Y', detail: 'high' } }, // 800
        { type: 'image_url', image_url: { url: 'data:image/png;base64,Z' } },                 // auto → 500
      ]},
    ]);
    const n = estimateMessageTokens(msgs);
    // text 10 + 100 + 800 + 500 = 1410
    expect(n).toBeGreaterThanOrEqual(1400);
    expect(n).toBeLessThanOrEqual(1420);
  });
});
