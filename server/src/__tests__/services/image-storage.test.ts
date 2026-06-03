import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { initDb, getDb } from '../../db/index.js';
import { storeImage, verifySignedRequest, getImageFile, signId } from '../../services/imageStorage.js';

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('imageStorage', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.MYLLM_PUBLIC_URL = 'https://example.test';
    initDb(':memory:');
  });

  afterAll(() => {
    // best-effort cleanup
    const dir = path.resolve(import.meta.dirname ?? __dirname, '../../../data/images');
    if (fs.existsSync(dir)) {
      try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.png') || f.endsWith('.jpg')) fs.unlinkSync(path.join(dir, f)); } catch { /* */ }
    }
  });

  it('writes file to disk and returns signed URL', () => {
    const stored = storeImage(TINY_PNG_B64, 'image/png', { platform: 'cloudflare', modelId: '@cf/flux' });
    expect(stored.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(stored.url.startsWith('https://example.test/v1/images/files/')).toBe(true);
    expect(stored.url).toContain('exp=');
    expect(stored.url).toContain('sig=');
    expect(stored.url).toContain(`${stored.id}.png`);

    const row = getImageFile(stored.id);
    expect(row).not.toBeNull();
    expect(row!.mime_type).toBe('image/png');
    expect(row!.byte_size).toBeGreaterThan(0);
    expect(fs.existsSync(row!.file_path)).toBe(true);
  });

  it('verifySignedRequest accepts a fresh signature', () => {
    const stored = storeImage(TINY_PNG_B64, 'image/png', {});
    const url = new URL(stored.url);
    const exp = url.searchParams.get('exp')!;
    const sig = url.searchParams.get('sig')!;
    const idWithExt = url.pathname.split('/').pop()!;

    const r = verifySignedRequest(idWithExt, exp, sig);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toBe(stored.id);
  });

  it('verifySignedRequest rejects tampered signature', () => {
    const stored = storeImage(TINY_PNG_B64, 'image/png', {});
    const url = new URL(stored.url);
    const exp = url.searchParams.get('exp')!;
    const idWithExt = url.pathname.split('/').pop()!;
    const r = verifySignedRequest(idWithExt, exp, 'deadbeef'.repeat(8));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('verifySignedRequest rejects expired exp', () => {
    const stored = storeImage(TINY_PNG_B64, 'image/png', {});
    const url = new URL(stored.url);
    const idWithExt = url.pathname.split('/').pop()!;
    const pastExp = String(Math.floor(Date.now() / 1000) - 60);
    const sig = signId(stored.id, Number(pastExp));
    const r = verifySignedRequest(idWithExt, pastExp, sig);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(410);
  });

  it('verifySignedRequest rejects mangled id', () => {
    const r = verifySignedRequest('not-a-ulid.png', '1234', 'abc');
    expect(r.ok).toBe(false);
  });

  it('verifySignedRequest rejects missing parts', () => {
    expect(verifySignedRequest('xxxxxxxxxxxxxxxxxxxxxxxxxx.png', undefined, 'sig').ok).toBe(false);
    expect(verifySignedRequest('xxxxxxxxxxxxxxxxxxxxxxxxxx.png', '1234', undefined).ok).toBe(false);
  });
});
