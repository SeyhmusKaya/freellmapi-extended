import { describe, it, expect, beforeAll, vi } from 'vitest';
import crypto from 'crypto';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { WebhookDispatcher } from '../../services/batchWebhook.js';
import { batchId as makeBatchId } from '../../lib/ulid.js';

async function tick(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe('WebhookDispatcher', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.MYLLM_BATCH_CALLBACK_ATTEMPTS = '3';
    initDb(':memory:');
    void getUnifiedApiKey();
  });

  function insertFinalizedBatch(opts: { callback_url: string; status?: string }): string {
    const db = getDb();
    const id = makeBatchId();
    db.prepare(`
      INSERT INTO batches (id, status, total, completed, failed, priority, callback_url, finished_at)
      VALUES (?, ?, 1, 1, 0, 2, ?, datetime('now'))
    `).run(id, opts.status ?? 'completed', opts.callback_url);
    return id;
  }

  it('delivers HMAC-signed payload on first success', async () => {
    let received: { body: any; sig: string } | null = null;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init: any) => {
      received = { body: JSON.parse(init.body as string), sig: init.headers['X-MyLLM-Signature'] };
      return new Response('ok', { status: 200 });
    });

    const id = insertFinalizedBatch({ callback_url: 'https://example.com/hook' });
    const w = new WebhookDispatcher();
    w.start();
    for (let i = 0; i < 30; i++) {
      const row = getDb().prepare('SELECT callback_status FROM batches WHERE id=?').get(id) as any;
      if (row?.callback_status === 'sent') break;
      await tick(100);
    }
    w.stop();
    spy.mockRestore();

    expect(received).not.toBeNull();
    expect(received!.body.id).toBe(id);
    expect(received!.body.status).toBe('completed');
    expect(received!.sig).toMatch(/^sha256=[a-f0-9]{64}$/);

    // Verify HMAC matches
    const expected = 'sha256=' + crypto.createHmac('sha256', getUnifiedApiKey()).update(JSON.stringify(received!.body)).digest('hex');
    expect(received!.sig).toBe(expected);

    const final = getDb().prepare('SELECT callback_status, callback_attempts FROM batches WHERE id=?').get(id) as any;
    expect(final.callback_status).toBe('sent');
    expect(final.callback_attempts).toBe(1);
  });

  it('marks failed after MAX_ATTEMPTS server errors', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status: 500 }));

    const id = insertFinalizedBatch({ callback_url: 'https://example.com/down' });
    const w = new WebhookDispatcher();
    w.start();
    // 3 attempts: 0s + 5s + 30s — speed up by waiting only loop polls; this is
    // a coarse test so we accept the timing and use shorter delays via mock.
    // Wait up to 60s for failure.
    for (let i = 0; i < 600; i++) {
      const row = getDb().prepare('SELECT callback_status, callback_attempts FROM batches WHERE id=?').get(id) as any;
      if (row?.callback_status === 'failed') break;
      await tick(100);
    }
    w.stop();
    spy.mockRestore();

    const final = getDb().prepare('SELECT callback_status, callback_attempts FROM batches WHERE id=?').get(id) as any;
    expect(final.callback_status).toBe('failed');
    expect(final.callback_attempts).toBe(3);
  }, 120_000);
});
