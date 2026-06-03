import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { BatchWorker } from '../../services/batchWorker.js';
import * as runner from '../../lib/runChatCompletion.js';
import { batchId as makeBatchId } from '../../lib/ulid.js';

async function tick(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe('BatchWorker', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.MYLLM_BATCH_CONCURRENCY = '2';
    process.env.MYLLM_BATCH_MAX_ATTEMPTS = '3';
    initDb(':memory:');
    void getUnifiedApiKey(); // ensure key exists
  });

  afterAll(() => {
    delete process.env.MYLLM_BATCH_CONCURRENCY;
    delete process.env.MYLLM_BATCH_MAX_ATTEMPTS;
  });

  function insertBatch(total: number, bodies: any[]): string {
    const db = getDb();
    const id = makeBatchId();
    db.prepare(`INSERT INTO batches (id, status, total, priority) VALUES (?, 'queued', ?, 2)`).run(id, total);
    const ins = db.prepare(`INSERT INTO batch_items (batch_id, position, custom_id, request_body) VALUES (?, ?, ?, ?)`);
    for (let i = 0; i < bodies.length; i++) {
      ins.run(id, i, `c${i}`, JSON.stringify(bodies[i]));
    }
    return id;
  }

  it('processes all items and marks batch completed', async () => {
    const spy = vi.spyOn(runner, 'runChatCompletion').mockImplementation(async () => ({
      response: { id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } as any,
      routedPlatform: 'groq',
      routedModel: 'llama-3.3-70b-versatile',
      routedDisplayName: 'Llama',
      attempts: 0,
      latencyMs: 5,
    }));
    const w = new BatchWorker();
    const id = insertBatch(3, [
      { messages: [{ role: 'user', content: 'a' }] },
      { messages: [{ role: 'user', content: 'b' }] },
      { messages: [{ role: 'user', content: 'c' }] },
    ]);
    w.start();
    // Wait for completion (poll up to 5s)
    for (let i = 0; i < 50; i++) {
      const row = getDb().prepare('SELECT status, completed, failed FROM batches WHERE id=?').get(id) as any;
      if (row?.status === 'completed') break;
      await tick(100);
    }
    w.stop();
    spy.mockRestore();
    const final = getDb().prepare('SELECT status, completed, failed FROM batches WHERE id=?').get(id) as any;
    expect(final.status).toBe('completed');
    expect(final.completed).toBe(3);
    expect(final.failed).toBe(0);
  });

  it('retries retryable errors up to MAX_ATTEMPTS then marks error', async () => {
    let calls = 0;
    const spy = vi.spyOn(runner, 'runChatCompletion').mockImplementation(async () => {
      calls++;
      throw new Error('429 Too many requests per minute');
    });
    const w = new BatchWorker();
    const id = insertBatch(1, [{ messages: [{ role: 'user', content: 'x' }] }]);
    w.start();
    for (let i = 0; i < 80; i++) {
      const row = getDb().prepare('SELECT status FROM batches WHERE id=?').get(id) as any;
      if (row?.status === 'completed') break;
      await tick(100);
    }
    w.stop();
    spy.mockRestore();

    const itemRow = getDb().prepare('SELECT status, attempt FROM batch_items WHERE batch_id=?').get(id) as any;
    expect(itemRow.status).toBe('error');
    expect(itemRow.attempt).toBe(3);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('non-retryable error fails on first attempt', async () => {
    const spy = vi.spyOn(runner, 'runChatCompletion').mockImplementation(async () => {
      throw new Error('Invalid request: missing field');
    });
    const w = new BatchWorker();
    const id = insertBatch(1, [{ messages: [{ role: 'user', content: 'x' }] }]);
    w.start();
    for (let i = 0; i < 30; i++) {
      const row = getDb().prepare('SELECT status FROM batches WHERE id=?').get(id) as any;
      if (row?.status === 'completed') break;
      await tick(100);
    }
    w.stop();
    spy.mockRestore();

    const itemRow = getDb().prepare('SELECT status, attempt FROM batch_items WHERE batch_id=?').get(id) as any;
    expect(itemRow.status).toBe('error');
    expect(itemRow.attempt).toBe(1);
  });
});
