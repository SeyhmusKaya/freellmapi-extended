import { getDb } from '../db/index.js';
import { runChatCompletion, isRetryableError, ChatCompletionRequest } from '../lib/runChatCompletion.js';
import { runEmbedding, type EmbeddingRequest } from '../lib/runEmbedding.js';

const POLL_IDLE_MS = 500;
const POLL_BUSY_MS = 100;
const STALE_INFLIGHT_MS = 10 * 60 * 1000;   // 10 min → assume worker died
const STALE_REAP_INTERVAL_MS = 60 * 1000;   // reap every minute
const MAX_ITEM_ATTEMPTS = Number(process.env.MYLLM_BATCH_MAX_ATTEMPTS ?? 3);

interface PendingItem {
  id: number;
  batch_id: string;
  position: number;
  request_body: string;
  attempt: number;
  endpoint?: string;   // V31: '/v1/chat/completions' (default) or '/v1/embeddings'
}

/**
 * Single in-process batch worker. Picks pending batch_items by priority DESC,
 * created_at ASC, position ASC and runs them through runChatCompletion. Default
 * concurrency 4 (env: MYLLM_BATCH_CONCURRENCY). Restart-safe — migrateBatches()
 * resets 'inflight' rows to 'pending' on boot, and the in-loop reaper handles
 * the rare case where a worker dies mid-process without restart.
 *
 * Retry policy: retryable provider errors push the item back to 'pending' up to
 * MAX_ITEM_ATTEMPTS times (default 3). Non-retryable errors mark 'error' on
 * first hit.
 */
export class BatchWorker {
  private running = false;
  private concurrency: number;
  private inflight = new Set<number>();
  private lastReapAt = 0;

  constructor() {
    this.concurrency = Math.max(1, Number(process.env.MYLLM_BATCH_CONCURRENCY ?? 4));
  }

  start() {
    if (this.running) return;
    this.running = true;
    console.log(`[BatchWorker] starting (concurrency=${this.concurrency}, maxAttempts=${MAX_ITEM_ATTEMPTS})`);
    this.loop().catch(err => console.error('[BatchWorker] loop crashed:', err));
  }

  stop() {
    this.running = false;
  }

  private async loop() {
    while (this.running) {
      this.reapStaleInflight();

      if (this.inflight.size >= this.concurrency) {
        await sleep(POLL_BUSY_MS);
        continue;
      }
      const item = this.pickNextItem();
      if (!item) {
        await sleep(POLL_IDLE_MS);
        continue;
      }
      this.processItem(item).catch(err => console.error('[BatchWorker] processItem error:', err));
    }
  }

  private reapStaleInflight() {
    const now = Date.now();
    if (now - this.lastReapAt < STALE_REAP_INTERVAL_MS) return;
    this.lastReapAt = now;
    const db = getDb();
    const result = db.prepare(`
      UPDATE batch_items
         SET status='pending'
       WHERE status='inflight'
         AND processed_at IS NULL
         AND id NOT IN (${[...this.inflight].length ? [...this.inflight].join(',') : '0'})
    `).run();
    if (result.changes > 0) {
      console.log(`[BatchWorker] reaped ${result.changes} stale inflight items`);
    }
  }

  private pickNextItem(): PendingItem | null {
    const db = getDb();

    const item = db.prepare(`
      SELECT bi.id, bi.batch_id, bi.position, bi.request_body, bi.attempt, bi.endpoint
      FROM batch_items bi
      JOIN batches b ON b.id = bi.batch_id
      WHERE bi.status = 'pending' AND b.status IN ('queued','processing')
      ORDER BY b.priority DESC, b.created_at ASC, bi.position ASC
      LIMIT 1
    `).get() as PendingItem | undefined;

    if (!item) return null;
    if (this.inflight.has(item.id)) return null;

    const tx = db.transaction(() => {
      const upd = db.prepare(`
        UPDATE batch_items
           SET status='inflight', attempt=attempt+1
         WHERE id=? AND status='pending'
      `).run(item.id);
      if (upd.changes === 0) return false;
      db.prepare(`
        UPDATE batches
           SET status='processing',
               started_at = COALESCE(started_at, datetime('now'))
         WHERE id=? AND status='queued'
      `).run(item.batch_id);
      return true;
    });

    if (!tx()) return null;
    item.attempt += 1;
    return item;
  }

