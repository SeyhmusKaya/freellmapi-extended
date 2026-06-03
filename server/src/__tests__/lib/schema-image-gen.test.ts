import { describe, it, expect } from 'vitest';
import { imageGenerationSchema } from '../../lib/runImageGeneration.js';

describe('imageGenerationSchema', () => {
  it('accepts minimal prompt', () => {
    expect(imageGenerationSchema.safeParse({ prompt: 'a cat' }).success).toBe(true);
  });

  it('rejects empty prompt', () => {
    expect(imageGenerationSchema.safeParse({ prompt: '' }).success).toBe(false);
  });

  it('rejects prompt > 4000 chars', () => {
    expect(imageGenerationSchema.safeParse({ prompt: 'a'.repeat(4001) }).success).toBe(false);
  });

  it('accepts full payload', () => {
    const r = imageGenerationSchema.safeParse({
      prompt: 'kawaii cat',
      model: 'flux-1-schnell',
      n: 2,
      size: '1024x1024',
      response_format: 'b64_json',
      negative_prompt: 'blurry',
      seed: 42,
      quality: 'standard',
    });
    expect(r.success).toBe(true);
  });

  it('rejects n out of range', () => {
    expect(imageGenerationSchema.safeParse({ prompt: 'x', n: 0 }).success).toBe(false);
    expect(imageGenerationSchema.safeParse({ prompt: 'x', n: 5 }).success).toBe(false);
  });

  it('rejects invalid size', () => {
    expect(imageGenerationSchema.safeParse({ prompt: 'x', size: '2048x2048' as any }).success).toBe(false);
  });

  it('rejects invalid response_format', () => {
    expect(imageGenerationSchema.safeParse({ prompt: 'x', response_format: 'webp' as any }).success).toBe(false);
  });

  it('accepts response_format=url at schema level (rejected at endpoint)', () => {
    expect(imageGenerationSchema.safeParse({ prompt: 'x', response_format: 'url' }).success).toBe(true);
  });
});
