import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

describe('migrateModelsV18Img2Img', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('adds supports_img2img + supports_inpainting columns', () => {
    const cols = getDb().prepare("PRAGMA table_info('models')").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('supports_img2img');
    expect(names).toContain('supports_inpainting');
  });

  // V25 (May 2026): CF retired img2img across all SD models. Inpainting still
  // works on SD-1.5-inpainting. Old V18 behaviour overridden by V25.
  it('SD-1.5-inpainting: inpainting only (V25 deprecated img2img)', () => {
    const row = getDb().prepare(
      "SELECT supports_img2img, supports_inpainting FROM models WHERE platform='cloudflare' AND model_id='@cf/runwayml/stable-diffusion-v1-5-inpainting'"
    ).get() as { supports_img2img: number; supports_inpainting: number };
    expect(row.supports_img2img).toBe(0);
    expect(row.supports_inpainting).toBe(1);
  });

  it('dreamshaper: img2img deprecated (V25)', () => {
    const row = getDb().prepare(
      "SELECT supports_img2img, supports_inpainting FROM models WHERE platform='cloudflare' AND model_id='@cf/lykon/dreamshaper-8-lcm'"
    ).get() as { supports_img2img: number; supports_inpainting: number };
    expect(row.supports_img2img).toBe(0);
    expect(row.supports_inpainting).toBe(0);
  });

  it('SDXL base: img2img deprecated (V25)', () => {
    const row = getDb().prepare(
      "SELECT supports_img2img, supports_inpainting FROM models WHERE platform='cloudflare' AND model_id='@cf/stabilityai/stable-diffusion-xl-base-1.0'"
    ).get() as { supports_img2img: number; supports_inpainting: number };
    expect(row.supports_img2img).toBe(0);
    expect(row.supports_inpainting).toBe(0);
  });

  it('FLUX schnell stays text-to-image only', () => {
    const row = getDb().prepare(
      "SELECT supports_img2img, supports_inpainting FROM models WHERE platform='cloudflare' AND model_id='@cf/black-forest-labs/flux-1-schnell'"
    ).get() as { supports_img2img: number; supports_inpainting: number };
    expect(row.supports_img2img).toBe(0);
    expect(row.supports_inpainting).toBe(0);
  });

  // V27 (May 2026): Pollinations flux row enabled for img2img after CF
  // retired img2img across all SD models. Other Pollinations variants stay
  // T2I only. Inpainting still requires a mask + CF SD-1.5-inpainting.
  it('Pollinations flux: img2img enabled (V27); others stay T2I only', () => {
    const rows = getDb().prepare(
      "SELECT model_id, supports_img2img, supports_inpainting FROM models WHERE platform='pollinations'"
    ).all() as Array<{ model_id: string; supports_img2img: number; supports_inpainting: number }>;
    for (const r of rows) {
      const expectImg2Img = r.model_id === 'pollinations/flux' ? 1 : 0;
      expect(r.supports_img2img).toBe(expectImg2Img);
      expect(r.supports_inpainting).toBe(0);
    }
  });
});
