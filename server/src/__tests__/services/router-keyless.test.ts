import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { routeRequest } from '../../services/router.js';

describe('router keyless provider support', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM cooldowns').run();
    db.prepare('DELETE FROM usage_counters').run();
    // kilo is a keyless TEXT provider — it would satisfy the "no keys → throw"
    // case below. Disable it so these tests isolate the Pollinations image path.
    db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'kilo'").run();
  });

  it('routes to Pollinations image-gen w/o any api_keys row', () => {
    // No api_keys at all. Pollinations is requiresApiKey=false → router
    // should still find it for an image_gen request.
    const db = getDb();
    // Disable Cloudflare image-gen rows to force Pollinations selection
    db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'cloudflare' AND modality = 'image_gen'").run();

    const route = routeRequest(100, undefined, undefined, false, false, false, 'image_gen');
    expect(route.platform).toBe('pollinations');
    expect(route.keyId).toBe(0);
    expect(route.apiKey).toBe('');

    // Restore
    db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'cloudflare' AND modality = 'image_gen'").run();
  });

  it('keyless synthetic key only applies when provider.requiresApiKey=false', () => {
    // Groq requires a key. With no api_keys row, should NOT route to Groq.
    const db = getDb();
    db.prepare("UPDATE models SET enabled = 0 WHERE modality = 'image_gen'").run();

    expect(() => routeRequest(1000, undefined, undefined, false, false, true)).toThrowError();

    db.prepare("UPDATE models SET enabled = 1 WHERE modality = 'image_gen'").run();
  });

  it('Pollinations stays on chain for image_gen even when CF cascade has keys', () => {
    // With CF disabled, Pollinations becomes top-priority image-gen route.
    const db = getDb();
    db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'cloudflare' AND modality = 'image_gen'").run();
    const route = routeRequest(100, undefined, undefined, false, false, false, 'image_gen');
    expect(route.platform).toBe('pollinations');
    db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'cloudflare' AND modality = 'image_gen'").run();
  });
});