  private async processItem(item: PendingItem) {
    this.inflight.add(item.id);
    const db = getDb();
    const start = Date.now();
    try {
      const body = JSON.parse(item.request_body) as any;
      const endpoint = item.endpoint ?? '/v1/chat/completions';

      let responseBody: any;
      let routedPlatform: string;
      let routedModel: string;

      if (endpoint === '/v1/embeddings') {
        // Embedding path — runEmbedding returns vectors; shape into the
        // OpenAI /v1/embeddings response so JSONL consumers can drop it
        // straight into their existing pipelines.
        const r = await runEmbedding(body as EmbeddingRequest);
        responseBody = {
          object: 'list',
          data: r.vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
          model: r.routedModel,
          usage: { prompt_tokens: r.promptTokens, total_tokens: r.promptTokens },
        };
        routedPlatform = r.routedPlatform;
        routedModel = r.routedModel;
      } else {
        body.stream = false;
        const result = await runChatCompletion(body as ChatCompletionRequest);
        responseBody = result.response;
        routedPlatform = result.routedPlatform;
        routedModel = result.routedModel;
      }

      const dt = Date.now() - start;
      db.prepare(`
        UPDATE batch_items
           SET status='done',
               response_body=?,
               routed_platform=?,
               routed_model=?,
               latency_ms=?,
               processed_at=datetime('now')
         WHERE id=?
      `).run(JSON.stringify(responseBody), routedPlatform, routedModel, dt, item.id);
      this.bumpCounters(item.batch_id, 1, 0);
    } catch (err: any) {
      const dt = Date.now() - start;
      const retryable = isRetryableError(err);
      const exhausted = item.attempt >= MAX_ITEM_ATTEMPTS;

      if (retryable && !exhausted) {
        // Bounce back to pending so the worker picks it up later. attempt was
        // already incremented in pickNextItem; we just clear inflight state.
        db.prepare(`
          UPDATE batch_items
             SET status='pending',
                 error_message=?,
                 latency_ms=?
           WHERE id=?
        `).run(err?.message ?? 'unknown error', dt, item.id);
        console.log(`[BatchWorker] item ${item.id} retryable err, requeue (attempt ${item.attempt}/${MAX_ITEM_ATTEMPTS})`);
      } else {
        db.prepare(`
          UPDATE batch_items
             SET status='error',
                 error_message=?,
                 latency_ms=?,
                 processed_at=datetime('now')
           WHERE id=?
        `).run(err?.message ?? 'unknown error', dt, item.id);
        this.bumpCounters(item.batch_id, 0, 1);
      }
    } finally {
      this.inflight.delete(item.id);
      this.maybeFinalize(item.batch_id);
    }
  }

  private bumpCounters(batchId: string, addCompleted: number, addFailed: number) {
    const db = getDb();
    db.prepare(`
      UPDATE batches
         SET completed = completed + ?,
             failed = failed + ?
       WHERE id = ?
    `).run(addCompleted, addFailed, batchId);
  }

  private maybeFinalize(batchId: string) {
    const db = getDb();
    const row = db.prepare(`SELECT total, completed, failed, status FROM batches WHERE id=?`).get(batchId) as { total: number; completed: number; failed: number; status: string } | undefined;
    if (!row) return;
    if (row.status === 'cancelled') return;
    if (row.completed + row.failed >= row.total) {
      db.prepare(`UPDATE batches SET status='completed', finished_at=datetime('now') WHERE id=? AND status='processing'`).run(batchId);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let singleton: BatchWorker | null = null;
export function getBatchWorker(): BatchWorker {
  if (!singleton) singleton = new BatchWorker();
  return singleton;
}
